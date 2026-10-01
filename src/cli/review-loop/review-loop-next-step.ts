import { buildAgentCommand, type CliInvocation } from './review-loop-automation'
import type { ReviewLoopRun } from './review-loop-types'

export type NextAction =
  | 'WAIT_FOR_REVIEW'
  | 'FIX_BLOCKING_FINDINGS'
  | 'REPORT_PASS'
  | 'LOCAL_REVIEW'
  | 'STOP_AND_REPORT'
  | 'INSPECT_BLOCKED'
  | 'NONE'

export type NextStep = {
  run_id: string
  pr: string
  status: ReviewLoopRun['status']
  attempt: string
  reviewed_head_sha: string
  action: NextAction
  blocking_findings: string[]
  non_blocking_findings: string[]
  instructions: string[]
}

/** The agent-facing contract for one run: what happened and exactly what to do next. */
export function buildNextStep(run: ReviewLoopRun, cli: CliInvocation): NextStep {
  const submit = buildAgentCommand(cli, ['review-loop', 'submit', run.run_id])
  // Only an automation resumes the agent; a manual run must keep polling itself.
  const afterSubmit =
    run.orca.resume_mode === 'automation' && run.orca.automation_id
      ? 'Then end your turn; Orca resumes you when the next review arrives.'
      : `Then poll with \`${buildAgentCommand(cli, ['review-loop', 'wait', run.run_id])}\` (repeat while it reports WAITING) and run next again when it returns an event.`
  const base = {
    run_id: run.run_id,
    pr: `${run.repo.slug}#${run.pr.number} (${run.pr.url})`,
    status: run.status,
    attempt: `${run.attempt}/${run.max_attempts}`,
    reviewed_head_sha: run.current_head_sha,
    blocking_findings: run.blocking_findings,
    non_blocking_findings: run.non_blocking_findings
  }
  const guardrails = [
    'Never post a GPT_REVIEW_V1 verdict yourself; your own review is not the independent review.',
    'Never merge, force-push, amend or rebase reviewed commits.'
  ]
  switch (run.status) {
    case 'NEEDS_FIX':
      return {
        ...base,
        action: 'FIX_BLOCKING_FINDINGS',
        instructions: [
          'Fix every blocking finding, and only those. Stay inside the scope of this PR; do not refactor unrelated code.',
          'Non-blocking findings are informational; leave them unless a blocking fix touches the same lines.',
          'Run the tests relevant to the change. Commit only when they pass.',
          'Add new commits on the same branch.',
          `Then run \`${submit}\` to push and request attempt ${run.attempt + 1}/${run.max_attempts}.`,
          afterSubmit,
          ...guardrails
        ]
      }
    case 'PASSED':
      return {
        ...base,
        action: 'REPORT_PASS',
        instructions: [
          `The independent review gate passed for ${run.current_head_sha}. Report this to the user with the PR link.`,
          'PASS does not merge anything; merging follows the project policy and the user decision.',
          'Do not change code for non-blocking findings unless the user asks.',
          ...guardrails
        ]
      }
    case 'LOCAL_REVIEW_REQUIRED':
      return {
        ...base,
        action: 'LOCAL_REVIEW',
        instructions: [
          'The GitHub reviewer passed the commit but could not see these local-only artifacts:',
          ...run.local_only_artifacts.map((path) => `  - ${path}`),
          "Do not treat them as reviewed. Report to the user and use the project's local review process (for example an existing local reviewer) for them.",
          ...guardrails
        ]
      }
    case 'HUMAN_REVIEW_REQUIRED':
      return {
        ...base,
        action: 'STOP_AND_REPORT',
        instructions: [
          `Automatic fixing stopped: ${run.blocking_reason ?? 'unknown'} (${run.blocking_detail ?? ''}).`,
          'Do not modify code. Report the run state, the PR link and any blocking findings to the user.',
          ...guardrails
        ]
      }
    case 'BLOCKED':
      return {
        ...base,
        action: 'INSPECT_BLOCKED',
        instructions: blockedInstructions(run, submit).concat(guardrails)
      }
    case 'AWAITING_REVIEW':
      return {
        ...base,
        action: 'WAIT_FOR_REVIEW',
        instructions: [`Waiting for an independent review of ${run.current_head_sha}.`, afterSubmit]
      }
    case 'STOPPED':
      return { ...base, action: 'NONE', instructions: ['This run was stopped. Nothing to do.'] }
  }
}

function blockedInstructions(run: ReviewLoopRun, submit: string): string[] {
  if (run.blocking_reason === 'HEAD_CHANGED_EXTERNALLY') {
    return [
      `The PR head moved outside the loop: ${run.blocking_detail ?? ''}. Any review of the old head is stale.`,
      'Do not change code yet. Report to the user. If they confirm the new commits belong in this PR,',
      `sync the branch (fetch + fast-forward), then run \`${submit}\` to request a review of the new head (uses one attempt).`
    ]
  }
  return [
    `The loop is blocked: ${run.blocking_reason ?? 'unknown'} (${run.blocking_detail ?? ''}).`,
    'Do not change code. Report to the user.'
  ]
}

export function formatNextStep(step: NextStep): string {
  const lines = [
    'REVIEW_LOOP_NEXT_V1',
    `run_id: ${step.run_id}`,
    `pr: ${step.pr}`,
    `status: ${step.status}`,
    `attempt: ${step.attempt}`,
    `reviewed_head_sha: ${step.reviewed_head_sha}`,
    `action: ${step.action}`
  ]
  if (step.blocking_findings.length > 0) {
    lines.push(
      '',
      'blocking_findings:',
      ...step.blocking_findings.map((item, index) => `${index + 1}. ${item}`)
    )
  }
  if (step.non_blocking_findings.length > 0) {
    lines.push(
      '',
      'non_blocking_findings:',
      ...step.non_blocking_findings.map((item) => `- ${item}`)
    )
  }
  lines.push('', 'instructions:', ...step.instructions.map((item) => `- ${item}`))
  return lines.join('\n')
}

export function formatRunStatus(run: ReviewLoopRun): string {
  const lines = [
    `${run.run_id}  ${run.status}  attempt ${run.attempt}/${run.max_attempts}`,
    `  pr: ${run.repo.slug}#${run.pr.number} ${run.pr.url}`,
    `  branch: ${run.branch}  head: ${run.current_head_sha}`,
    `  resume: ${run.orca.resume_mode}${run.orca.automation_id ? ` (automation ${run.orca.automation_id})` : ''}`,
    `  last tick: ${run.timestamps.last_tick_at ?? 'never'} ${run.resume.last_tick_result ?? ''}`
  ]
  if (run.blocking_reason) {
    lines.push(`  blocking: ${run.blocking_reason} ${run.blocking_detail ?? ''}`)
  }
  if (run.resume.last_error) {
    lines.push(`  last error (${run.resume.consecutive_errors}x): ${run.resume.last_error}`)
  }
  if (run.local_only_artifacts.length > 0) {
    lines.push(`  local-only artifacts: ${run.local_only_artifacts.join(', ')}`)
  }
  return lines.join('\n')
}
