import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/process-spec'
import {
  buildAgentCommand,
  buildPrecheckCommand,
  createCliReviewLoopAutomations,
  type CliInvocation
} from './review-loop-automation'
import { runProcess } from '../../shared/child-process/run-process'
import { createReviewLoopGit, parseGitHubSlug, parsePorcelain } from './review-loop-git'
import {
  classifyGhFailure,
  createGhReviewLoopGitHub,
  type ReviewLoopExec
} from './review-loop-github'

const ok = (stdout: string): ProcessResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})
const fail = (stderr: string): ProcessResult => ({
  code: 1,
  signal: null,
  stdout: '',
  stderr,
  timedOut: false
})

describe('gh adapter', () => {
  it('reads issue comments and reviews, oldest first, with app attribution', async () => {
    const exec: ReviewLoopExec = async (_program, args) => {
      const path = args[2] ?? ''
      if (path.includes('/issues/')) {
        return ok(
          `{"id":2,"login":"me","app":null,"body":"x","created_at":"2026-10-01T10:00:00Z","updated_at":"2026-10-01T10:05:00Z"}\n`
        )
      }
      return ok(
        `{"id":9,"login":"bot","app":"chatgpt","body":"y","created_at":"2026-10-01T09:00:00Z","updated_at":"2026-10-01T09:00:00Z"}\n`
      )
    }
    const items = await createGhReviewLoopGitHub(exec).listReviewItems('me/repo', 3)
    expect(items.map((entry) => [entry.id, entry.app])).toEqual([
      ['review:9', 'chatgpt'],
      ['issue_comment:2', null]
    ])
  })

  it('classifies network, auth and other gh failures', () => {
    expect(
      classifyGhFailure(
        ['api'],
        fail('dial tcp: lookup api.github.com: no such host; could not resolve host')
      ).code
    ).toBe('github_unavailable')
    expect(classifyGhFailure(['api'], { ...fail(''), timedOut: true }).code).toBe(
      'github_unavailable'
    )
    expect(classifyGhFailure(['api'], fail('HTTP 401: Bad credentials')).code).toBe('github_auth')
    expect(classifyGhFailure(['api'], fail('HTTP 422: Validation Failed')).code).toBe(
      'github_error'
    )
  })

  it('parses github.com remotes and rejects other hosts', () => {
    expect(parseGitHubSlug('https://github.com/me/orca.git')).toBe('me/orca')
    expect(parseGitHubSlug('git@github.com:me/orca.git')).toBe('me/orca')
    expect(parseGitHubSlug('ssh://git@github.com/me/orca')).toBe('me/orca')
    expect(parseGitHubSlug('https://gitlab.com/me/orca.git')).toBeNull()
  })

  it('resolves the push URL of a remote, which is where the PR must live', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orca-review-loop-git-'))
    const git = createReviewLoopGit()
    const run = (args: string[]) => runProcess({ program: 'git', args, cwd: repo })
    await run(['init', '-q'])
    await run(['remote', 'add', 'origin', 'https://github.com/upstream/repo.git'])
    await run(['remote', 'set-url', '--push', 'origin', 'https://github.com/me/repo.git'])
    expect(parseGitHubSlug(await git.remoteUrl(repo, 'origin'))).toBe('me/repo')
    await run(['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/me/other.git'])
    await expect(git.remoteUrl(repo, 'origin')).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('splits porcelain output into tracked changes and untracked files', () => {
    expect(parsePorcelain(' M src/a.ts\0R  new.ts\0old.ts\0?? notes with space.txt\0')).toEqual({
      trackedChanges: ['src/a.ts', 'new.ts'],
      untrackedFiles: ['notes with space.txt']
    })
  })
})

describe('automation commands', () => {
  const node: CliInvocation = {
    program: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'D:\\orca\\out\\cli\\index.js',
    electron: false
  }
  const electron: CliInvocation = {
    program: '/Applications/Orca.app/Contents/MacOS/Orca',
    scriptPath: '/x/cli/index.js',
    electron: true
  }

  it('builds a cmd.exe precheck that pins this CLI build', () => {
    expect(buildPrecheckCommand(node, 'rl-20261001090000-000001', 'D:\\my repo', 'win32')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "D:\\orca\\out\\cli\\index.js" review-loop tick --run rl-20261001090000-000001 --worktree "D:\\my repo"'
    )
  })

  it('runs packaged Electron in node mode and lets resumed agents use orca on PATH', () => {
    expect(buildPrecheckCommand(electron, 'rl-20261001090000-000001', '/w', 'darwin')).toMatch(
      /^ELECTRON_RUN_AS_NODE=1 /
    )
    expect(buildPrecheckCommand(electron, 'rl-20261001090000-000001', '/w', 'win32')).toMatch(
      /^set "ELECTRON_RUN_AS_NODE=1" && /
    )
    expect(buildAgentCommand(electron, ['review-loop', 'next', 'rl-1'], 'darwin')).toBe(
      'orca review-loop next rl-1'
    )
  })

  it('never puts a quote in the agent command when node is on PATH, even for a spaced Windows path', () => {
    const spaced: CliInvocation = {
      program: String.raw`C:\Program Files\nodejs\node.exe`,
      scriptPath: String.raw`D:\orca\out\cli\index.js`,
      electron: false
    }
    const command = buildAgentCommand(
      spaced,
      ['review-loop', 'next', 'rl-1', '--worktree', String.raw`D:\orca`],
      'win32',
      () => true
    )
    expect(command).toBe('node D:/orca/out/cli/index.js review-loop next rl-1 --worktree D:/orca')
    expect(command).not.toMatch(/["'`]/)
  })

  it('falls back to a quoted command only when nothing else can address the program', () => {
    const spaced: CliInvocation = {
      program: String.raw`C:\Program Files\nodejs\node.exe`,
      scriptPath: String.raw`D:\orca\out\cli\index.js`,
      electron: false
    }
    expect(buildAgentCommand(spaced, ['review-loop', 'next', 'rl-1'], 'win32', () => false)).toBe(
      '"C:/Program Files/nodejs/node.exe" D:/orca/out/cli/index.js review-loop next rl-1'
    )
  })

  it('creates the automation through the public CLI and reads its id', async () => {
    const calls: string[][] = []
    const exec: ReviewLoopExec = async (_program, args) => {
      calls.push([...args])
      return ok(JSON.stringify({ id: 'x', ok: true, result: { automation: { id: 'auto-42' } } }))
    }
    const automations = createCliReviewLoopAutomations(node, exec)
    const id = await automations.create({
      worktreePath: '/w',
      name: 'n',
      prompt: 'p',
      precheck: 'c',
      provider: 'claude',
      schedule: '*/10 * * * *'
    })
    expect(id).toBe('auto-42')
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        'automations',
        'create',
        '--reuse-session',
        '--precheck',
        'c',
        '--json'
      ])
    )
    await automations.setEnabled('auto-42', false, '/w')
    expect(calls[1]).toEqual([
      node.scriptPath,
      'automations',
      'edit',
      'auto-42',
      '--disabled',
      '--json'
    ])
  })
})

describe('runtime independence', () => {
  const dir = __dirname
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => [name, readFileSync(join(dir, name), 'utf-8')] as const)
    .concat([
      [
        'handlers/review-loop.ts',
        readFileSync(join(dir, '..', 'handlers', 'review-loop.ts'), 'utf-8')
      ]
    ])

  it.each(sources)(
    '%s has no AI-Harness, OpenAI API, or local-reviewer dependency',
    (_name, source) => {
      expect(source).not.toMatch(
        /ai[-_ ]?harness|harness\.|review\.ps1|openai|OPENAI_API_KEY|api\.openai\.com|antigravity|\bagy\b|codex/i
      )
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])
      for (const specifier of imports) {
        expect(specifier.startsWith('.') || specifier.startsWith('node:')).toBe(true)
        expect(specifier).not.toMatch(/\/main\//)
      }
    }
  )
})
