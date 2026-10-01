import type { ReviewVerdict } from './review-loop-types'

export const REVIEW_VERDICT_MARKER = 'GPT_REVIEW_V1'
export const REVIEW_REQUEST_MARKER = 'GPT_REVIEW_REQUEST_V1'
/** Hidden marker on comments the loop itself posts; such comments are never read as verdicts. */
export const REVIEW_REQUEST_HTML_MARKER = '<!-- orca-review-loop:request'

const FULL_SHA = /^[0-9a-f]{40}$/
const RUN_ID = /^[A-Za-z0-9._-]{1,100}$/
const KEY_LINE = /^[*_`\s]*([a-z_]+)[*_`\s]*:(.*)$/
const BULLET_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const EMPTY_FINDING = /^(?:none|n\/a|nothing|なし|無し)\.?$/i
const KNOWN_KEYS = new Set([
  'run_id',
  'head_sha',
  'verdict',
  'blocking_findings',
  'non_blocking_findings',
  'final'
])

export type ParsedReviewVerdict = {
  run_id: string
  head_sha: string
  verdict: ReviewVerdict
  blocking_findings: string[]
  non_blocking_findings: string[]
}

export type ReviewContractParse =
  | { kind: 'absent' }
  | { kind: 'valid'; review: ParsedReviewVerdict }
  /** `run_id` is reported when readable so a broken verdict can still be routed to its run. */
  | { kind: 'malformed'; run_id: string | null; head_sha: string | null; errors: string[] }

export function isLoopRequestComment(body: string): boolean {
  return body.includes(REVIEW_REQUEST_HTML_MARKER)
}

/**
 * Parses the structured verdict block. Free text is never a verdict: only a block that starts
 * with a line reading exactly `GPT_REVIEW_V1` and passes every consistency rule is `valid`.
 */
export function parseReviewContract(body: string): ReviewContractParse {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const starts = lines.flatMap((line, index) =>
    stripDecoration(line) === REVIEW_VERDICT_MARKER ? [index] : []
  )
  if (starts.length === 0) {
    return { kind: 'absent' }
  }
  const fields = readBlock(lines, starts[0] + 1)
  const errors = [...fields.errors]
  if (starts.length > 1) {
    errors.push(`expected one ${REVIEW_VERDICT_MARKER} block, found ${starts.length}`)
  }
  const runId = fields.scalars.get('run_id') ?? null
  const headSha = fields.scalars.get('head_sha')?.toLowerCase() ?? null
  if (!runId || !RUN_ID.test(runId)) {
    errors.push('run_id is missing or invalid')
  }
  if (!headSha || !FULL_SHA.test(headSha)) {
    errors.push('head_sha must be the full 40-character commit SHA')
  }
  const verdict = parseVerdictToken(fields.scalars.get('verdict'))
  const final = parseVerdictToken(fields.scalars.get('final'))
  if (!verdict) {
    errors.push('verdict must be exactly PASS or NEEDS_FIX')
  }
  if (!final) {
    errors.push('final must be exactly PASS or NEEDS_FIX')
  }
  if (verdict && final && verdict !== final) {
    errors.push(`verdict (${verdict}) and final (${final}) disagree`)
  }
  const blocking = fields.lists.get('blocking_findings')
  const nonBlocking = fields.lists.get('non_blocking_findings')
  if (!blocking) {
    errors.push('blocking_findings section is missing')
  }
  if (!nonBlocking) {
    errors.push('non_blocking_findings section is missing')
  }
  if (verdict === 'NEEDS_FIX' && blocking && blocking.length === 0) {
    errors.push('NEEDS_FIX requires at least one blocking finding')
  }
  if (verdict === 'PASS' && blocking && blocking.length > 0) {
    errors.push('PASS cannot carry blocking findings')
  }
  const readableRunId = runId && RUN_ID.test(runId) ? runId : null
  const readableSha = headSha && FULL_SHA.test(headSha) ? headSha : null
  if (errors.length > 0 || !verdict || !blocking || !nonBlocking || !readableRunId) {
    return { kind: 'malformed', run_id: readableRunId, head_sha: readableSha, errors }
  }
  return {
    kind: 'valid',
    review: {
      run_id: readableRunId,
      head_sha: readableSha ?? '',
      verdict,
      blocking_findings: blocking,
      non_blocking_findings: nonBlocking
    }
  }
}

type BlockFields = {
  scalars: Map<string, string>
  lists: Map<string, string[]>
  errors: string[]
}

function readBlock(lines: string[], from: number): BlockFields {
  const scalars = new Map<string, string>()
  const lists = new Map<string, string[]>()
  const errors: string[] = []
  let currentList: string[] | null = null
  let pendingScalar: string | null = null
  for (let index = from; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.trim().startsWith('```')) {
      break
    }
    if (raw.trim().length === 0) {
      continue
    }
    const keyMatch = KEY_LINE.exec(raw)
    if (keyMatch && KNOWN_KEYS.has(keyMatch[1])) {
      const key = keyMatch[1]
      if (scalars.has(key) || lists.has(key)) {
        errors.push(`duplicate key: ${key}`)
      }
      currentList = null
      pendingScalar = null
      const value = stripDecoration(keyMatch[2])
      if (key === 'blocking_findings' || key === 'non_blocking_findings') {
        currentList = []
        lists.set(key, currentList)
        if (value.length > 0 && !EMPTY_FINDING.test(value)) {
          currentList.push(value)
        }
      } else if (value.length > 0) {
        scalars.set(key, value)
      } else {
        pendingScalar = key
      }
      continue
    }
    if (pendingScalar) {
      scalars.set(pendingScalar, stripDecoration(raw))
      pendingScalar = null
      continue
    }
    if (currentList) {
      const bullet = BULLET_LINE.exec(raw)
      if (bullet) {
        const item = bullet[1].trim()
        if (!EMPTY_FINDING.test(item)) {
          currentList.push(item)
        }
      } else if (currentList.length > 0) {
        // Why: wrapped finding text continues the previous bullet instead of becoming a new one.
        currentList[currentList.length - 1] = `${currentList.at(-1)} ${raw.trim()}`
      } else if (!EMPTY_FINDING.test(raw.trim())) {
        errors.push(`finding outside a bullet: ${raw.trim().slice(0, 80)}`)
      }
    }
  }
  return { scalars, lists, errors }
}

function parseVerdictToken(value: string | undefined): ReviewVerdict | null {
  return value === 'PASS' || value === 'NEEDS_FIX' ? value : null
}

function stripDecoration(value: string): string {
  return value
    .trim()
    .replace(/^[*_`]+/, '')
    .replace(/[*_`]+$/, '')
    .trim()
}
