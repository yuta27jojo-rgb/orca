import {
  appendProcessedReview,
  isTerminalStatus,
  type BlockingReason,
  type ProcessedReview,
  type ProcessedReviewOutcome,
  type PullRequestInfo,
  type ReviewItem,
  type ReviewLoopRun,
  type ReviewLoopStatus
} from './review-loop-types'
import {
  isLoopRequestComment,
  parseReviewContract,
  type ParsedReviewVerdict
} from './review-verdict-contract'

export type ReviewObservation = {
  pr: PullRequestInfo
  /** Oldest first, so the first valid verdict for a head wins. */
  items: ReviewItem[]
}

export type TickOutcome =
  | 'WAITING_FOR_REVIEW'
  | 'VERDICT_ACCEPTED'
  | 'BLOCKED'
  | 'TIMED_OUT'
  | 'FIX_IN_PROGRESS'
  | 'NO_ACTION'

export type TickEvaluation = {
  run: ReviewLoopRun
  outcome: TickOutcome
  /** Per-tick notes such as ignored stale or malformed comments, for the operator. */
  notes: string[]
}

/**
 * Applies one GitHub observation to a run. Pure: callers own I/O and persistence.
 * Only AWAITING_REVIEW consumes reviews; every other status leaves the run untouched.
 */
export function evaluateObservation(
  run: ReviewLoopRun,
  observation: ReviewObservation,
  now: Date
): TickEvaluation {
  if (isTerminalStatus(run.status) || run.status === 'BLOCKED') {
    return { run, outcome: 'NO_ACTION', notes: [] }
  }
  if (run.status === 'NEEDS_FIX') {
    return { run, outcome: 'FIX_IN_PROGRESS', notes: [] }
  }
  const nowIso = now.toISOString()
  if (observation.pr.number !== run.pr.number) {
    // Why: a result for another PR must never settle this run, even if the caller mixed them up.
    throw new Error(
      `observation for PR #${observation.pr.number} applied to run of #${run.pr.number}`
    )
  }
  if (observation.pr.state !== 'OPEN') {
    return blocked(run, 'PR_NOT_OPEN', `PR is ${observation.pr.state}`, nowIso)
  }
  if (observation.pr.head_sha !== run.current_head_sha) {
    return blocked(
      run,
      'HEAD_CHANGED_EXTERNALLY',
      `PR head is ${observation.pr.head_sha}, review was requested for ${run.current_head_sha}`,
      nowIso
    )
  }

  let next = run
  const notes: string[] = []
  for (const item of observation.items) {
    if (isLoopRequestComment(item.body) || alreadyProcessed(next, item)) {
      continue
    }
    const parsed = parseReviewContract(item.body)
    if (parsed.kind === 'absent') {
      continue
    }
    const runId = parsed.kind === 'valid' ? parsed.review.run_id : parsed.run_id
    if (runId !== next.run_id) {
      // Why: a block whose run_id is unreadable cannot be routed; record it only for the run
      // that was waiting when it arrived, and never let it settle anything.
      if (parsed.kind === 'malformed' && runId === null && isAfterRequest(next, item)) {
        notes.push(`${item.id}: unattributable review block (${parsed.errors.join('; ')})`)
        next = record(next, item, 'MALFORMED_REVIEW', null, null, parsed.errors.join('; '), nowIso)
      }
      continue
    }
    if (!isTrusted(next, item)) {
      const sha = parsed.kind === 'valid' ? parsed.review.head_sha : parsed.head_sha
      notes.push(`${item.id}: ignored review from untrusted author ${item.author}`)
      next = record(next, item, 'UNTRUSTED_AUTHOR', sha, null, null, nowIso)
      continue
    }
    if (parsed.kind === 'malformed') {
      notes.push(`${item.id}: malformed review (${parsed.errors.join('; ')})`)
      next = record(
        next,
        item,
        'MALFORMED_REVIEW',
        parsed.head_sha,
        null,
        parsed.errors.join('; '),
        nowIso
      )
      continue
    }
    const review = parsed.review
    if (review.head_sha !== next.current_head_sha) {
      notes.push(`${item.id}: STALE_REVIEW for ${review.head_sha}`)
      next = record(next, item, 'STALE_REVIEW', review.head_sha, review.verdict, null, nowIso)
      continue
    }
    if (hasAcceptedVerdictFor(next, review.head_sha)) {
      notes.push(`${item.id}: duplicate verdict for ${review.head_sha}`)
      next = record(next, item, 'DUPLICATE_REVIEW', review.head_sha, review.verdict, null, nowIso)
      continue
    }
    next = record(next, item, 'ACCEPTED', review.head_sha, review.verdict, null, nowIso)
    return { run: applyVerdict(next, item, review, nowIso), outcome: 'VERDICT_ACCEPTED', notes }
  }

  const awaitingSince = next.timestamps.awaiting_since
  if (awaitingSince && now.getTime() - Date.parse(awaitingSince) > next.review_timeout_ms) {
    const timedOut = settle(next, 'HUMAN_REVIEW_REQUIRED', nowIso, {
      reason: 'REVIEWER_TIMEOUT',
      detail: `no valid independent review for ${next.current_head_sha} since ${awaitingSince}`
    })
    return { run: timedOut, outcome: 'TIMED_OUT', notes }
  }
  return { run: next, outcome: 'WAITING_FOR_REVIEW', notes }
}

