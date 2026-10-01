import { describe, expect, it } from 'vitest'
import { buildReviewRequestComment } from './review-request-comment'
import { isLoopRequestComment, parseReviewContract } from './review-verdict-contract'

const SHA = 'b'.repeat(40)

function request(overrides: { previous?: string[] } = {}): string {
  return buildReviewRequestComment({
    runId: 'rl-20261001090000-000001',
    repoSlug: 'me/repo',
    prNumber: 3,
    headSha: SHA,
    attempt: 2,
    maxAttempts: 3,
    localOnlyArtifacts: [],
    untrackedFiles: [],
    previousBlockingFindings: overrides.previous ?? []
  })
}

describe('review request policy', () => {
  const body = request()

  it('judges against the Definition of Done and an 80% completeness goal', () => {
    expect(body).toContain('**Review policy.**')
    expect(body).toContain('current Definition of Done and Critical Path')
    expect(body).toContain('roughly 80% completeness, not a zero-finding review')
  })

  it('makes Critical and High blocking, Medium conditional, and Low non-blocking', () => {
    expect(body).toContain('- Critical: always blocking.')
    expect(body).toContain('- High: always blocking.')
    expect(body).toContain('- Medium: blocking only if it prevents the current Definition of Done')
    expect(body).toContain('Otherwise it is non-blocking.')
    expect(body).toContain('- Low: non-blocking backlog.')
  })

  it('forbids blocking on speculative, future, stylistic and finding-count grounds', () => {
    for (const reason of [
      'speculative edge cases',
      'future extensibility or preventive hardening',
      'stylistic preference',
      'unnecessary abstraction, broad refactoring',
      'missing exhaustive tests',
      'the goal of bringing the number of findings to zero'
    ]) {
      expect(body).toContain(reason)
    }
    expect(body).toContain('Do NOT choose NEEDS_FIX')
  })

  it('controls scope but allows the minimal fix for Critical or High findings', () => {
    expect(body).toContain('Do not require unrelated refactors, architecture redesign')
    expect(body).toContain('minimal change needed to resolve a Critical or High finding')
  })

  it('defines what PASS means and does not mean, and allows non-blocking findings on PASS', () => {
    expect(body).toContain('Prefer PASS when the main use case works')
    expect(body).toContain('PASS does not mean perfect, future-proof')
    expect(body).toContain('or zero findings')
    expect(body).toContain('PASS may list them')
    expect(body).toContain('Having non-blocking findings is not a reason for NEEDS_FIX')
  })

  it('tells the reviewer which findings go in which section', () => {
    expect(body).toContain(
      '`blocking_findings` holds only Critical, High, and Medium findings that block'
    )
    expect(body).toContain('`non_blocking_findings` holds all other Medium findings, Low findings')
    expect(body).toContain('Prefix each finding with its severity')
  })

  it('keeps the request contract: markers, run identity, verdict template and stale warning', () => {
    expect(body).toContain('GPT_REVIEW_REQUEST_V1')
    expect(body).toContain('run_id: rl-20261001090000-000001')
    expect(body).toContain(`head_sha: ${SHA}`)
    expect(body).toContain('verdict: PASS | NEEDS_FIX')
    expect(body).toContain('A verdict for any other commit is ignored as stale.')
    expect(body).toContain('**Visibility.**')
    expect(isLoopRequestComment(body)).toBe(true)
  })

  it('places the policy before the verdict template and after the visibility notes', () => {
    expect(body.indexOf('**Visibility.**')).toBeLessThan(body.indexOf('**Review policy.**'))
    expect(body.indexOf('**Review policy.**')).toBeLessThan(
      body.indexOf('verdict: PASS | NEEDS_FIX')
    )
  })

  it('still lists the previous blocking findings on a later attempt', () => {
    expect(request({ previous: ['[High] parser drops a line'] })).toContain(
      '- [High] parser drops a line'
    )
  })

  it('is never read as a verdict, even though it quotes the verdict template', () => {
    expect(parseReviewContract(body).kind).toBe('malformed')
  })
})

describe('verdict contract with non-blocking findings', () => {
  it('accepts PASS that lists non-blocking findings', () => {
    const parsed = parseReviewContract(
      [
        'GPT_REVIEW_V1',
        '',
        'run_id: rl-20261001090000-000001',
        `head_sha: ${SHA}`,
        'verdict: PASS',
        '',
        'blocking_findings:',
        '- none',
        '',
        'non_blocking_findings:',
        '- [Medium] no CI run on this head',
        '- [Low] naming nit',
        '',
        'final:',
        'PASS'
      ].join('\n')
    )
    expect(parsed.kind).toBe('valid')
    if (parsed.kind === 'valid') {
      expect(parsed.review.verdict).toBe('PASS')
      expect(parsed.review.non_blocking_findings).toEqual([
        '[Medium] no CI run on this head',
        '[Low] naming nit'
      ])
    }
  })
})
