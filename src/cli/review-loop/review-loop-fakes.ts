import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationSpec, ReviewLoopAutomations } from './review-loop-automation'
import type { ReviewLoopDeps } from './review-loop-deps'
import type { ReviewLoopGit, WorkingTreeState } from './review-loop-git'
import type { ReviewLoopGitHub } from './review-loop-github'
import { ReviewLoopError, type PullRequestInfo, type ReviewItem } from './review-loop-types'

/** In-memory GitHub used by review-loop tests; one instance can hold several repos and PRs. */
export class FakeGitHub implements ReviewLoopGitHub {
  login = 'author'
  unavailable = false
  prs: (PullRequestInfo & { slug: string })[] = []
  items = new Map<string, ReviewItem[]>()
  posted: { slug: string; prNumber: number; body: string }[] = []
  private nextId = 1000
  private clock = Date.parse('2026-10-01T00:00:00Z')

  private guard(): void {
    if (this.unavailable) {
      throw new ReviewLoopError(
        'github_unavailable',
        'gh api failed (GitHub unavailable): connection reset'
      )
    }
  }

  currentLogin = async (): Promise<string> => (this.guard(), this.login)
  defaultBranch = async (): Promise<string> => (this.guard(), 'main')
  findOpenPr = async (slug: string, branch: string): Promise<PullRequestInfo | null> => {
    this.guard()
    return (
      this.prs.find((pr) => pr.slug === slug && pr.head_ref === branch && pr.state === 'OPEN') ??
      null
    )
  }
  createPr = async (slug: string, input: { base: string; head: string }): Promise<void> => {
    this.guard()
    const number = this.prs.length + 1
    this.prs.push({
      slug,
      number,
      url: `https://github.com/${slug}/pull/${number}`,
      state: 'OPEN',
      head_sha: this.pushedHeads.get(`${slug}:${input.head}`) ?? '',
      head_ref: input.head,
      base_ref: input.base
    })
  }
  viewPr = async (slug: string, prNumber: number): Promise<PullRequestInfo> => {
    this.guard()
    const pr = this.prs.find((entry) => entry.slug === slug && entry.number === prNumber)
    if (!pr) {
      throw new ReviewLoopError('github_error', `no PR ${slug}#${prNumber}`)
    }
    return { ...pr }
  }
  /** Runs after comments are read, to simulate GitHub changing mid-poll. */
  afterListItems: (() => void) | null = null

  listReviewItems = async (slug: string, prNumber: number): Promise<ReviewItem[]> => {
    this.guard()
    const items = [...(this.items.get(`${slug}#${prNumber}`) ?? [])]
    this.afterListItems?.()
    return items
  }
  postComment = async (
    slug: string,
    prNumber: number,
    body: string
  ): Promise<{ id: number; url: string }> => {
    this.guard()
    this.posted.push({ slug, prNumber, body })
    const item = this.addComment(slug, prNumber, this.login, body)
    return {
      id: item.numeric_id,
      url: `https://github.com/${slug}/pull/${prNumber}#issuecomment-${item.numeric_id}`
    }
  }

  readonly pushedHeads = new Map<string, string>()

  /** Simulates GitHub moving the PR head after a push. */
  recordPush(slug: string, branch: string, sha: string): void {
    this.pushedHeads.set(`${slug}:${branch}`, sha)
    for (const pr of this.prs) {
      if (pr.slug === slug && pr.head_ref === branch) {
        pr.head_sha = sha
      }
    }
  }

  addComment(
    slug: string,
    prNumber: number,
    author: string,
    body: string,
    options: { app?: string | null; kind?: ReviewItem['kind'] } = {}
  ): ReviewItem {
    this.clock += 60_000
    const numericId = (this.nextId += 1)
    const kind = options.kind ?? 'issue_comment'
    const stamp = new Date(this.clock).toISOString()
    const item: ReviewItem = {
      id: `${kind}:${numericId}`,
      kind,
      numeric_id: numericId,
      author,
      app: options.app ?? null,
      body,
      created_at: stamp,
      updated_at: stamp
    }
    const key = `${slug}#${prNumber}`
    this.items.set(key, [...(this.items.get(key) ?? []), item])
    return item
  }
}

