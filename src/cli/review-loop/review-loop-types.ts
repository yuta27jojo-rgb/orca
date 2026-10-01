export const REVIEW_LOOP_SCHEMA_VERSION = 1
export const REVIEW_LOOP_MAX_ATTEMPTS = 3
export const REVIEW_LOOP_DEFAULT_REVIEW_TIMEOUT_MS = 24 * 60 * 60 * 1000
export const REVIEW_LOOP_DEFAULT_POLL_SCHEDULE = '*/10 * * * *'
const PROCESSED_REVIEW_HISTORY_LIMIT = 200

export type ReviewVerdict = 'PASS' | 'NEEDS_FIX'

export type ReviewLoopStatus =
  | 'AWAITING_REVIEW'
  | 'NEEDS_FIX'
  | 'PASSED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'LOCAL_REVIEW_REQUIRED'
  | 'BLOCKED'
  | 'STOPPED'

export const TERMINAL_REVIEW_LOOP_STATUSES: ReadonlySet<ReviewLoopStatus> = new Set([
  'PASSED',
  'HUMAN_REVIEW_REQUIRED',
  'LOCAL_REVIEW_REQUIRED',
  'STOPPED'
])

export type BlockingReason =
  | 'HEAD_CHANGED_EXTERNALLY'
  | 'PR_NOT_OPEN'
  | 'MAX_ATTEMPTS_EXHAUSTED'
  | 'REVIEWER_TIMEOUT'
  | 'LOCAL_ONLY_ARTIFACTS'
  | 'STOPPED_BY_USER'

export type ProcessedReviewOutcome =
  | 'ACCEPTED'
  | 'STALE_REVIEW'
  | 'DUPLICATE_REVIEW'
  | 'MALFORMED_REVIEW'
  | 'UNTRUSTED_AUTHOR'

export type ProcessedReview = {
  /** `issue_comment:<id>` or `review:<id>`; GitHub ids are unique per kind, not across kinds. */
  id: string
  updated_at: string
  outcome: ProcessedReviewOutcome
  author: string
  app: string | null
  head_sha: string | null
  verdict: ReviewVerdict | null
  attempt: number
  processed_at: string
  detail: string | null
}

export type ReviewRequestRecord = {
  attempt: number
  head_sha: string
  comment_id: number
  comment_url: string
  posted_at: string
}

export type AttemptRecord = {
  attempt: number
  head_sha: string
  verdict: ReviewVerdict
  review_id: string
  blocking_findings: string[]
  non_blocking_findings: string[]
}

export type ReviewLoopNotification = {
  status: ReviewLoopStatus
  head_sha: string
  attempt: number
  created_at: string
  /** Last time a precheck handed the event to Orca to start the agent. */
  dispatched_at: string | null
  dispatch_count: number
  /** Set only by the consumer (`next`, or `wait` in-session); until then the event is re-dispatched. */
  acknowledged_at: string | null
}

export type ReviewLoopRun = {
  schema_version: typeof REVIEW_LOOP_SCHEMA_VERSION
  run_id: string
  repo: { slug: string; remote: string }
  worktree_path: string
  orca: {
    worktree_id: string | null
    terminal_handle: string | null
    automation_id: string | null
    /** Last enabled state Orca confirmed; null when unknown or no automation. */
    automation_enabled: boolean | null
    resume_mode: 'automation' | 'manual'
  }
  pr: { number: number; url: string; base: string }
  branch: string
  current_head_sha: string
  attempt: number
  max_attempts: number
  status: ReviewLoopStatus
  verdict: ReviewVerdict | null
  blocking_reason: BlockingReason | null
  blocking_detail: string | null
  blocking_findings: string[]
  non_blocking_findings: string[]
  last_processed_review_id: string | null
  processed_reviews: ProcessedReview[]
  requests: ReviewRequestRecord[]
  attempts_history: AttemptRecord[]
  trusted_reviewers: string[]
  trusted_apps: string[]
  local_only_artifacts: string[]
  untracked_files: string[]
  review_timeout_ms: number
  notification: ReviewLoopNotification | null
  timestamps: {
    created_at: string
    updated_at: string
    awaiting_since: string | null
    last_tick_at: string | null
    last_verdict_at: string | null
  }
  resume: {
    last_tick_result: string | null
    consecutive_errors: number
    last_error: string | null
  }
}

/** A top-level PR conversation entry that may carry a review verdict. */
export type ReviewItem = {
  id: string
  kind: 'issue_comment' | 'review'
  numeric_id: number
  author: string
  app: string | null
  body: string
  created_at: string
  updated_at: string
}

export type PullRequestInfo = {
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  head_sha: string
  head_ref: string
  base_ref: string
}

export function isTerminalStatus(status: ReviewLoopStatus): boolean {
  return TERMINAL_REVIEW_LOOP_STATUSES.has(status)
}

export function appendProcessedReview(
  history: ProcessedReview[],
  entry: ProcessedReview
): ProcessedReview[] {
  const next = [...history, entry]
  return next.length > PROCESSED_REVIEW_HISTORY_LIMIT
    ? next.slice(next.length - PROCESSED_REVIEW_HISTORY_LIMIT)
    : next
}

export class ReviewLoopError extends Error {
  constructor(
    readonly code: ReviewLoopErrorCode,
    message: string,
    readonly nextSteps: string[] = []
  ) {
    super(message)
    this.name = 'ReviewLoopError'
  }
}

export type ReviewLoopErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'state_corrupt'
  | 'state_locked'
  | 'invalid_state'
  | 'git_error'
  | 'working_tree_dirty'
  | 'push_rejected'
  | 'github_auth'
  | 'github_unavailable'
  | 'github_error'
  | 'head_mismatch'
  | 'automation_error'
