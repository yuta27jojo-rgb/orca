import { readFileSync } from 'node:fs'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRepeatedStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { createDefaultDeps, openStore, type ReviewLoopDeps } from '../review-loop/review-loop-deps'
import {
  buildNextStep,
  formatNextStep,
  formatRunStatus
} from '../review-loop/review-loop-next-step'
import { startReviewLoop, type StartOptions } from '../review-loop/review-loop-start'
import { submitReviewLoopFix } from '../review-loop/review-loop-submit'
import {
  acknowledgeReviewLoopEvent,
  describe,
  stopReviewLoop,
  tickReviewLoop,
  waitReviewLoop,
  type TickResult
} from '../review-loop/review-loop-tick'
import { ReviewLoopError, type ReviewLoopRun } from '../review-loop/review-loop-types'
import { ReviewLoopStateStore } from '../review-loop/review-loop-state-store'

// Why: Claude Code's Bash tool caps one call at 10 minutes; stay under it by default.
const DEFAULT_WAIT_TIMEOUT_MS = 9 * 60_000
const DEFAULT_WAIT_INTERVAL_MS = 60_000
const MIN_WAIT_INTERVAL_MS = 10_000

type Output = { json: boolean }

export const REVIEW_LOOP_HANDLERS: Record<string, CommandHandler> = {
  'review-loop start': async ({ flags, cwd, json }) =>
    guarded(async (deps) => {
      const result = await startReviewLoop(deps, readStartOptions(flags, cwd))
      printRun(result.run, result.warnings, { json }, `Started ${describe(result.run)}`)
    }),
  'review-loop submit': async ({ flags, cwd, json }) =>
    guarded(async (deps) => {
      const result = await submitReviewLoopFix(deps, runFlag(flags), worktreeFlag(flags, cwd))
      printRun(result.run, result.warnings, { json }, `Submitted ${describe(result.run)}`)
    }),
  'review-loop tick': async ({ flags, cwd, json }) =>
    guarded(async (deps) => {
      printTick(await tickReviewLoop(deps, runFlag(flags), worktreeFlag(flags, cwd)), { json })
    }),
  'review-loop wait': async ({ flags, cwd, json }) =>
    guarded(async (deps) => {
      const timeoutMs = positiveInteger(flags, 'timeout-ms') ?? DEFAULT_WAIT_TIMEOUT_MS
      const intervalMs = Math.max(
        MIN_WAIT_INTERVAL_MS,
        positiveInteger(flags, 'interval-ms') ?? DEFAULT_WAIT_INTERVAL_MS
      )
      const result = await waitReviewLoop(deps, runFlag(flags), worktreeFlag(flags, cwd), {
        timeoutMs,
        intervalMs
      })
      printTick(result, { json })
    }),
  'review-loop next': async ({ flags, cwd, json }) =>
    guarded(async (deps) => {
      // Reading the instructions is the agent's receipt; it stops the event being re-dispatched.
      const run = await acknowledgeReviewLoopEvent(deps, runFlag(flags), worktreeFlag(flags, cwd))
      const step = buildNextStep(run, deps.cli)
      console.log(json ? JSON.stringify({ ok: true, next: step }, null, 2) : formatNextStep(step))
    }),
  'review-loop status': async ({ flags, cwd, json }) =>
    guarded(async (deps) => {
      const run = (await openStore(deps, worktreeFlag(flags, cwd))).load(runFlag(flags))
      console.log(json ? JSON.stringify({ ok: true, run }, null, 2) : formatRunStatus(run))
    }),
  'review-loop list': async ({ flags, cwd, json }) =>
    guarded(async (deps) => {
      const runs = (await openStore(deps, worktreeFlag(flags, cwd))).list()
      if (json) {
        console.log(JSON.stringify({ ok: true, runs }, null, 2))
      } else {
        console.log(
          runs.length === 0 ? 'No review-loop runs.' : runs.map(formatRunStatus).join('\n\n')
        )
      }
    }),
  'review-loop stop': async ({ flags, cwd, json }) =>
    guarded(async (deps) => {
      const reason = getOptionalStringFlag(flags, 'reason') ?? 'stopped by operator'
      const result = await stopReviewLoop(deps, runFlag(flags), worktreeFlag(flags, cwd), reason)
      printRun(result.run, result.warnings, { json }, `Stopped ${describe(result.run)}`)
    })
}

async function guarded(action: (deps: ReviewLoopDeps) => Promise<void>): Promise<void> {
  try {
    await action(createDefaultDeps())
  } catch (error) {
    if (error instanceof ReviewLoopError) {
      throw new RuntimeClientError(error.code, error.message, { nextSteps: error.nextSteps })
    }
    throw error
  }
}

function readStartOptions(flags: Map<string, string | boolean>, cwd: string): StartOptions {
  const resume = getOptionalStringFlag(flags, 'resume') ?? 'auto'
  if (resume !== 'auto' && resume !== 'automation' && resume !== 'manual') {
    throw new RuntimeClientError('invalid_argument', '--resume must be auto, automation or manual.')
  }
  const bodyFile = getOptionalStringFlag(flags, 'body-file')
  const timeoutHours = positiveInteger(flags, 'review-timeout-hours')
  return {
    cwd: worktreeFlag(flags, cwd),
    remote: getOptionalStringFlag(flags, 'remote'),
    base: getOptionalStringFlag(flags, 'base'),
    title: getOptionalStringFlag(flags, 'title'),
    body: bodyFile ? readFileSync(bodyFile, 'utf-8') : undefined,
    trustedReviewers: getRepeatedStringFlag(flags, 'trusted-reviewer'),
    trustedApps: getRepeatedStringFlag(flags, 'trusted-app'),
    localArtifacts: getRepeatedStringFlag(flags, 'local-artifact'),
    resume,
    provider: getOptionalStringFlag(flags, 'provider') ?? 'claude',
    schedule: getOptionalStringFlag(flags, 'poll-schedule'),
    reviewTimeoutMs: timeoutHours ? timeoutHours * 60 * 60 * 1000 : undefined
  }
}

function runFlag(flags: Map<string, string | boolean>): string {
  const runId = getRequiredStringFlag(flags, 'run')
  ReviewLoopStateStore.assertRunId(runId)
  return runId
}

function worktreeFlag(flags: Map<string, string | boolean>, cwd: string): string {
  return getOptionalStringFlag(flags, 'worktree') ?? cwd
}

function positiveInteger(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = getOptionalStringFlag(flags, name)
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a positive integer.`)
  }
  return value
}

function printRun(run: ReviewLoopRun, warnings: string[], output: Output, headline: string): void {
  if (output.json) {
    console.log(JSON.stringify({ ok: true, run, warnings }, null, 2))
    return
  }
  console.log(
    [headline, formatRunStatus(run), ...warnings.map((warning) => `warning: ${warning}`)].join('\n')
  )
}

function printTick(result: TickResult, output: Output): void {
  process.exitCode = result.exitCode
  if (output.json) {
    const { run, ...rest } = result
    console.log(
      JSON.stringify(
        { ok: result.exitCode !== 1, ...rest, status: run.status, run_id: run.run_id },
        null,
        2
      )
    )
    return
  }
  console.log(
    [
      result.summary,
      ...result.notes.map((note) => `note: ${note}`),
      ...result.warnings.map((w) => `warning: ${w}`)
    ].join('\n')
  )
}
