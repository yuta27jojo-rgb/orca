import {
  buildAgentCommand,
  buildPrecheckCommand,
  buildResumePrompt
} from './review-loop-automation'
import {
  newRunId,
  openStore,
  postReviewRequest,
  waitForPrHead,
  type ReviewLoopDeps
} from './review-loop-deps'
import { parseGitHubSlug } from './review-loop-git'
import {
  isTerminalStatus,
  REVIEW_LOOP_DEFAULT_POLL_SCHEDULE,
  REVIEW_LOOP_DEFAULT_REVIEW_TIMEOUT_MS,
  REVIEW_LOOP_MAX_ATTEMPTS,
  REVIEW_LOOP_SCHEMA_VERSION,
  ReviewLoopError,
  type PullRequestInfo,
  type ReviewLoopRun
} from './review-loop-types'
import type { ReviewLoopStateStore } from './review-loop-state-store'

export type StartOptions = {
  cwd: string
  remote?: string
  base?: string
  title?: string
  body?: string
  trustedReviewers: string[]
  trustedApps: string[]
  localArtifacts: string[]
  resume: 'auto' | 'automation' | 'manual'
  provider: string
  schedule?: string
  reviewTimeoutMs?: number
}

export type CommandResult = { run: ReviewLoopRun; warnings: string[] }

export async function startReviewLoop(
  deps: ReviewLoopDeps,
  options: StartOptions
): Promise<CommandResult> {
  const worktree = await deps.git.topLevel(options.cwd)
  const branch = await deps.git.currentBranch(worktree)
  const tree = await deps.git.workingTree(worktree)
  assertCleanTrackedTree(tree.trackedChanges)
  const remote = options.remote ?? (await deps.git.defaultPushRemote(worktree, branch))
  if (!remote) {
    throw new ReviewLoopError('invalid_argument', 'Cannot pick a push remote for this branch.', [
      'Pass --remote <name> naming the GitHub repository that should own the PR (for a fork, your fork remote).'
    ])
  }
  const slug = parseGitHubSlug(await deps.git.remoteUrl(worktree, remote))
  if (!slug) {
    throw new ReviewLoopError(
      'invalid_argument',
      `Remote ${remote} is not a github.com repository; the review loop currently supports GitHub only.`
    )
  }
  const login = await deps.github.currentLogin()
  const base = options.base ?? (await deps.github.defaultBranch(slug))
  if (branch === base) {
    throw new ReviewLoopError('invalid_argument', `Refusing to run on the base branch ${base}.`, [
      'Create a feature branch for the change first.'
    ])
  }
  const store = await openStore(deps, worktree)
  return store.withBranchLock(slug, branch, async () => {
    const active = store
      .list()
      .find(
        (run) => !isTerminalStatus(run.status) && run.repo.slug === slug && run.branch === branch
      )
    if (active) {
      throw new ReviewLoopError(
        'invalid_state',
        `Run ${active.run_id} is already active for ${branch}.`,
        [
          `Continue it with \`orca review-loop status ${active.run_id}\`, or end it with \`orca review-loop stop ${active.run_id}\`.`
        ]
      )
    }

    const headSha = await deps.git.headSha(worktree)
    await deps.git.push(worktree, remote, branch)
    let pr = await deps.github.findOpenPr(slug, branch)
    if (!pr) {
      await deps.github.createPr(slug, {
        base,
        head: branch,
        title: options.title ?? (await deps.git.lastCommitSubject(worktree)),
        body: options.body ?? defaultPrBody()
      })
      pr = await deps.github.findOpenPr(slug, branch)
    }
    if (!pr) {
      throw new ReviewLoopError(
        'github_error',
        `Created a PR for ${branch} but could not find it again.`
      )
    }
    pr = await waitForPrHead(deps, slug, pr.number, headSha)

    const run = buildInitialRun(deps, options, {
      slug,
      remote,
      worktree,
      branch,
      base,
      login,
      headSha,
      pr,
      untracked: tree.untrackedFiles
    })
    return persistAndRequest(deps, store, run, options)
  })
}

