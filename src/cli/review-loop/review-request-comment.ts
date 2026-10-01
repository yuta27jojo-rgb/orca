import { REVIEW_POLICY_LINES } from './review-policy'
import {
  REVIEW_REQUEST_HTML_MARKER,
  REVIEW_REQUEST_MARKER,
  REVIEW_VERDICT_MARKER
} from './review-verdict-contract'

export type ReviewRequestCommentInput = {
  runId: string
  repoSlug: string
  prNumber: number
  headSha: string
  attempt: number
  maxAttempts: number
  localOnlyArtifacts: string[]
  untrackedFiles: string[]
  previousBlockingFindings: string[]
}

const MAX_LISTED_UNTRACKED = 20

export function requestMarkerFor(runId: string, headSha: string): string {
  return `${REVIEW_REQUEST_HTML_MARKER} run_id=${runId} head_sha=${headSha}`
}

export function buildReviewRequestComment(input: ReviewRequestCommentInput): string {
  const lines = [
    `${requestMarkerFor(input.runId, input.headSha)} attempt=${input.attempt} -->`,
    `### Independent review requested (Orca review loop, attempt ${input.attempt}/${input.maxAttempts})`,
    '',
    '```text',
    REVIEW_REQUEST_MARKER,
    `repo: ${input.repoSlug}`,
    `pr: ${input.prNumber}`,
    `run_id: ${input.runId}`,
    `head_sha: ${input.headSha}`,
    `attempt: ${input.attempt}/${input.maxAttempts}`,
    '```',
    '',
    `Review this pull request at exactly commit \`${input.headSha}\`: the diff, changed files, CI / GitHub Actions results, unresolved review threads, regressions, correctness, security, reliability and tests.`,
    '',
    ...visibilitySection(input),
    ...REVIEW_POLICY_LINES,
    ...previousFindingsSection(input.previousBlockingFindings),
    'Reply with one PR comment that contains exactly this block. Keep `run_id`, use the full 40-character `head_sha` you reviewed, choose one verdict, and write `- none` for an empty section:',
    '',
    '```text',
    REVIEW_VERDICT_MARKER,
    '',
    `run_id: ${input.runId}`,
    `head_sha: ${input.headSha}`,
    'verdict: PASS | NEEDS_FIX',
    '',
    'blocking_findings:',
    '- none',
    '',
    'non_blocking_findings:',
    '- none',
    '',
    'final:',
    'PASS | NEEDS_FIX',
    '```',
    '',
    'A verdict for any other commit is ignored as stale. This loop never merges; PASS only clears the independent review gate.'
  ]
  return lines.join('\n')
}

function visibilitySection(input: ReviewRequestCommentInput): string[] {
  const lines = [
    '**Visibility.** Only what is pushed to GitHub at this commit is reviewable. The following are NOT visible to you and are not covered by your verdict:'
  ]
  if (input.localOnlyArtifacts.length > 0) {
    lines.push('', 'Declared local-only critical artifacts (need a separate local review):')
    lines.push(...input.localOnlyArtifacts.map((path) => `- \`${path}\``))
  }
  if (input.untrackedFiles.length > 0) {
    lines.push('', 'Untracked files in the author worktree:')
    lines.push(
      ...input.untrackedFiles.slice(0, MAX_LISTED_UNTRACKED).map((path) => `- \`${path}\``)
    )
    if (input.untrackedFiles.length > MAX_LISTED_UNTRACKED) {
      lines.push(`- …and ${input.untrackedFiles.length - MAX_LISTED_UNTRACKED} more`)
    }
  }
  if (input.localOnlyArtifacts.length === 0 && input.untrackedFiles.length === 0) {
    lines.push('', '- git-ignored files, local configuration, runtime state and databases')
  }
  lines.push('')
  return lines
}

function previousFindingsSection(findings: string[]): string[] {
  if (findings.length === 0) {
    return []
  }
  return [
    'Blocking findings from the previous attempt, which this commit claims to fix:',
    ...findings.map((finding) => `- ${finding}`),
    ''
  ]
}
