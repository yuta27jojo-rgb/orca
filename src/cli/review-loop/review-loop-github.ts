import { runProcess } from '../../shared/child-process/run-process'
import type { ProcessResult } from '../../shared/child-process/process-spec'
import { ReviewLoopError, type PullRequestInfo, type ReviewItem } from './review-loop-types'

export type ReviewLoopExec = (
  program: string,
  args: readonly string[],
  options?: { cwd?: string; input?: string; timeoutMs?: number }
) => Promise<ProcessResult>

export const defaultExec: ReviewLoopExec = (program, args, options = {}) =>
  runProcess({
    program,
    args,
    cwd: options.cwd,
    input: options.input,
    timeoutMs: options.timeoutMs ?? 60_000
  })

/** GitHub operations the loop needs, all through the user's authenticated `gh` CLI. */
export type ReviewLoopGitHub = {
  currentLogin(): Promise<string>
  defaultBranch(slug: string): Promise<string>
  findOpenPr(slug: string, branch: string): Promise<PullRequestInfo | null>
  createPr(
    slug: string,
    input: { base: string; head: string; title: string; body: string }
  ): Promise<void>
  viewPr(slug: string, prNumber: number): Promise<PullRequestInfo>
  listReviewItems(slug: string, prNumber: number): Promise<ReviewItem[]>
  postComment(slug: string, prNumber: number, body: string): Promise<{ id: number; url: string }>
}

const PR_FIELDS = 'number,url,state,headRefOid,headRefName,baseRefName,isCrossRepository'
const ITEM_JQ =
  '.[] | {id, login: .user.login, app: .performed_via_github_app.slug, body: (.body // ""), created_at: (.created_at // .submitted_at), updated_at: (.updated_at // .submitted_at)}'

export function createGhReviewLoopGitHub(exec: ReviewLoopExec = defaultExec): ReviewLoopGitHub {
  const gh = async (args: string[], input?: string): Promise<string> => {
    const result = await exec('gh', args, { input })
    if (result.code !== 0 || result.timedOut) {
      throw classifyGhFailure(args, result)
    }
    return result.stdout
  }
  const listItems = async (path: string, kind: ReviewItem['kind']): Promise<ReviewItem[]> => {
    const stdout = await gh(['api', '--paginate', path, '--jq', ITEM_JQ])
    return parseJsonLines(stdout).map((raw) => toReviewItem(raw, kind))
  }
  return {
    currentLogin: async () => (await gh(['api', 'user', '--jq', '.login'])).trim(),
    defaultBranch: async (slug) =>
      (
        await gh([
          'repo',
          'view',
          slug,
          '--json',
          'defaultBranchRef',
          '--jq',
          '.defaultBranchRef.name'
        ])
      ).trim(),
    findOpenPr: async (slug, branch) => {
      const stdout = await gh([
        'pr',
        'list',
        '--repo',
        slug,
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        PR_FIELDS
      ])
      const rows = parseJsonArray(stdout)
      // The loop pushes to the destination repo itself, so a same-named branch from another fork is a different PR.
      const own = rows.find((row) => row.isCrossRepository !== true)
      return own ? toPullRequest(own) : null
    },
    createPr: async (slug, input) => {
      await gh(
        [
          'pr',
          'create',
          '--repo',
          slug,
          '--base',
          input.base,
          '--head',
          input.head,
          '--title',
          input.title,
          '--body-file',
          '-'
        ],
        input.body
      )
    },
    viewPr: async (slug, prNumber) =>
      toPullRequest(
        parseJsonObject(
          await gh(['pr', 'view', String(prNumber), '--repo', slug, '--json', PR_FIELDS])
        )
      ),
    listReviewItems: async (slug, prNumber) => {
      const comments = await listItems(
        `repos/${slug}/issues/${prNumber}/comments?per_page=100`,
        'issue_comment'
      )
      const reviews = await listItems(
        `repos/${slug}/pulls/${prNumber}/reviews?per_page=100`,
        'review'
      )
      return [...comments, ...reviews].sort((a, b) => a.created_at.localeCompare(b.created_at))
    },
    postComment: async (slug, prNumber, body) => {
      const stdout = await gh(
        ['api', '-X', 'POST', `repos/${slug}/issues/${prNumber}/comments`, '--input', '-'],
        JSON.stringify({ body })
      )
      const created = parseJsonObject(stdout)
      if (typeof created.id !== 'number' || typeof created.html_url !== 'string') {
        throw new ReviewLoopError('github_error', 'GitHub did not return the created comment id.')
      }
      return { id: created.id, url: created.html_url }
    }
  }
}

const UNAVAILABLE_PATTERNS = [
  /could not resolve host/i,
  /connection (?:refused|reset|timed out)/i,
  /timeout/i,
  /i\/o timeout/i,
  /\b50[234]\b/,
  /rate limit/i,
  /secondary rate/i,
  /network/i,
  /EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND/
]
const AUTH_PATTERNS = [
  /gh auth login/i,
  /\b401\b/,
  /authentication/i,
  /not logged in/i,
  /bad credentials/i
]

export function classifyGhFailure(args: string[], result: ProcessResult): ReviewLoopError {
  const detail = (result.stderr || result.stdout).trim().slice(0, 500)
  const command = `gh ${args.slice(0, 3).join(' ')}`
  if (result.timedOut || UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(detail))) {
    return new ReviewLoopError(
      'github_unavailable',
      `${command} failed (GitHub unavailable): ${detail}`,
      ['Nothing was settled; the next tick retries.']
    )
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(detail))) {
    return new ReviewLoopError('github_auth', `${command} failed (authentication): ${detail}`, [
      'Run `gh auth status` and re-authenticate with `gh auth login` if needed.'
    ])
  }
  return new ReviewLoopError('github_error', `${command} failed: ${detail}`)
}

function toReviewItem(raw: Record<string, unknown>, kind: ReviewItem['kind']): ReviewItem {
  const numericId = raw.id
  if (typeof numericId !== 'number' || typeof raw.login !== 'string') {
    throw new ReviewLoopError('github_error', `Unexpected ${kind} payload from GitHub.`)
  }
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : ''
  return {
    id: `${kind}:${numericId}`,
    kind,
    numeric_id: numericId,
    author: raw.login,
    app: typeof raw.app === 'string' ? raw.app : null,
    body: typeof raw.body === 'string' ? raw.body : '',
    created_at: createdAt,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : createdAt
  }
}

function toPullRequest(raw: Record<string, unknown>): PullRequestInfo {
  const state = raw.state
  if (
    typeof raw.number !== 'number' ||
    typeof raw.url !== 'string' ||
    typeof raw.headRefOid !== 'string' ||
    (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED')
  ) {
    throw new ReviewLoopError('github_error', 'Unexpected pull request payload from GitHub.')
  }
  return {
    number: raw.number,
    url: raw.url,
    state,
    head_sha: raw.headRefOid.toLowerCase(),
    head_ref: typeof raw.headRefName === 'string' ? raw.headRefName : '',
    base_ref: typeof raw.baseRefName === 'string' ? raw.baseRefName : ''
  }
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseJsonObject(line))
}

function parseJsonArray(stdout: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(stdout || '[]')
  if (!Array.isArray(value)) {
    throw new ReviewLoopError('github_error', 'Expected a JSON array from gh.')
  }
  return value.filter(isRecord)
}

function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ReviewLoopError('github_error', 'gh returned output that is not JSON.')
  }
  if (!isRecord(value)) {
    throw new ReviewLoopError('github_error', 'Expected a JSON object from gh.')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
