import {
  openStore,
  postReviewRequest,
  syncAutomation,
  waitForPrHead,
  type ReviewLoopDeps
} from './review-loop-deps'
import { assertCleanTrackedTree, type CommandResult } from './review-loop-start'
import type { ReviewLoopStateStore } from './review-loop-state-store'
import { ReviewLoopError, type ReviewLoopRun } from './review-loop-types'

/**
 * Pushes the agent's fix and requests the next independent review. Each submit consumes one
 * attempt; the reviewed head must change, so a verdict can never be reused for new code.
 */
export async function submitReviewLoopFix(
  deps: ReviewLoopDeps,
  runId: string,
  cwd: string
): Promise<CommandResult> {
  const store = await openStore(deps, cwd)
  return store.withLock(runId, async () => {
    const run = store.load(runId)
    if (isInterruptedSubmit(run)) {
      return resumeInterruptedSubmit(deps, store, run)
    }
    assertSubmittable(run)
    const worktree = await deps.git.topLevel(cwd)
    const branch = await deps.git.currentBranch(worktree)
    if (branch !== run.branch) {
      throw new ReviewLoopError(
        'invalid_state',
        `Run ${runId} belongs to branch ${run.branch}, not ${branch}.`
      )
    }
    const tree = await deps.git.workingTree(worktree)
    assertCleanTrackedTree(tree.trackedChanges)
    const headSha = await deps.git.headSha(worktree)
    if (headSha === run.current_head_sha) {
      throw new ReviewLoopError('invalid_state', `HEAD is still the reviewed commit ${headSha}.`, [
        'Commit the fix for the blocking findings, then run submit again.'
      ])
    }
    await deps.git.push(worktree, run.repo.remote, run.branch)
    await waitForPrHead(deps, run.repo.slug, run.pr.number, headSha)
    const nowIso = deps.now().toISOString()
    const previousFindings = run.blocking_findings
    const next: ReviewLoopRun = {
      ...run,
      attempt: run.attempt + 1,
      current_head_sha: headSha,
      status: 'AWAITING_REVIEW',
      verdict: null,
      blocking_reason: null,
      blocking_detail: null,
      blocking_findings: [],
      non_blocking_findings: [],
      notification: null,
      untracked_files: tree.untrackedFiles,
      timestamps: { ...run.timestamps, updated_at: nowIso, awaiting_since: nowIso }
    }
    // Why: polling must be confirmed on before the waiting state is durable. If Orca refuses,
    // submit fails with the run still NEEDS_FIX and can simply be retried.
    const enabled = await requirePolling(deps, next)
    // Persist the new attempt before the comment so a crash cannot re-submit the same head.
    store.save(enabled)
    return publishRequest(deps, store, enabled, previousFindings)
  })
}

/** A waiting attempt whose request never reached GitHub, or whose polling is not confirmed on. */
function isInterruptedSubmit(run: ReviewLoopRun): boolean {
  if (run.status !== 'AWAITING_REVIEW') {
    return false
  }
  const requested = run.requests.some((request) => request.head_sha === run.current_head_sha)
  const unpolled = run.orca.automation_id !== null && run.orca.automation_enabled !== true
  return !requested || unpolled
}

async function resumeInterruptedSubmit(
  deps: ReviewLoopDeps,
  store: ReviewLoopStateStore,
  run: ReviewLoopRun
): Promise<CommandResult> {
  const enabled = await requirePolling(deps, run)
  store.save(enabled)
  const previous = enabled.attempts_history.at(-1)
  return publishRequest(
    deps,
    store,
    enabled,
    previous?.verdict === 'NEEDS_FIX' ? previous.blocking_findings : []
  )
}

/** Turns polling on for a waiting run, failing loudly instead of leaving it unpolled. */
async function requirePolling(deps: ReviewLoopDeps, run: ReviewLoopRun): Promise<ReviewLoopRun> {
  const synced = await syncAutomation(deps, run)
  if (synced.warning) {
    throw new ReviewLoopError('automation_error', synced.warning, [
      'Make sure Orca is running, then run submit again; nothing was requested yet.'
    ])
  }
  return synced.run
}

/** Posts the request once polling is on, so a failed post is re-posted by the automation's tick. */
async function publishRequest(
  deps: ReviewLoopDeps,
  store: ReviewLoopStateStore,
  run: ReviewLoopRun,
  previousFindings: string[]
): Promise<CommandResult> {
  if (run.requests.some((request) => request.head_sha === run.current_head_sha)) {
    return { run, warnings: [] }
  }
  const posted = await postReviewRequest(deps, run, previousFindings)
  store.save(posted)
  return { run: posted, warnings: [] }
}

function assertSubmittable(run: ReviewLoopRun): void {
  const recoverableBlock =
    run.status === 'BLOCKED' && run.blocking_reason === 'HEAD_CHANGED_EXTERNALLY'
  if (run.status !== 'NEEDS_FIX' && !recoverableBlock) {
    throw new ReviewLoopError(
      'invalid_state',
      `Run ${run.run_id} is ${run.status}; submit is only valid after NEEDS_FIX.`
    )
  }
  if (run.attempt >= run.max_attempts) {
    throw new ReviewLoopError(
      'invalid_state',
      `Run ${run.run_id} used all ${run.max_attempts} review attempts; a human review is required.`
    )
  }
}
