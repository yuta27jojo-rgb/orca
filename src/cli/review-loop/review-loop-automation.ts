import { defaultExec, type ReviewLoopExec } from './review-loop-github'
import { ReviewLoopError } from './review-loop-types'

/** How to re-run this same CLI build: the precheck and the agent must use the binary that owns the run. */
export type CliInvocation = {
  program: string
  scriptPath: string
  /** Packaged Orca runs the CLI with Electron in node mode, which needs ELECTRON_RUN_AS_NODE. */
  electron: boolean
}

export function currentCliInvocation(): CliInvocation {
  return {
    program: process.execPath,
    scriptPath: process.argv[1] ?? '',
    electron: Boolean(process.versions.electron)
  }
}

export function quoteForShell(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9._:/@=-]+$/.test(value)) {
    return value
  }
  if (platform === 'win32') {
    // cmd.exe cannot escape `"` or `%` inside quotes; such values are rejected instead of mangled.
    if (/["%]/.test(value)) {
      throw new ReviewLoopError('invalid_argument', `Cannot quote a value for cmd.exe: ${value}`)
    }
    return `"${value}"`
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

function cliCommandLine(
  invocation: CliInvocation,
  args: string[],
  platform: NodeJS.Platform
): string {
  const command = [invocation.program, invocation.scriptPath, ...args]
    .map((part) => quoteForShell(part, platform))
    .join(' ')
  if (!invocation.electron) {
    return command
  }
  return platform === 'win32'
    ? `set "ELECTRON_RUN_AS_NODE=1" && ${command}`
    : `ELECTRON_RUN_AS_NODE=1 ${command}`
}

/** The automation precheck: a cheap, deterministic GitHub poll that only lets the agent start on a new event. */
export function buildPrecheckCommand(
  invocation: CliInvocation,
  runId: string,
  worktreePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  return cliCommandLine(
    invocation,
    ['review-loop', 'tick', '--run', runId, '--worktree', worktreePath],
    platform
  )
}

/** Command the resumed agent types; packaged builds are on PATH as `orca` inside Orca terminals. */
export function buildAgentCommand(
  invocation: CliInvocation,
  args: string[],
  platform: NodeJS.Platform = process.platform
): string {
  if (invocation.electron) {
    return ['orca', ...args].map((part) => quoteForShell(part, platform)).join(' ')
  }
  return cliCommandLine(invocation, args, platform)
}

export function buildResumePrompt(input: {
  runId: string
  prNumber: number
  repoSlug: string
  nextCommand: string
}): string {
  return [
    `Orca review loop ${input.runId} (${input.repoSlug} PR #${input.prNumber}) has a new independent-review event.`,
    `Run \`${input.nextCommand}\` and follow its instructions exactly.`,
    'Do not merge, do not force-push, and never post a GPT_REVIEW_V1 verdict yourself.'
  ].join(' ')
}

export type AutomationSpec = {
  worktreePath: string
  name: string
  prompt: string
  precheck: string
  provider: string
  schedule: string
}

/** Orca's scheduled-automation surface, driven through the public `orca automations` commands. */
export type ReviewLoopAutomations = {
  create(spec: AutomationSpec): Promise<string>
  setEnabled(automationId: string, enabled: boolean, worktreePath: string): Promise<void>
}

const PRECHECK_TIMEOUT_SECONDS = '180'

export function createCliReviewLoopAutomations(
  invocation: CliInvocation = currentCliInvocation(),
  exec: ReviewLoopExec = defaultExec
): ReviewLoopAutomations {
  const run = async (args: string[], cwd: string): Promise<Record<string, unknown>> => {
    const result = await exec(invocation.program, [invocation.scriptPath, ...args, '--json'], {
      cwd,
      timeoutMs: 60_000
    })
    const payload = parsePayload(result.stdout)
    if (result.code !== 0 || payload?.ok !== true) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 400)
      throw new ReviewLoopError(
        'automation_error',
        `orca ${args.slice(0, 2).join(' ')} failed: ${detail}`
      )
    }
    return payload
  }
  return {
    create: async (spec) => {
      const payload = await run(
        [
          'automations',
          'create',
          '--name',
          spec.name,
          '--trigger',
          spec.schedule,
          '--prompt',
          spec.prompt,
          '--provider',
          spec.provider,
          '--precheck',
          spec.precheck,
          '--precheck-timeout',
          PRECHECK_TIMEOUT_SECONDS,
          '--reuse-session'
        ],
        spec.worktreePath
      )
      const id = readAutomationId(payload)
      if (!id) {
        throw new ReviewLoopError(
          'automation_error',
          'orca automations create returned no automation id.'
        )
      }
      return id
    },
    setEnabled: async (automationId, enabled, worktreePath) => {
      await run(
        ['automations', 'edit', automationId, enabled ? '--enabled' : '--disabled'],
        worktreePath
      )
    }
  }
}

function parsePayload(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout)
    return typeof value === 'object' && value !== null ? { ...value } : null
  } catch {
    return null
  }
}

function readAutomationId(payload: Record<string, unknown>): string | null {
  const result = payload.result
  if (typeof result !== 'object' || result === null || !('automation' in result)) {
    return null
  }
  const automation = result.automation
  if (typeof automation !== 'object' || automation === null || !('id' in automation)) {
    return null
  }
  return typeof automation.id === 'string' ? automation.id : null
}
