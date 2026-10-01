import { describe, expect, it } from 'vitest'
import { evaluateObservation, type ReviewObservation } from './review-loop-transitions'
import type { PullRequestInfo, ReviewItem, ReviewLoopRun } from './review-loop-types'

const RUN_ID = 'rl-20261001090000-000001'
const HEAD = 'a'.repeat(40)
const NOW = new Date('2026-10-01T10:00:00Z')

function run(overrides: Partial<ReviewLoopRun> = {}): ReviewLoopRun {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    repo: { slug: 'me/repo', remote: 'fork' },
    worktree_path: '/w',
    orca: {
      worktree_id: null,
      terminal_handle: null,
      automation_id: null,
      automation_enabled: null,
      resume_mode: 'manual'
    },
    pr: { number: 7, url: 'https://github.com/me/repo/pull/7', base: 'main' },
    branch: 'feat/x',
    current_head_sha: HEAD,
    attempt: 1,
    max_attempts: 3,
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
    trusted_reviewers: ['GPT-Bot'],
    trusted_apps: [],
    local_only_artifacts: [],
    untracked_files: [],
    review_timeout_ms: 24 * 60 * 60 * 1000,
    notification: null,
    timestamps: {
      created_at: '2026-10-01T09:00:00Z',
      updated_at: '2026-10-01T09:00:00Z',
      awaiting_since: '2026-10-01T09:00:00Z',
      last_tick_at: null,
      last_verdict_at: null
    },
    resume: { last_tick_result: null, consecutive_errors: 0, last_error: null },
    ...overrides
  }
}

const pr = (overrides: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 7,
  url: '',
  state: 'OPEN',
  head_sha: HEAD,
  head_ref: 'feat/x',
  base_ref: 'main',
  ...overrides
})

let nextId = 1
function item(body: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  const id = (nextId += 1)
  return {
    id: `issue_comment:${id}`,
    kind: 'issue_comment',
    numeric_id: id,
    author: 'gpt-bot',
    app: null,
    body,
    created_at: '2026-10-01T09:30:00Z',
    updated_at: '2026-10-01T09:30:00Z',
    ...overrides
  }
}

function verdict(
  value: 'PASS' | 'NEEDS_FIX',
  overrides: { run?: string; head?: string } = {}
): string {
  return [
    'GPT_REVIEW_V1',
    `run_id: ${overrides.run ?? RUN_ID}`,
    `head_sha: ${overrides.head ?? HEAD}`,
    `verdict: ${value}`,
    'blocking_findings:',
    value === 'PASS' ? '- none' : '- broken',
    'non_blocking_findings:',
    '- none',
    'final:',
    value
  ].join('\n')
}

const observe = (
  items: ReviewItem[],
  prOverrides: Partial<PullRequestInfo> = {}
): ReviewObservation => ({
  pr: pr(prOverrides),
  items
})

describe('evaluateObservation', () => {
  it('ignores untrusted authors and records them, matching logins case-insensitively', () => {
    const result = evaluateObservation(
      run(),
      observe([item(verdict('PASS'), { author: 'mallory' })]),
      NOW
    )
    expect(result.run.status).toBe('AWAITING_REVIEW')
    expect(result.run.processed_reviews[0].outcome).toBe('UNTRUSTED_AUTHOR')
    expect(evaluateObservation(run(), observe([item(verdict('PASS'))]), NOW).run.status).toBe(
      'PASSED'
    )
  })

  it('requires the GitHub app when trusted apps are configured', () => {
    const strict = run({ trusted_apps: ['chatgpt-connector'] })
    expect(evaluateObservation(strict, observe([item(verdict('PASS'))]), NOW).run.status).toBe(
      'AWAITING_REVIEW'
    )
    const viaApp = item(verdict('PASS'), { app: 'chatgpt-connector' })
    expect(evaluateObservation(strict, observe([viaApp]), NOW).run.status).toBe('PASSED')
  })

  it('accepts a verdict submitted as a PR review body', () => {
    const review = item(verdict('NEEDS_FIX'), { kind: 'review', id: 'review:5' })
    const result = evaluateObservation(run(), observe([review]), NOW)
    expect(result.run).toMatchObject({ status: 'NEEDS_FIX', last_processed_review_id: 'review:5' })
  })

  it('ignores verdicts addressed to another run without recording them', () => {
    const result = evaluateObservation(
      run(),
      observe([item(verdict('PASS', { run: 'rl-20261001090000-ffffff' }))]),
      NOW
    )
    expect(result.run.status).toBe('AWAITING_REVIEW')
    expect(result.run.processed_reviews).toEqual([])
  })

  it('first valid verdict for a head wins; a later conflicting one is a duplicate', () => {
    const result = evaluateObservation(
      run(),
      observe([item(verdict('NEEDS_FIX')), item(verdict('PASS'))]),
      NOW
    )
    expect(result.run.status).toBe('NEEDS_FIX')
    const again = evaluateObservation(
      { ...result.run, status: 'AWAITING_REVIEW' },
      observe([item(verdict('PASS'))]),
      NOW
    )
    expect(again.run.processed_reviews.at(-1)?.outcome).toBe('DUPLICATE_REVIEW')
    expect(again.run.status).toBe('AWAITING_REVIEW')
  })

  it('re-evaluates a malformed comment once it is edited into a valid verdict', () => {
    const broken = item(verdict('PASS').replace('final:\nPASS', 'final:\nNEEDS_FIX'))
    const first = evaluateObservation(run(), observe([broken]), NOW)
    expect(first.run.processed_reviews[0].outcome).toBe('MALFORMED_REVIEW')
    expect(
      evaluateObservation(first.run, observe([broken]), NOW).run.processed_reviews
    ).toHaveLength(1)
    const edited = { ...broken, body: verdict('PASS'), updated_at: '2026-10-01T09:45:00Z' }
    expect(evaluateObservation(first.run, observe([edited]), NOW).run.status).toBe('PASSED')
  })

  it('blocks when the PR is closed or merged', () => {
    const result = evaluateObservation(
      run(),
      observe([item(verdict('PASS'))], { state: 'MERGED' }),
      NOW
    )
    expect(result.run).toMatchObject({ status: 'BLOCKED', blocking_reason: 'PR_NOT_OPEN' })
  })

  it('never applies an observation for a different PR', () => {
    expect(() => evaluateObservation(run(), observe([], { number: 8 }), NOW)).toThrow(/PR #8/)
  })

  it('does not consume reviews while a fix is in progress or after the run ended', () => {
    for (const status of ['NEEDS_FIX', 'PASSED', 'STOPPED', 'BLOCKED'] as const) {
      const result = evaluateObservation(run({ status }), observe([item(verdict('PASS'))]), NOW)
      expect(result.run.status).toBe(status)
      expect(result.run.processed_reviews).toEqual([])
    }
  })

  it('queues exactly one undelivered notification per transition', () => {
    const result = evaluateObservation(run(), observe([item(verdict('PASS'))]), NOW)
    expect(result.run.notification).toMatchObject({
      status: 'PASSED',
      head_sha: HEAD,
      dispatch_count: 0,
      acknowledged_at: null
    })
  })
})