function buildInitialRun(
  deps: ReviewLoopDeps,
  options: StartOptions,
  context: {
    slug: string
    remote: string
    worktree: string
    branch: string
    base: string
    login: string
    headSha: string
    pr: PullRequestInfo
    untracked: string[]
  }
): ReviewLoopRun {
  const { slug, remote, worktree, branch, base, login, headSha, pr } = context
  const now = deps.now()
  const nowIso = now.toISOString()
  const runId = newRunId(now, deps.randomHex())
  const resumeMode = resolveResumeMode(options.resume, deps.env)
  return {
    schema_version: REVIEW_LOOP_SCHEMA_VERSION,
    run_id: runId,
    repo: { slug, remote },
    worktree_path: worktree,
    orca: {
      worktree_id: deps.env.ORCA_WORKTREE_ID ?? null,
      terminal_handle: deps.env.ORCA_TERMINAL_HANDLE ?? null,
      automation_id: null,
      automation_enabled: null,
      resume_mode: resumeMode
    },
    pr: { number: pr.number, url: pr.url, base: pr.base_ref || base },
    branch,
    current_head_sha: headSha,
    attempt: 1,
    max_attempts: REVIEW_LOOP_MAX_ATTEMPTS,
    status: 'AWAITING_REVIEW',
    verdict: null,
    blocking_reason: null,
    blocking_detail: null,
    blocking_findings: [],
    non_blocking_findings: [],
    last_processed_review_id: null,
    processed_reviews: [],
    requests: [],
    attempts_history: [],
    trusted_reviewers: options.trustedReviewers.length > 0 ? options.trustedReviewers : [login],
    trusted_apps: options.trustedApps,
    local_only_artifacts: options.localArtifacts,
    untracked_files: context.untracked,
    review_timeout_ms: options.reviewTimeoutMs ?? REVIEW_LOOP_DEFAULT_REVIEW_TIMEOUT_MS,
    notification: null,
    timestamps: {
      created_at: nowIso,
      updated_at: nowIso,
      awaiting_since: nowIso,
      last_tick_at: null,
      last_verdict_at: null
    },
    resume: { last_tick_result: null, consecutive_errors: 0, last_error: null }
  }
}

async function persistAndRequest(
  deps: ReviewLoopDeps,
  store: ReviewLoopStateStore,
  initial: ReviewLoopRun,
  options: StartOptions
): Promise<CommandResult> {
  let run = initial
  const runId = run.run_id
  const warnings: string[] = []
  return store.withLock(runId, async () => {
    // Why: persist before any GitHub write so a crash leaves a resumable run, not an orphan comment.
    store.save(run)
    if (run.orca.resume_mode === 'automation') {
      // Created before the request is posted: if posting fails, the automation's tick re-posts it.
      try {
        const automationId = await createAutomation(deps, run, options)
        run = {
          ...run,
          orca: { ...run.orca, automation_id: automationId, automation_enabled: true }
        }
      } catch (error) {
        run = { ...run, orca: { ...run.orca, resume_mode: 'manual' } }
        warnings.push(
          `Automatic resume is off: ${error instanceof Error ? error.message : String(error)}. Poll with \`orca review-loop wait ${runId}\`.`
        )
      }
      store.save(run)
    }
    run = await postReviewRequest(deps, run, [])
    store.save(run)
    return { run, warnings }
  })
}

function createAutomation(
  deps: ReviewLoopDeps,
  run: ReviewLoopRun,
  options: StartOptions
): Promise<string> {
  return deps.automations.create({
    worktreePath: run.worktree_path,
    name: `Review loop ${run.repo.slug}#${run.pr.number} (${run.run_id})`,
    prompt: buildResumePrompt({
      runId: run.run_id,
      prNumber: run.pr.number,
      repoSlug: run.repo.slug,
      nextCommand: buildAgentCommand(deps.cli, [
        'review-loop',
        'next',
        run.run_id,
        '--worktree',
        run.worktree_path
      ])
    }),
    precheck: buildPrecheckCommand(deps.cli, run.run_id, run.worktree_path),
    provider: options.provider,
    schedule: options.schedule ?? REVIEW_LOOP_DEFAULT_POLL_SCHEDULE
  })
}

function resolveResumeMode(
  requested: StartOptions['resume'],
  env: NodeJS.ProcessEnv
): 'automation' | 'manual' {
  if (requested !== 'auto') {
    return requested
  }
  // Automations need a running Orca; a terminal outside Orca polls with `wait` instead.
  return env.ORCA_WORKTREE_ID ? 'automation' : 'manual'
}

export function assertCleanTrackedTree(trackedChanges: string[]): void {
  if (trackedChanges.length > 0) {
    throw new ReviewLoopError(
      'working_tree_dirty',
      `Uncommitted tracked changes would not be part of the reviewed commit: ${trackedChanges.slice(0, 10).join(', ')}`,
      ['Run the tests, commit the change, then retry.']
    )
  }
}

function defaultPrBody(): string {
  return [
    'Opened by the Orca review loop for an independent review.',
    '',
    'The review request and verdicts are exchanged as PR comments. This loop never merges.'
  ].join('\n')
}
