import {
  EVENT_REDISPATCH_AFTER_MS,
  MAX_EVENT_DISPATCHES,
  openStore,
  postReviewRequest,
  syncAutomation,
  type ReviewLoopDeps
} from './review-loop-deps'
import type { ReviewLoopStateStore } from './review-loop-state-store'
import { evaluateObservation, settle } from './review-loop-transitions'
import { isTerminalStatus, ReviewLoopError, type ReviewLoopRun } from './review-loop-types'

/** Exit codes double as the automation precheck contract: only 0 starts the agent. */
export const TICK_EXIT = {
  EVENT_READY: 0,
  ERROR: 1,
  WAITING: 3,
  NOTHING_TO_DO: 4
} as const

export type TickResult = {
  run: ReviewLoopRun
  exitCode: (typeof TICK_EXIT)[keyof typeof TICK_EXIT]
  summary: string
  notes: string[]
  warnings: string[]
}

/**
 * One idempotent poll. Reconciles the durable run with GitHub, then hands at most one pending
 * event to the caller. Safe to run from any process at any time, including after a restart.
 */
export async function tickReviewLoop(
  deps: ReviewLoopDeps,
  runId: string,
  cwd: string,
  options: { acknowledge: boolean } = { acknowledge: false }
): Promise<TickResult> {
  const store = await openStore(deps, cwd)
  return store.withLock(runId, async () => {
    let run = store.load(runId)
    const notes: string[] = []
    const warnings: string[] = []
    const nowIso = deps.now().toISOString()
    if (run.status === 'AWAITING_REVIEW') {
      try {
        if (!run.requests.some((request) => request.head_sha === run.current_head_sha)) {
          // Recovers a crash between persisting a new attempt and posting its request.
          run = await postReviewRequest(deps, run, lastBlockingFindings(run))
        }
        const items = await deps.github.listReviewItems(run.repo.slug, run.pr.number)
        // Why: read the head after the comments, so a push that lands while they are fetched
        // shows up as a head change instead of letting a verdict for the old head through.
        const pr = await deps.github.viewPr(run.repo.slug, run.pr.number)
        const evaluation = evaluateObservation(run, { pr, items }, deps.now())
        notes.push(...evaluation.notes)
        run = {
          ...evaluation.run,
          timestamps: { ...evaluation.run.timestamps, last_tick_at: nowIso },
          resume: { last_tick_result: evaluation.outcome, consecutive_errors: 0, last_error: null }
        }
      } catch (error) {
        if (!(error instanceof ReviewLoopError) || !error.code.startsWith('github_')) {
          throw error
        }
        // Transient or auth failures never settle a run; record and let the next tick retry.
        run = {
          ...run,
          timestamps: { ...run.timestamps, last_tick_at: nowIso },
          resume: {
            last_tick_result: error.code.toUpperCase(),
            consecutive_errors: run.resume.consecutive_errors + 1,
            last_error: error.message
          }
        }
        store.save(run)
        return { run, exitCode: TICK_EXIT.ERROR, summary: error.message, notes, warnings }
      }
    }
    return handOff(deps, store, run, { notes, warnings, nowIso, acknowledge: options.acknowledge })
  })
}

/**
 * Hands the pending event over. A precheck only dispatches: the event stays pending until the
 * agent acknowledges it with `next`, and is re-dispatched if no agent ever picked it up.
 */
async function handOff(
  deps: ReviewLoopDeps,
  store: ReviewLoopStateStore,
  current: ReviewLoopRun,
  context: { notes: string[]; warnings: string[]; nowIso: string; acknowledge: boolean }
): Promise<TickResult> {
  const { notes, warnings, nowIso } = context
  let run = current
  const notification = run.notification
  if (notification && notification.acknowledged_at === null) {
    if (context.acknowledge) {
      run = { ...run, notification: { ...notification, acknowledged_at: nowIso } }
      return finish(deps, store, run, TICK_EXIT.EVENT_READY, notes, warnings)
    }
    const lastDispatch = notification.dispatched_at ? Date.parse(notification.dispatched_at) : null
    const due =
      lastDispatch === null || Date.parse(nowIso) - lastDispatch >= EVENT_REDISPATCH_AFTER_MS
    if (due && notification.dispatch_count < MAX_EVENT_DISPATCHES) {
      run = {
        ...run,
        notification: {
          ...notification,
          dispatched_at: nowIso,
          dispatch_count: notification.dispatch_count + 1
        }
      }
      store.save(run)
      // Why: leave the automation alone while handing off; a serve-mode dispatcher refuses runs
      // whose definition changed during the precheck.
      return { run, exitCode: TICK_EXIT.EVENT_READY, summary: describe(run), notes, warnings }
    }
    if (notification.dispatch_count >= MAX_EVENT_DISPATCHES) {
      warnings.push(
        `No agent acknowledged the ${notification.status} event after ${notification.dispatch_count} dispatches; run \`orca review-loop next ${run.run_id}\` manually.`
      )
    }
  }
  const exitCode = run.status === 'AWAITING_REVIEW' ? TICK_EXIT.WAITING : TICK_EXIT.NOTHING_TO_DO
  return finish(deps, store, run, exitCode, notes, warnings)
}

