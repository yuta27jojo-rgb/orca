import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakeEnvironment, type FakeEnvironment } from './review-loop-fakes'
import { buildNextStep } from './review-loop-next-step'
import { ReviewLoopStateStore } from './review-loop-state-store'
import { ReviewLoopError } from './review-loop-types'
import { startReviewLoop, type StartOptions } from './review-loop-start'
import { submitReviewLoopFix } from './review-loop-submit'
import {
  acknowledgeReviewLoopEvent,
  stopReviewLoop,
  TICK_EXIT,
  tickReviewLoop,
  waitReviewLoop
} from './review-loop-tick'

const WT = '/work/repo'
const SLUG = 'me/repo'
const SHA_1 = '1'.repeat(40)
const SHA_2 = '2'.repeat(40)
const SHA_3 = '3'.repeat(40)
const SHA_X = 'f'.repeat(40)

function options(overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    cwd: WT,
    trustedReviewers: ['chatgpt-reviewer'],
    trustedApps: [],
    localArtifacts: [],
    resume: 'auto',
    provider: 'claude',
    ...overrides
  }
}

function setup(): FakeEnvironment {
  const env = createFakeEnvironment()
  env.git.addWorktree(WT, 'feat/x', SHA_1, { fork: `https://github.com/${SLUG}.git` })
  return env
}

function verdict(
  runId: string,
  sha: string,
  value: 'PASS' | 'NEEDS_FIX',
  finding = 'bug in parser'
): string {
  return [
    'GPT_REVIEW_V1',
    `run_id: ${runId}`,
    `head_sha: ${sha}`,
    `verdict: ${value}`,
    'blocking_findings:',
    value === 'PASS' ? '- none' : `- ${finding}`,
    'non_blocking_findings:',
    '- none',
    'final:',
    value
  ].join('\n')
}

async function commitFix(env: FakeEnvironment, sha: string): Promise<void> {
  const worktree = env.git.worktrees.get(WT)
  if (worktree) {
    worktree.head = sha
  }
}