function applyVerdict(
  run: ReviewLoopRun,
  item: ReviewItem,
  review: ParsedReviewVerdict,
  nowIso: string
): ReviewLoopRun {
  const withVerdict: ReviewLoopRun = {
    ...run,
    verdict: review.verdict,
    blocking_findings: review.blocking_findings,
    non_blocking_findings: review.non_blocking_findings,
    last_processed_review_id: item.id,
    attempts_history: [
      ...run.attempts_history,
      {
        attempt: run.attempt,
        head_sha: review.head_sha,
        verdict: review.verdict,
        review_id: item.id,
        blocking_findings: review.blocking_findings,
        non_blocking_findings: review.non_blocking_findings
      }
    ],
    timestamps: { ...run.timestamps, last_verdict_at: nowIso }
  }
  if (review.verdict === 'PASS') {
    return run.local_only_artifacts.length > 0
      ? settle(withVerdict, 'LOCAL_REVIEW_REQUIRED', nowIso, {
          reason: 'LOCAL_ONLY_ARTIFACTS',
          detail:
            'independent review passed, but declared local-only artifacts were not visible to it'
        })
      : settle(withVerdict, 'PASSED', nowIso, null)
  }
  if (run.attempt >= run.max_attempts) {
    return settle(withVerdict, 'HUMAN_REVIEW_REQUIRED', nowIso, {
      reason: 'MAX_ATTEMPTS_EXHAUSTED',
      detail: `NEEDS_FIX on attempt ${run.attempt}/${run.max_attempts}`
    })
  }
  return settle(withVerdict, 'NEEDS_FIX', nowIso, null)
}

/** Moves to `status` and queues one agent notification for the transition. */
export function settle(
  run: ReviewLoopRun,
  status: ReviewLoopStatus,
  nowIso: string,
  blocking: { reason: BlockingReason; detail: string } | null
): ReviewLoopRun {
  return {
    ...run,
    status,
    blocking_reason: blocking?.reason ?? null,
    blocking_detail: blocking?.detail ?? null,
    notification: {
      status,
      head_sha: run.current_head_sha,
      attempt: run.attempt,
      created_at: nowIso,
      dispatched_at: null,
      dispatch_count: 0,
      acknowledged_at: null
    },
    timestamps: { ...run.timestamps, updated_at: nowIso }
  }
}

function blocked(
  run: ReviewLoopRun,
  reason: BlockingReason,
  detail: string,
  nowIso: string
): TickEvaluation {
  return { run: settle(run, 'BLOCKED', nowIso, { reason, detail }), outcome: 'BLOCKED', notes: [] }
}

function record(
  run: ReviewLoopRun,
  item: ReviewItem,
  outcome: ProcessedReviewOutcome,
  headSha: string | null,
  verdict: ProcessedReview['verdict'],
  detail: string | null,
  nowIso: string
): ReviewLoopRun {
  return {
    ...run,
    processed_reviews: appendProcessedReview(run.processed_reviews, {
      id: item.id,
      updated_at: item.updated_at,
      outcome,
      author: item.author,
      app: item.app,
      head_sha: headSha,
      verdict,
      attempt: run.attempt,
      processed_at: nowIso,
      detail
    })
  }
}

/**
 * An accepted verdict is final for its comment id; any other outcome is re-evaluated only when
 * GitHub reports a newer edit, so a corrected malformed comment can still count.
 */
function alreadyProcessed(run: ReviewLoopRun, item: ReviewItem): boolean {
  return run.processed_reviews.some(
    (entry) =>
      entry.id === item.id && (entry.outcome === 'ACCEPTED' || entry.updated_at === item.updated_at)
  )
}

function hasAcceptedVerdictFor(run: ReviewLoopRun, headSha: string): boolean {
  return run.processed_reviews.some(
    (entry) => entry.outcome === 'ACCEPTED' && entry.head_sha === headSha
  )
}

function isTrusted(run: ReviewLoopRun, item: ReviewItem): boolean {
  const author = item.author.toLowerCase()
  if (!run.trusted_reviewers.some((login) => login.toLowerCase() === author)) {
    return false
  }
  if (run.trusted_apps.length === 0) {
    return true
  }
  return (
    item.app !== null &&
    run.trusted_apps.some((app) => app.toLowerCase() === item.app?.toLowerCase())
  )
}

function isAfterRequest(run: ReviewLoopRun, item: ReviewItem): boolean {
  const since = run.timestamps.awaiting_since
  return since !== null && Date.parse(item.created_at) >= Date.parse(since)
}