async function finish(
  deps: ReviewLoopDeps,
  store: ReviewLoopStateStore,
  current: ReviewLoopRun,
  exitCode: TickResult['exitCode'],
  notes: string[],
  warnings: string[]
): Promise<TickResult> {
  store.save(current)
  const synced = await syncAutomation(deps, current)
  if (synced.warning) {
    warnings.push(synced.warning)
  }
  store.save(synced.run)
  return { run: synced.run, exitCode, summary: describe(synced.run), notes, warnings }
}

/** The consumer's receipt: once the agent has read the event, it is never dispatched again. */
export async function acknowledgeReviewLoopEvent(
  deps: ReviewLoopDeps,
  runId: string,
  cwd: string
): Promise<ReviewLoopRun> {
  const store = await openStore(deps, cwd)
  return store.withLock(runId, async () => {
    const current = store.load(runId)
    const notification = current.notification
    if (!notification || notification.acknowledged_at !== null) {
      return current
    }
    const run = {
      ...current,
      notification: { ...notification, acknowledged_at: deps.now().toISOString() }
    }
    return (await finish(deps, store, run, TICK_EXIT.EVENT_READY, [], [])).run
  })
}

/**
 * In-session polling for callers without an automation. Bounded: returns at the first event or
 * when `timeoutMs` elapses, so an agent's tool call never blocks indefinitely.
 */
export async function waitReviewLoop(
  deps: ReviewLoopDeps,
  runId: string,
  cwd: string,
  options: { timeoutMs: number; intervalMs: number }
): Promise<TickResult> {
  const owner = (await openStore(deps, cwd)).load(runId)
  if (owner.orca.resume_mode === 'automation' && owner.orca.automation_id) {
    // Why: two consumers would start two agents fixing the same findings concurrently.
    throw new ReviewLoopError(
      'invalid_state',
      `Run ${runId} resumes through Orca automation ${owner.orca.automation_id}; do not poll it in-session.`,
      ['End this turn. Orca starts an agent with the review result when it arrives.']
    )
  }
  const deadline = deps.now().getTime() + options.timeoutMs
  for (;;) {
    let result: TickResult
    try {
      // The in-session caller is the consumer, so reading the event is its acknowledgement.
      result = await tickReviewLoop(deps, runId, cwd, { acknowledge: true })
    } catch (error) {
      if (!(error instanceof ReviewLoopError) || error.code !== 'state_locked') {
        throw error
      }
      // An automation precheck holds the lock briefly; treat it like an empty poll.
      result = { ...(await readOnly(deps, runId, cwd)), exitCode: TICK_EXIT.WAITING }
    }
    if (result.exitCode !== TICK_EXIT.WAITING && result.exitCode !== TICK_EXIT.ERROR) {
      return result
    }
    if (deps.now().getTime() + options.intervalMs > deadline) {
      return result
    }
    await deps.sleep(options.intervalMs)
  }
}

export async function stopReviewLoop(
  deps: ReviewLoopDeps,
  runId: string,
  cwd: string,
  reason: string
): Promise<{ run: ReviewLoopRun; warnings: string[] }> {
  const store = await openStore(deps, cwd)
  return store.withLock(runId, async () => {
    const current = store.load(runId)
    const nowIso = deps.now().toISOString()
    // An ended run keeps its outcome; stopping it only silences its pending event and polling.
    const stopped = isTerminalStatus(current.status)
      ? current
      : settle(current, 'STOPPED', nowIso, { reason: 'STOPPED_BY_USER', detail: reason })
    // The operator asked for this; there is nothing to hand to an agent.
    const run = {
      ...stopped,
      notification: stopped.notification && {
        ...stopped.notification,
        acknowledged_at: stopped.notification.acknowledged_at ?? nowIso
      }
    }
    const result = await finish(deps, store, run, TICK_EXIT.NOTHING_TO_DO, [], [])
    return { run: result.run, warnings: result.warnings }
  })
}

async function readOnly(
  deps: ReviewLoopDeps,
  runId: string,
  cwd: string
): Promise<Omit<TickResult, 'exitCode'>> {
  const run = (await openStore(deps, cwd)).load(runId)
  return {
    run,
    summary: describe(run),
    notes: ['another process holds the run lock'],
    warnings: []
  }
}

function lastBlockingFindings(run: ReviewLoopRun): string[] {
  const previous = run.attempts_history.at(-1)
  return previous && previous.verdict === 'NEEDS_FIX' ? previous.blocking_findings : []
}

export function describe(run: ReviewLoopRun): string {
  const base = `${run.run_id} ${run.status} attempt ${run.attempt}/${run.max_attempts} PR #${run.pr.number} head ${run.current_head_sha.slice(0, 12)}`
  return run.blocking_reason
    ? `${base} (${run.blocking_reason}: ${run.blocking_detail ?? ''})`
    : base
}
