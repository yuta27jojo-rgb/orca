import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const RUN_FLAGS = ['run', 'worktree']

export const REVIEW_LOOP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['review-loop', 'start'],
    summary: 'Push the current branch, open or reuse its PR, and request an independent review',
    usage:
      'orca review-loop start [--remote <name>] [--base <branch>] [--title <text>] [--body-file <path>] [--trusted-reviewer <login>] [--trusted-app <slug>] [--local-artifact <path>] [--resume auto|automation|manual] [--provider <agent>] [--poll-schedule <cron>] [--review-timeout-hours <n>] [--worktree <path>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'remote',
      'base',
      'title',
      'body-file',
      'trusted-reviewer',
      'trusted-app',
      'local-artifact',
      'resume',
      'provider',
      'poll-schedule',
      'review-timeout-hours',
      'worktree'
    ],
    repeatableFlags: ['trusted-reviewer', 'trusted-app', 'local-artifact'],
    notes: [
      'Commit and test first: uncommitted tracked changes are refused because the reviewer only sees the pushed commit.',
      'The PR is opened in the repository of --remote (never its upstream parent). The loop never merges or force-pushes.',
      'A review is accepted only from a PR comment holding a valid GPT_REVIEW_V1 block whose run_id and full head_sha match, written by a trusted reviewer (default: the authenticated gh user).',
      '--local-artifact declares critical files GitHub cannot show; a PASS then ends in LOCAL_REVIEW_REQUIRED instead of PASSED.',
      'Inside Orca, --resume auto creates a scheduled automation whose precheck polls GitHub and starts the agent only when a verdict arrives.'
    ],
    examples: [
      'orca review-loop start --remote fork',
      'orca review-loop start --base main --local-artifact config/local.env --json'
    ]
  },
  {
    path: ['review-loop', 'submit'],
    summary: 'Push the fix for NEEDS_FIX findings and request the next review attempt',
    usage: 'orca review-loop submit <run> [--worktree <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...RUN_FLAGS],
    positionalArgs: ['run'],
    examples: ['orca review-loop submit rl-20261001120000-a1b2c3']
  },
  {
    path: ['review-loop', 'tick'],
    summary: 'Poll GitHub once for the run and hand over at most one new event',
    usage: 'orca review-loop tick <run> [--worktree <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...RUN_FLAGS],
    positionalArgs: ['run'],
    notes: [
      'Exit codes: 0 = an event was dispatched to the agent, 3 = still waiting, 4 = nothing to do, 1 = error.',
      'A dispatched event is re-dispatched after 30 minutes (at most 3 times) until the agent runs `next`.',
      'This is the automation precheck. Use `status` to inspect a run without acknowledging its event.'
    ],
    examples: ['orca review-loop tick rl-20261001120000-a1b2c3 --worktree /path/to/worktree']
  },
  {
    path: ['review-loop', 'wait'],
    summary: 'Poll in-session until the run has an event or the timeout elapses',
    usage:
      'orca review-loop wait <run> [--timeout-ms <ms>] [--interval-ms <ms>] [--worktree <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...RUN_FLAGS, 'timeout-ms', 'interval-ms'],
    positionalArgs: ['run'],
    notes: ['Only for runs started with --resume manual; automation runs are resumed by Orca.'],
    examples: ['orca review-loop wait rl-20261001120000-a1b2c3 --timeout-ms 540000']
  },
  {
    path: ['review-loop', 'next'],
    summary: 'Acknowledge the pending event and print what the agent must do next',
    usage: 'orca review-loop next <run> [--worktree <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...RUN_FLAGS],
    positionalArgs: ['run'],
    examples: ['orca review-loop next rl-20261001120000-a1b2c3']
  },
  {
    path: ['review-loop', 'status'],
    summary: 'Show one run without contacting GitHub',
    usage: 'orca review-loop status <run> [--worktree <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...RUN_FLAGS],
    positionalArgs: ['run'],
    examples: ['orca review-loop status rl-20261001120000-a1b2c3 --json']
  },
  {
    path: ['review-loop', 'list'],
    summary: 'List review-loop runs of this repository',
    usage: 'orca review-loop list [--worktree <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    examples: ['orca review-loop list']
  },
  {
    path: ['review-loop', 'stop'],
    summary: 'End a run and disable its polling automation',
    usage: 'orca review-loop stop <run> [--reason <text>] [--worktree <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...RUN_FLAGS, 'reason'],
    positionalArgs: ['run'],
    examples: ['orca review-loop stop rl-20261001120000-a1b2c3 --reason "superseded"']
  }
]
