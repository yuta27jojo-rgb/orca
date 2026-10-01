import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { isReviewLoopRun, RUN_ID_PATTERN } from './review-loop-run-validation'
import { ReviewLoopError, type ReviewLoopRun } from './review-loop-types'

// Why: a crashed holder must not wedge the run forever, but a slow `submit` push can take minutes.
const STALE_LOCK_MS = 15 * 60 * 1000

/**
 * Durable per-repository run store. Lives under the git common dir so every worktree of the
 * repository (and an automation precheck running from the repo root) sees the same runs, and
 * nothing in it is ever committed or pushed.
 */
export class ReviewLoopStateStore {
  readonly runsDir: string

  constructor(gitCommonDir: string) {
    this.runsDir = join(gitCommonDir, 'orca-review-loop', 'runs')
  }

  static assertRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new ReviewLoopError('invalid_argument', `Invalid review-loop run id: ${runId}`)
    }
  }

  pathFor(runId: string): string {
    ReviewLoopStateStore.assertRunId(runId)
    return join(this.runsDir, `${runId}.json`)
  }

  load(runId: string): ReviewLoopRun {
    const path = this.pathFor(runId)
    if (!existsSync(path)) {
      throw new ReviewLoopError('not_found', `No review-loop run ${runId} in ${this.runsDir}`, [
        'List runs with `orca review-loop list`.'
      ])
    }
    return parseRun(readFileSync(path, 'utf-8'), path)
  }

  save(run: ReviewLoopRun): void {
    writeDurableSecureJsonFile(this.pathFor(run.run_id), run)
  }

  list(): ReviewLoopRun[] {
    if (!existsSync(this.runsDir)) {
      return []
    }
    const runs: ReviewLoopRun[] = []
    for (const name of readdirSync(this.runsDir)) {
      const runId = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null
      if (!runId || !RUN_ID_PATTERN.test(runId)) {
        continue
      }
      try {
        runs.push(this.load(runId))
      } catch {
        // A corrupt file is reported by `status --run`; listing stays usable.
      }
    }
    return runs.sort((a, b) => a.timestamps.created_at.localeCompare(b.timestamps.created_at))
  }

  /** Serializes mutations of one run across processes (automation precheck vs. agent). */
  withLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    return this.withLockFile(`${this.pathFor(runId)}.lock`, action)
  }

  /**
   * Serializes run creation for one repository branch, so two concurrent `start` commands cannot
   * both pass the active-run check and launch two loops editing the same worktree.
   */
  withBranchLock<T>(slug: string, branch: string, action: () => Promise<T>): Promise<T> {
    const key = createHash('sha256')
      .update(JSON.stringify([slug, branch]))
      .digest('hex')
      .slice(0, 24)
    return this.withLockFile(join(this.runsDir, `branch-${key}.lock`), action)
  }

  private async withLockFile<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
    mkdirSync(this.runsDir, { recursive: true })
    acquireLock(lockPath)
    try {
      return await action()
    } finally {
      rmSync(lockPath, { force: true })
    }
  }
}

function acquireLock(lockPath: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }))
      closeSync(fd)
      return
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error
      }
      if (attempt === 0 && isStaleLock(lockPath)) {
        rmSync(lockPath, { force: true })
        continue
      }
    }
  }
  throw new ReviewLoopError(
    'state_locked',
    `Another review-loop process is updating this run (${lockPath}).`,
    ['Retry after the other `orca review-loop` command finishes.']
  )
}

function isStaleLock(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS
  } catch {
    return true
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

export function parseRun(contents: string, sourcePath: string): ReviewLoopRun {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new ReviewLoopError('state_corrupt', `Review-loop state is not valid JSON: ${sourcePath}`)
  }
  if (!isReviewLoopRun(value)) {
    throw new ReviewLoopError(
      'state_corrupt',
      `Review-loop state has an unsupported shape or schema_version: ${sourcePath}`
    )
  }
  return value
}
