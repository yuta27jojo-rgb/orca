import {
  REVIEW_LOOP_SCHEMA_VERSION,
  type ReviewLoopRun,
  type ReviewLoopStatus
} from './review-loop-types'

export const RUN_ID_PATTERN = /^rl-[0-9]{14}-[0-9a-f]{6}$/
const STATUSES: ReadonlySet<string> = new Set<ReviewLoopStatus>([
  'AWAITING_REVIEW',
  'NEEDS_FIX',
  'PASSED',
  'HUMAN_REVIEW_REQUIRED',
  'LOCAL_REVIEW_REQUIRED',
  'BLOCKED',
  'STOPPED'
])

type Check = (value: unknown) => boolean

const str: Check = (value) => typeof value === 'string'
const num: Check = (value) => typeof value === 'number' && Number.isFinite(value)
const bool: Check = (value) => typeof value === 'boolean'
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value)
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value)
const listOf =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check)
const shape =
  (fields: Record<string, Check>): Check =>
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false
    }
    const record: Record<string, unknown> = { ...value }
    return Object.entries(fields).every(([key, check]) => check(record[key]))
  }

const verdict = oneOf('PASS', 'NEEDS_FIX')

const RUN_SHAPE = shape({
  schema_version: (value) => value === REVIEW_LOOP_SCHEMA_VERSION,
  run_id: (value) => typeof value === 'string' && RUN_ID_PATTERN.test(value),
  repo: shape({ slug: str, remote: str }),
  worktree_path: str,
  orca: shape({
    worktree_id: nullable(str),
    terminal_handle: nullable(str),
    automation_id: nullable(str),
    automation_enabled: nullable(bool),
    resume_mode: oneOf('automation', 'manual')
  }),
  pr: shape({ number: num, url: str, base: str }),
  branch: str,
  current_head_sha: str,
  attempt: num,
  max_attempts: num,
  status: (value) => typeof value === 'string' && STATUSES.has(value),
  verdict: nullable(verdict),
  blocking_reason: nullable(str),
  blocking_detail: nullable(str),
  blocking_findings: listOf(str),
  non_blocking_findings: listOf(str),
  last_processed_review_id: nullable(str),
  processed_reviews: listOf(
    shape({ id: str, updated_at: str, outcome: str, author: str, attempt: num, processed_at: str })
  ),
  requests: listOf(shape({ attempt: num, head_sha: str, comment_id: num, comment_url: str })),
  attempts_history: listOf(
    shape({
      attempt: num,
      head_sha: str,
      verdict,
      review_id: str,
      blocking_findings: listOf(str),
      non_blocking_findings: listOf(str)
    })
  ),
  trusted_reviewers: listOf(str),
  trusted_apps: listOf(str),
  local_only_artifacts: listOf(str),
  untracked_files: listOf(str),
  review_timeout_ms: num,
  notification: nullable(
    shape({
      status: (value) => typeof value === 'string' && STATUSES.has(value),
      head_sha: str,
      attempt: num,
      created_at: str,
      dispatched_at: nullable(str),
      dispatch_count: num,
      acknowledged_at: nullable(str)
    })
  ),
  timestamps: shape({
    created_at: str,
    updated_at: str,
    awaiting_since: nullable(str),
    last_tick_at: nullable(str),
    last_verdict_at: nullable(str)
  }),
  resume: shape({
    last_tick_result: nullable(str),
    consecutive_errors: num,
    last_error: nullable(str)
  })
})

/** Full structural check, so a damaged or hand-edited file fails as state_corrupt, not mid-command. */
export function isReviewLoopRun(value: unknown): value is ReviewLoopRun {
  return RUN_SHAPE(value)
}
