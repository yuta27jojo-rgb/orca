import { randomBytes } from 'node:crypto'
import {
  createCliReviewLoopAutomations,
  currentCliInvocation,
  type CliInvocation,
  type ReviewLoopAutomations
} from './review-loop-automation'
import { createReviewLoopGit, type ReviewLoopGit } from './review-loop-git'
import { createGhReviewLoopGitHub, type ReviewLoopGitHub } from './review-loop-github'
import { ReviewLoopStateStore } from './review-loop-state-store'
import {
  ReviewLoopError,
  type PullRequestInfo,
  type ReviewLoopRun,
  type ReviewRequestRecord
} from './review-loop-types'
import { buildReviewRequestComment, requestMarkerFor } from './review-request-comment'

export type ReviewLoopDeps = {
  git: ReviewLoopGit
  github: ReviewLoopGitHub
  automations: ReviewLoopAutomations
  cli: CliInvocation
  env: NodeJS.ProcessEnv
  now: () => Date
  randomHex: () => string
  sleep: (ms: number) => Promise<void>
}

export function createDefaultDeps(): ReviewLoopDeps {
  const cli = currentCliInvocation()
  return {
    git: createReviewLoopGit(),
    github: createGhReviewLoopGitHub(),
    automations: createCliReviewLoopAutomations(cli),
    cli,
    env: process.env,
    now: () => new Date(),
    randomHex: () => randomBytes(3).toString('hex'),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export async function openStore(
  deps: ReviewLoopDeps,
  worktreeOrCwd: string
): Promise<ReviewLoopStateStore> {
  return new ReviewLoopStateStore(await deps.git.commonDir(worktreeOrCwd))
}

export function newRunId(now: Date, randomHex: string): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `rl-${stamp}-${randomHex}`
}

/** An event the agent never acknowledged is re-dispatched after this long, at most this often. */
export const EVENT_REDISPATCH_AFTER_MS = 30 * 60 * 1000
export const MAX_EVENT_DISPATCHES = 3

const HEAD_SYNC_ATTEMPTS = 8
const HEAD_SYNC_DELAY_MS = 3_000

/** GitHub updates a PR's head asynchronously after a push; wait briefly instead of reviewing a stale head. */
export async function waitForPrHead(
  deps: ReviewLoopDeps,
  slug: string,
  prNumber: number,
  expectedSha: string
): Promise<PullRequestInfo> {
  let pr = await deps.github.viewPr(slug, prNumber)
  for (let attempt = 1; pr.head_sha !== expectedSha && attempt < HEAD_SYNC_ATTEMPTS; attempt += 1) {
    await deps.sleep(HEAD_SYNC_DELAY_MS)
    pr = await deps.github.viewPr(slug, prNumber)
  }
  if (pr.head_sha !== expectedSha) {
    throw new ReviewLoopError(
      'head_mismatch',
      `PR #${prNumber} head is ${pr.head_sha}, expected the pushed commit ${expectedSha}.`,
      ['Someone else may have pushed to the branch. Inspect the PR before retrying.']
    )
  }
  if (pr.state !== 'OPEN') {
    throw new ReviewLoopError('invalid_state', `PR #${prNumber} is ${pr.state}.`)
  }
  return pr
}

/**
 * Posts the review request for the run's current head. Idempotent across crashes: an existing
 * request comment for the same run and head is reused instead of posting a second one.
 */
export async function postReviewRequest(
  deps: ReviewLoopDeps,
  run: ReviewLoopRun,
  previousBlockingFindings: string[]
): Promise<ReviewLoopRun> {
  const marker = requestMarkerFor(run.run_id, run.current_head_sha)
  const items = await deps.github.listReviewItems(run.repo.slug, run.pr.number)
  const existing = items.find((item) => item.kind === 'issue_comment' && item.body.includes(marker))
  const record: ReviewRequestRecord = existing
    ? {
        attempt: run.attempt,
        head_sha: run.current_head_sha,
        comment_id: existing.numeric_id,
        comment_url: `${run.pr.url}#issuecomment-${existing.numeric_id}`,
        posted_at: existing.created_at
      }
    : await (async () => {
        const body = buildReviewRequestComment({
          runId: run.run_id,
          repoSlug: run.repo.slug,
          prNumber: run.pr.number,
          headSha: run.current_head_sha,
          attempt: run.attempt,
          maxAttempts: run.max_attempts,
          localOnlyArtifacts: run.local_only_artifacts,
          untrackedFiles: run.untracked_files,
          previousBlockingFindings
        })
        const posted = await deps.github.postComment(run.repo.slug, run.pr.number, body)
        return {
          attempt: run.attempt,
          head_sha: run.current_head_sha,
          comment_id: posted.id,
          comment_url: posted.url,
          posted_at: deps.now().toISOString()
        }
      })()
  return { ...run, requests: [...run.requests, record] }
}

/** Polling is needed while a review is awaited or an event still awaits the agent's ack. */
export function wantsAutomationEnabled(run: ReviewLoopRun): boolean {
  const notification = run.notification
  const undeliveredEvent =
    notification !== null &&
    notification.acknowledged_at === null &&
    notification.dispatch_count < MAX_EVENT_DISPATCHES
  return run.status === 'AWAITING_REVIEW' || undeliveredEvent
}

/**
 * Reconciles the automation's enabled flag with the run. Idempotent and retried on every call
 * until it succeeds, so an interrupted submit or tick cannot leave polling switched off.
 * Callers persist the returned run, which records the last state Orca confirmed.
 */
export async function syncAutomation(
  deps: ReviewLoopDeps,
  run: ReviewLoopRun
): Promise<{ run: ReviewLoopRun; warning: string | null }> {
  const automationId = run.orca.automation_id
  const desired = wantsAutomationEnabled(run)
  if (!automationId || run.orca.automation_enabled === desired) {
    return { run, warning: null }
  }
  try {
    await deps.automations.setEnabled(automationId, desired, run.worktree_path)
    return { run: { ...run, orca: { ...run.orca, automation_enabled: desired } }, warning: null }
  } catch (error) {
    return {
      run,
      warning: `Could not ${desired ? 'enable' : 'disable'} automation ${automationId}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