describe('review loop controller', () => {
  it('starts: pushes, opens the PR in the remote repo, posts one request and creates the automation', async () => {
    const env = setup()
    const { run, warnings } = await startReviewLoop(env.deps, options())
    expect(warnings).toEqual([])
    expect(env.git.pushes).toEqual([{ worktree: WT, remote: 'fork', branch: 'feat/x', sha: SHA_1 }])
    expect(run).toMatchObject({
      status: 'AWAITING_REVIEW',
      attempt: 1,
      max_attempts: 3,
      current_head_sha: SHA_1,
      pr: { number: 1 },
      orca: { resume_mode: 'automation', automation_id: 'auto-1', worktree_id: 'wt-1' }
    })
    expect(env.github.posted).toHaveLength(1)
    expect(env.github.posted[0].body).toContain(`head_sha: ${SHA_1}`)
    expect(env.automations.created[0].precheck).toContain(`review-loop tick --run ${run.run_id}`)
    expect(env.automations.created[0].prompt).toContain(`review-loop next ${run.run_id}`)
    const persisted = new ReviewLoopStateStore(env.git.commonDirPath).load(run.run_id)
    expect(persisted.requests).toHaveLength(1)
  })

  it('refuses dirty trees, the base branch, and a second active run on the same branch', async () => {
    const env = setup()
    const worktree = env.git.worktrees.get(WT)
    if (!worktree) {
      throw new Error('missing fixture')
    }
    worktree.tree = { trackedChanges: ['src/a.ts'], untrackedFiles: [] }
    await expect(startReviewLoop(env.deps, options())).rejects.toMatchObject({
      code: 'working_tree_dirty'
    })
    worktree.tree = { trackedChanges: [], untrackedFiles: ['notes.txt'] }
    worktree.branch = 'main'
    await expect(startReviewLoop(env.deps, options())).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    worktree.branch = 'feat/x'
    const { run } = await startReviewLoop(env.deps, options())
    expect(run.untracked_files).toEqual(['notes.txt'])
    expect(env.github.posted[0].body).toContain('notes.txt')
    await expect(startReviewLoop(env.deps, options())).rejects.toMatchObject({
      code: 'invalid_state'
    })
  })

  it('PASS path: waits, then hands the PASS over exactly once and disables polling afterwards', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    expect((await tickReviewLoop(env.deps, run.run_id, WT)).exitCode).toBe(TICK_EXIT.WAITING)
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'PASS'))
    const passed = await tickReviewLoop(env.deps, run.run_id, WT)
    expect(passed.exitCode).toBe(TICK_EXIT.EVENT_READY)
    expect(passed.run.status).toBe('PASSED')
    expect(env.automations.enabled.get('auto-1')).toBe(true)
    // Dispatched but not yet acknowledged: polling stays on, no second dispatch inside the grace.
    const after = await tickReviewLoop(env.deps, run.run_id, WT)
    expect(after.exitCode).toBe(TICK_EXIT.NOTHING_TO_DO)
    expect(env.automations.enabled.get('auto-1')).toBe(true)
    await acknowledgeReviewLoopEvent(env.deps, run.run_id, WT)
    expect(env.automations.enabled.get('auto-1')).toBe(false)
    expect((await tickReviewLoop(env.deps, run.run_id, WT)).exitCode).toBe(TICK_EXIT.NOTHING_TO_DO)
  })

  it('re-dispatches an event no agent acknowledged, at most three times', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'NEEDS_FIX'))
    expect((await tickReviewLoop(env.deps, run.run_id, WT)).exitCode).toBe(TICK_EXIT.EVENT_READY)
    env.advance(10 * 60 * 1000)
    expect((await tickReviewLoop(env.deps, run.run_id, WT)).exitCode).toBe(TICK_EXIT.NOTHING_TO_DO)
    for (let dispatch = 2; dispatch <= 3; dispatch += 1) {
      env.advance(31 * 60 * 1000)
      const tick = await tickReviewLoop(env.deps, run.run_id, WT)
      expect(tick.exitCode).toBe(TICK_EXIT.EVENT_READY)
      expect(tick.run.notification?.dispatch_count).toBe(dispatch)
    }
    env.advance(31 * 60 * 1000)
    const exhausted = await tickReviewLoop(env.deps, run.run_id, WT)
    expect(exhausted.exitCode).toBe(TICK_EXIT.NOTHING_TO_DO)
    expect(exhausted.warnings.join()).toContain('No agent acknowledged')
    expect(env.automations.enabled.get('auto-1')).toBe(false)
  })

  it('an interrupted submit keeps polling on and can be resumed', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'NEEDS_FIX'))
    await tickReviewLoop(env.deps, run.run_id, WT)
    await acknowledgeReviewLoopEvent(env.deps, run.run_id, WT)
    expect(env.automations.enabled.get('auto-1')).toBe(false)
    await commitFix(env, SHA_2)
    const original = env.github.postComment
    env.github.postComment = async () => {
      throw new ReviewLoopError('github_unavailable', 'connection reset')
    }
    await expect(submitReviewLoopFix(env.deps, run.run_id, WT)).rejects.toMatchObject({
      code: 'github_unavailable'
    })
    expect(env.automations.enabled.get('auto-1')).toBe(true)
    env.github.postComment = original
    const resumed = await submitReviewLoopFix(env.deps, run.run_id, WT)
    expect(resumed.run).toMatchObject({ status: 'AWAITING_REVIEW', attempt: 2 })
    expect(resumed.run.requests.map((request) => request.head_sha)).toEqual([SHA_1, SHA_2])
  })

  it('NEEDS_FIX loop: attempt 1 → 2 → 3, then HUMAN_REVIEW_REQUIRED without another fix', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    const shas = [SHA_1, SHA_2, SHA_3]
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      env.github.addComment(
        SLUG,
        1,
        'chatgpt-reviewer',
        verdict(run.run_id, shas[attempt - 1], 'NEEDS_FIX', `bug ${attempt}`)
      )
      const tick = await tickReviewLoop(env.deps, run.run_id, WT)
      expect(tick.exitCode).toBe(TICK_EXIT.EVENT_READY)
      if (attempt < 3) {
        expect(tick.run).toMatchObject({
          status: 'NEEDS_FIX',
          attempt,
          blocking_findings: [`bug ${attempt}`]
        })
        expect((await tickReviewLoop(env.deps, run.run_id, WT)).exitCode).toBe(
          TICK_EXIT.NOTHING_TO_DO
        )
        await acknowledgeReviewLoopEvent(env.deps, run.run_id, WT)
        expect(env.automations.enabled.get('auto-1')).toBe(false)
        await expect(submitReviewLoopFix(env.deps, run.run_id, WT)).rejects.toMatchObject({
          code: 'invalid_state'
        })
        await commitFix(env, shas[attempt])
        const submitted = await submitReviewLoopFix(env.deps, run.run_id, WT)
        expect(submitted.run).toMatchObject({
          status: 'AWAITING_REVIEW',
          attempt: attempt + 1,
          current_head_sha: shas[attempt]
        })
        expect(env.automations.enabled.get('auto-1')).toBe(true)
        expect(env.github.posted.at(-1)?.body).toContain(`bug ${attempt}`)
      } else {
        expect(tick.run).toMatchObject({
          status: 'HUMAN_REVIEW_REQUIRED',
          blocking_reason: 'MAX_ATTEMPTS_EXHAUSTED'
        })
      }
    }
    await expect(submitReviewLoopFix(env.deps, run.run_id, WT)).rejects.toMatchObject({
      code: 'invalid_state'
    })
    expect(env.github.posted).toHaveLength(3)
  })

  it('ignores a stale PASS for the previous head after a fix was submitted', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'NEEDS_FIX'))
    await tickReviewLoop(env.deps, run.run_id, WT)
    await commitFix(env, SHA_2)
    await submitReviewLoopFix(env.deps, run.run_id, WT)
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'PASS'))
    const tick = await tickReviewLoop(env.deps, run.run_id, WT)
    expect(tick.exitCode).toBe(TICK_EXIT.WAITING)
    expect(tick.run.status).toBe('AWAITING_REVIEW')
    expect(tick.notes.join()).toContain('STALE_REVIEW')
  })

  it('re-reading the same review comment never re-dispatches the fix', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'NEEDS_FIX'))
    expect((await tickReviewLoop(env.deps, run.run_id, WT)).exitCode).toBe(TICK_EXIT.EVENT_READY)
    await commitFix(env, SHA_2)
    await submitReviewLoopFix(env.deps, run.run_id, WT)
    const tick = await tickReviewLoop(env.deps, run.run_id, WT)
    expect(tick.exitCode).toBe(TICK_EXIT.WAITING)
    expect(tick.run.processed_reviews.filter((entry) => entry.outcome === 'ACCEPTED')).toHaveLength(
      1
    )
  })

  it('GitHub unavailable never settles the run and is retried on the next tick', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'PASS'))
    env.github.unavailable = true
    const failed = await tickReviewLoop(env.deps, run.run_id, WT)
    expect(failed.exitCode).toBe(TICK_EXIT.ERROR)
    expect(failed.run).toMatchObject({
      status: 'AWAITING_REVIEW',
      resume: { consecutive_errors: 1 }
    })
    env.github.unavailable = false
    expect((await tickReviewLoop(env.deps, run.run_id, WT)).run.status).toBe('PASSED')
  })

  it('reviewer unavailable: keeps waiting, then requires a human after the review timeout', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options({ reviewTimeoutMs: 60 * 60 * 1000 }))
    expect((await tickReviewLoop(env.deps, run.run_id, WT)).run.status).toBe('AWAITING_REVIEW')
    env.advance(61 * 60 * 1000)
    const tick = await tickReviewLoop(env.deps, run.run_id, WT)
    expect(tick.run).toMatchObject({
      status: 'HUMAN_REVIEW_REQUIRED',
      blocking_reason: 'REVIEWER_TIMEOUT'
    })
    expect(tick.exitCode).toBe(TICK_EXIT.EVENT_READY)
  })

  it('head changed externally blocks the run; submit can re-request for the new head', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    env.github.recordPush(SLUG, 'feat/x', SHA_X)
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'PASS'))
    const tick = await tickReviewLoop(env.deps, run.run_id, WT)
    expect(tick.run).toMatchObject({
      status: 'BLOCKED',
      blocking_reason: 'HEAD_CHANGED_EXTERNALLY'
    })
    await commitFix(env, SHA_X)
    const resubmitted = await submitReviewLoopFix(env.deps, run.run_id, WT)
    expect(resubmitted.run).toMatchObject({
      status: 'AWAITING_REVIEW',
      attempt: 2,
      current_head_sha: SHA_X
    })
  })

  it('restart recovery: a crash after persisting a new attempt re-posts its request on the next tick', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    const store = new ReviewLoopStateStore(env.git.commonDirPath)
    const crashed = { ...store.load(run.run_id), requests: [] }
    store.save(crashed)
    const fresh = createFakeEnvironment()
    Object.assign(fresh.deps, { git: env.git, github: env.github, automations: env.automations })
    const tick = await tickReviewLoop(fresh.deps, run.run_id, WT)
    expect(tick.run.requests).toHaveLength(1)
    // The original request comment is found by its marker instead of being posted twice.
    expect(env.github.posted).toHaveLength(1)
  })

  it('parallel runs on two PRs never receive each other’s verdicts', async () => {
    const env = setup()
    env.git.addWorktree('/work/repo-b', 'feat/y', SHA_2, { fork: `https://github.com/${SLUG}.git` })
    const a = (await startReviewLoop(env.deps, options())).run
    const b = (await startReviewLoop(env.deps, options({ cwd: '/work/repo-b' }))).run
    expect(b.pr.number).toBe(2)
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(b.run_id, SHA_2, 'PASS'))
    env.github.addComment(SLUG, 2, 'chatgpt-reviewer', verdict(a.run_id, SHA_1, 'PASS'))
    expect((await tickReviewLoop(env.deps, a.run_id, WT)).run.status).toBe('AWAITING_REVIEW')
    expect((await tickReviewLoop(env.deps, b.run_id, '/work/repo-b')).run.status).toBe(
      'AWAITING_REVIEW'
    )
    env.github.addComment(SLUG, 2, 'chatgpt-reviewer', verdict(b.run_id, SHA_2, 'NEEDS_FIX'))
    expect((await tickReviewLoop(env.deps, a.run_id, WT)).run.status).toBe('AWAITING_REVIEW')
    expect((await tickReviewLoop(env.deps, b.run_id, '/work/repo-b')).run.status).toBe('NEEDS_FIX')
  })

  it('declared local-only artifacts turn a PASS into LOCAL_REVIEW_REQUIRED', async () => {
    const env = setup()
    const { run } = await startReviewLoop(
      env.deps,
      options({ localArtifacts: ['config/prod.env'] })
    )
    expect(env.github.posted[0].body).toContain('config/prod.env')
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'PASS'))
    expect((await tickReviewLoop(env.deps, run.run_id, WT)).run.status).toBe(
      'LOCAL_REVIEW_REQUIRED'
    )
  })

  it('manual resume: wait returns at the first event; automation runs refuse in-session polling', async () => {
    const env = setup()
    env.automations.failCreate = true
    const { run, warnings } = await startReviewLoop(env.deps, options())
    expect(run.orca.resume_mode).toBe('manual')
    expect(warnings[0]).toContain('Automatic resume is off')
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'PASS'))
    const waited = await waitReviewLoop(env.deps, run.run_id, WT, {
      timeoutMs: 600_000,
      intervalMs: 60_000
    })
    expect(waited.exitCode).toBe(TICK_EXIT.EVENT_READY)

    const other = setup()
    const auto = (await startReviewLoop(other.deps, options())).run
    await expect(
      waitReviewLoop(other.deps, auto.run_id, WT, { timeoutMs: 1000, intervalMs: 1000 })
    ).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('tells manual runs to keep polling and automation runs to end the turn', async () => {
    const manualEnv = setup()
    const manual = (await startReviewLoop(manualEnv.deps, options({ resume: 'manual' }))).run
    const auto = (await startReviewLoop(setup().deps, options())).run
    const manualText = buildNextStep(manual, manualEnv.deps.cli).instructions.join(' ')
    expect(manualText).toContain(`review-loop wait ${manual.run_id}`)
    expect(buildNextStep(auto, manualEnv.deps.cli).instructions.join(' ')).toContain(
      'end your turn'
    )
  })

  it('wait gives up at its timeout without settling anything', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options({ resume: 'manual' }))
    const waited = await waitReviewLoop(env.deps, run.run_id, WT, {
      timeoutMs: 180_000,
      intervalMs: 60_000
    })
    expect(waited.exitCode).toBe(TICK_EXIT.WAITING)
    expect(waited.run.status).toBe('AWAITING_REVIEW')
  })

  it('submit fails without side effects on the run when polling cannot be re-enabled', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'NEEDS_FIX'))
    await tickReviewLoop(env.deps, run.run_id, WT)
    await acknowledgeReviewLoopEvent(env.deps, run.run_id, WT)
    await commitFix(env, SHA_2)
    env.automations.failSetEnabled = true
    await expect(submitReviewLoopFix(env.deps, run.run_id, WT)).rejects.toMatchObject({
      code: 'automation_error'
    })
    const store = new ReviewLoopStateStore(env.git.commonDirPath)
    expect(store.load(run.run_id)).toMatchObject({ status: 'NEEDS_FIX', attempt: 1 })
    expect(env.github.posted).toHaveLength(1)
    env.automations.failSetEnabled = false
    const retried = await submitReviewLoopFix(env.deps, run.run_id, WT)
    expect(retried.run).toMatchObject({ status: 'AWAITING_REVIEW', attempt: 2 })
    expect(env.automations.enabled.get('auto-1')).toBe(true)
  })

  it('a push that lands while comments are fetched blocks instead of accepting a stale PASS', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'PASS'))
    env.github.afterListItems = () => env.github.recordPush(SLUG, 'feat/x', SHA_X)
    const tick = await tickReviewLoop(env.deps, run.run_id, WT)
    expect(tick.run).toMatchObject({
      status: 'BLOCKED',
      blocking_reason: 'HEAD_CHANGED_EXTERNALLY'
    })
  })

  it('reports an incomplete state file as state_corrupt instead of failing mid-command', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    const store = new ReviewLoopStateStore(env.git.commonDirPath)
    const { notification: _dropped, ...broken } = store.load(run.run_id)
    writeFileSync(store.pathFor(run.run_id), JSON.stringify(broken))
    await expect(tickReviewLoop(env.deps, run.run_id, WT)).rejects.toMatchObject({
      code: 'state_corrupt'
    })
  })

  it('concurrent starts on one branch create a single run', async () => {
    const env = setup()
    const results = await Promise.allSettled([
      startReviewLoop(env.deps, options()),
      startReviewLoop(env.deps, options())
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(new ReviewLoopStateStore(env.git.commonDirPath).list()).toHaveLength(1)
    expect(env.automations.created).toHaveLength(1)
  })

  it('stop on an ended run keeps its outcome but silences its pending event', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'PASS'))
    await tickReviewLoop(env.deps, run.run_id, WT)
    const stopped = await stopReviewLoop(env.deps, run.run_id, WT, 'operator')
    expect(stopped.run.status).toBe('PASSED')
    expect(stopped.run.notification?.acknowledged_at).not.toBeNull()
    expect(env.automations.enabled.get('auto-1')).toBe(false)
  })

  it('stop ends the run, disables polling, and later verdicts are ignored', async () => {
    const env = setup()
    const { run } = await startReviewLoop(env.deps, options())
    const stopped = await stopReviewLoop(env.deps, run.run_id, WT, 'superseded')
    expect(stopped.run.status).toBe('STOPPED')
    expect(env.automations.enabled.get('auto-1')).toBe(false)
    env.github.addComment(SLUG, 1, 'chatgpt-reviewer', verdict(run.run_id, SHA_1, 'PASS'))
    expect((await tickReviewLoop(env.deps, run.run_id, WT)).exitCode).toBe(TICK_EXIT.NOTHING_TO_DO)
  })
})
