import { isAbsolute, resolve } from 'node:path'
import { defaultExec, type ReviewLoopExec } from './review-loop-github'
import { ReviewLoopError } from './review-loop-types'

export type WorkingTreeState = {
  /** Tracked paths with staged or unstaged changes; the reviewed commit would not include them. */
  trackedChanges: string[]
  untrackedFiles: string[]
}

export type ReviewLoopGit = {
  topLevel(cwd: string): Promise<string>
  commonDir(cwd: string): Promise<string>
  headSha(cwd: string): Promise<string>
  currentBranch(cwd: string): Promise<string>
  lastCommitSubject(cwd: string): Promise<string>
  workingTree(cwd: string): Promise<WorkingTreeState>
  /** The single push URL of `remote` (its pushurl when set). */
  remoteUrl(cwd: string, remote: string): Promise<string>
  defaultPushRemote(cwd: string, branch: string): Promise<string | null>
  /** Plain fast-forward push of HEAD; never forced. */
  push(cwd: string, remote: string, branch: string): Promise<void>
}

export function createReviewLoopGit(exec: ReviewLoopExec = defaultExec): ReviewLoopGit {
  const git = async (cwd: string, args: string[], timeoutMs?: number): Promise<string> => {
    const result = await exec('git', args, { cwd, timeoutMs })
    if (result.code !== 0 || result.timedOut) {
      throw new ReviewLoopError(
        'git_error',
        `git ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`
      )
    }
    return result.stdout
  }
  const config = async (cwd: string, key: string): Promise<string | null> => {
    const result = await exec('git', ['config', '--get', key], { cwd })
    const value = result.code === 0 ? result.stdout.trim() : ''
    return value.length > 0 ? value : null
  }
  return {
    topLevel: async (cwd) => (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(),
    commonDir: async (cwd) => {
      // Why: --path-format=absolute needs Git 2.31; resolve the possibly-relative answer ourselves.
      const dir = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()
      return isAbsolute(dir) ? dir : resolve(cwd, dir)
    },
    headSha: async (cwd) => (await git(cwd, ['rev-parse', 'HEAD'])).trim().toLowerCase(),
    currentBranch: async (cwd) => {
      const result = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd })
      const branch = result.stdout.trim()
      if (result.code !== 0 || branch.length === 0) {
        throw new ReviewLoopError('git_error', 'HEAD is detached; check out a branch first.')
      }
      return branch
    },
    lastCommitSubject: async (cwd) => (await git(cwd, ['log', '-1', '--format=%s'])).trim(),
    workingTree: async (cwd) => parsePorcelain(await git(cwd, ['status', '--porcelain', '-z'])),
    remoteUrl: async (cwd, remote) => {
      // The PR must live where `git push` writes, which a remote's pushurl can redirect.
      const urls = (await git(cwd, ['remote', 'get-url', '--push', '--all', remote]))
        .split(/\r?\n/)
        .map((url) => url.trim())
        .filter((url) => url.length > 0)
      if (urls.length !== 1) {
        throw new ReviewLoopError(
          'invalid_argument',
          `Remote ${remote} has ${urls.length} push URLs; the review loop needs exactly one.`
        )
      }
      return urls[0]
    },
    defaultPushRemote: async (cwd, branch) => {
      const configured =
        (await config(cwd, `branch.${branch}.pushRemote`)) ??
        (await config(cwd, 'remote.pushDefault')) ??
        (await config(cwd, `branch.${branch}.remote`))
      if (configured && configured !== '.') {
        return configured
      }
      const remotes = (await git(cwd, ['remote'])).split(/\r?\n/).filter((name) => name.length > 0)
      return remotes.length === 1 ? remotes[0] : null
    },
    push: async (cwd, remote, branch) => {
      const result = await exec('git', ['push', remote, `HEAD:refs/heads/${branch}`], {
        cwd,
        timeoutMs: 5 * 60_000
      })
      if (result.code !== 0 || result.timedOut) {
        const detail = (result.stderr || result.stdout).trim().slice(0, 400)
        throw new ReviewLoopError(
          'push_rejected',
          `git push ${remote} ${branch} failed: ${detail}`,
          [
            'The loop never force-pushes. Integrate the remote branch (fetch + merge or rebase onto it) and retry.'
          ]
        )
      }
    }
  }
}

/** Parses `git status --porcelain -z`, which keeps paths with spaces or newlines intact. */
export function parsePorcelain(output: string): WorkingTreeState {
  const trackedChanges: string[] = []
  const untrackedFiles: string[] = []
  const entries = output.split('\0')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.length < 4) {
      continue
    }
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (code === '??') {
      untrackedFiles.push(path)
    } else if (code !== '!!') {
      trackedChanges.push(path)
      if (code.startsWith('R') || code.startsWith('C')) {
        // Renames and copies carry their source path as the next NUL-separated entry.
        index += 1
      }
    }
  }
  return { trackedChanges, untrackedFiles }
}

const GITHUB_REMOTE =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i

/** Returns `owner/name` for a github.com remote URL, or null for any other host. */
export function parseGitHubSlug(remoteUrl: string): string | null {
  const match = GITHUB_REMOTE.exec(remoteUrl.trim())
  return match ? `${match[1]}/${match[2]}` : null
}