type FakeWorktree = {
  branch: string
  head: string
  tree: WorkingTreeState
  remotes: Record<string, string>
}

export class FakeGit implements ReviewLoopGit {
  readonly worktrees = new Map<string, FakeWorktree>()
  pushes: { worktree: string; remote: string; branch: string; sha: string }[] = []

  constructor(
    private readonly github: FakeGitHub,
    readonly commonDirPath: string
  ) {}

  addWorktree(
    path: string,
    branch: string,
    head: string,
    remotes: Record<string, string>
  ): FakeWorktree {
    const worktree = { branch, head, tree: { trackedChanges: [], untrackedFiles: [] }, remotes }
    this.worktrees.set(path, worktree)
    return worktree
  }

  private get(cwd: string): FakeWorktree {
    const worktree = this.worktrees.get(cwd)
    if (!worktree) {
      throw new ReviewLoopError('git_error', `not a worktree: ${cwd}`)
    }
    return worktree
  }

  topLevel = async (cwd: string): Promise<string> => (this.get(cwd), cwd)
  commonDir = async (): Promise<string> => this.commonDirPath
  headSha = async (cwd: string): Promise<string> => this.get(cwd).head
  currentBranch = async (cwd: string): Promise<string> => this.get(cwd).branch
  lastCommitSubject = async (): Promise<string> => 'feat: change'
  workingTree = async (cwd: string): Promise<WorkingTreeState> => this.get(cwd).tree
  remoteUrl = async (cwd: string, remote: string): Promise<string> => {
    const url = this.get(cwd).remotes[remote]
    if (!url) {
      throw new ReviewLoopError('git_error', `no remote ${remote}`)
    }
    return url
  }
  defaultPushRemote = async (cwd: string): Promise<string | null> => {
    const names = Object.keys(this.get(cwd).remotes)
    return names.length === 1 ? names[0] : null
  }
  push = async (cwd: string, remote: string, branch: string): Promise<void> => {
    const worktree = this.get(cwd)
    const slug = /github\.com\/(.+?)(?:\.git)?$/.exec(worktree.remotes[remote] ?? '')?.[1] ?? ''
    this.pushes.push({ worktree: cwd, remote, branch, sha: worktree.head })
    this.github.recordPush(slug, branch, worktree.head)
  }
}

export class FakeAutomations implements ReviewLoopAutomations {
  created: AutomationSpec[] = []
  enabled = new Map<string, boolean>()
  failCreate = false
  failSetEnabled = false

  create = async (spec: AutomationSpec): Promise<string> => {
    if (this.failCreate) {
      throw new ReviewLoopError('automation_error', 'runtime not reachable')
    }
    this.created.push(spec)
    const id = `auto-${this.created.length}`
    this.enabled.set(id, true)
    return id
  }
  setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    if (this.failSetEnabled) {
      throw new ReviewLoopError('automation_error', 'runtime not reachable')
    }
    this.enabled.set(id, enabled)
  }
}

export type FakeEnvironment = {
  deps: ReviewLoopDeps
  github: FakeGitHub
  git: FakeGit
  automations: FakeAutomations
  advance(ms: number): void
}

export function createFakeEnvironment(options: { env?: NodeJS.ProcessEnv } = {}): FakeEnvironment {
  const github = new FakeGitHub()
  const git = new FakeGit(github, mkdtempSync(join(tmpdir(), 'orca-review-loop-')))
  const automations = new FakeAutomations()
  let now = Date.parse('2026-10-01T09:00:00Z')
  let counter = 0
  const deps: ReviewLoopDeps = {
    git,
    github,
    automations,
    cli: { program: '/usr/bin/node', scriptPath: '/opt/orca/out/cli/index.js', electron: false },
    env: options.env ?? { ORCA_WORKTREE_ID: 'wt-1', ORCA_TERMINAL_HANDLE: 'term_1' },
    now: () => new Date(now),
    randomHex: () => (counter += 1).toString(16).padStart(6, '0'),
    sleep: async (ms) => {
      now += ms
    }
  }
  return { deps, github, git, automations, advance: (ms) => (now += ms) }
}
