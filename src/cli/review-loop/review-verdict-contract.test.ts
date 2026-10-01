import { describe, expect, it } from 'vitest'
import { parseReviewContract } from './review-verdict-contract'
import { buildReviewRequestComment } from './review-request-comment'

const SHA = 'a'.repeat(40)

function block(
  overrides: Partial<
    Record<'verdict' | 'final' | 'head' | 'run' | 'blocking' | 'nonBlocking', string>
  > = {}
): string {
  return [
    'GPT_REVIEW_V1',
    '',
    `run_id: ${overrides.run ?? 'rl-20261001090000-000001'}`,
    `head_sha: ${overrides.head ?? SHA}`,
    `verdict: ${overrides.verdict ?? 'PASS'}`,
    '',
    'blocking_findings:',
    overrides.blocking ?? '- none',
    '',
    'non_blocking_findings:',
    overrides.nonBlocking ?? '- none',
    '',
    'final:',
    overrides.final ?? overrides.verdict ?? 'PASS'
  ].join('\n')
}

describe('parseReviewContract', () => {
  it('accepts a PASS block with empty finding sections', () => {
    expect(parseReviewContract(block())).toEqual({
      kind: 'valid',
      review: {
        run_id: 'rl-20261001090000-000001',
        head_sha: SHA,
        verdict: 'PASS',
        blocking_findings: [],
        non_blocking_findings: []
      }
    })
  })

  it('accepts NEEDS_FIX with findings, wrapped lines and markdown decoration in a fence', () => {
    const body = [
      'Review done.',
      '```text',
      block({
        verdict: 'NEEDS_FIX',
        blocking:
          '- `parse()` drops the last line\n  when input ends without newline\n- missing test',
        nonBlocking: '1. naming nit'
      }).replace('verdict: NEEDS_FIX', '**verdict:** NEEDS_FIX'),
      '```',
      'Trailing prose: PASS'
    ].join('\r\n')
    const parsed = parseReviewContract(body)
    expect(parsed.kind).toBe('valid')
    if (parsed.kind === 'valid') {
      expect(parsed.review.verdict).toBe('NEEDS_FIX')
      expect(parsed.review.blocking_findings).toEqual([
        '`parse()` drops the last line when input ends without newline',
        'missing test'
      ])
      expect(parsed.review.non_blocking_findings).toEqual(['naming nit'])
    }
  })

  it('never treats free-text PASS as a verdict', () => {
    expect(parseReviewContract('LGTM, PASS. verdict: PASS\nfinal: PASS')).toEqual({
      kind: 'absent'
    })
  })

  it.each([
    ['verdict and final disagree', block({ verdict: 'PASS', final: 'NEEDS_FIX' }), 'disagree'],
    ['abbreviated sha', block({ head: 'abcdef1' }), 'full 40-character'],
    ['template placeholder verdict', block({ verdict: 'PASS | NEEDS_FIX' }), 'verdict must be'],
    ['lowercase verdict', block({ verdict: 'pass', final: 'pass' }), 'verdict must be'],
    ['PASS with blocking findings', block({ blocking: '- real bug' }), 'PASS cannot carry'],
    ['NEEDS_FIX without findings', block({ verdict: 'NEEDS_FIX' }), 'requires at least one'],
    ['two blocks', `${block()}\n\n${block()}`, 'expected one'],
    [
      'missing section',
      block().replace('non_blocking_findings:', 'notes:'),
      'non_blocking_findings section'
    ]
  ])('rejects %s as malformed', (_label, body, error) => {
    const parsed = parseReviewContract(body)
    expect(parsed.kind).toBe('malformed')
    if (parsed.kind === 'malformed') {
      expect(parsed.errors.join(' | ')).toContain(error)
    }
  })

  it('keeps the run id of a malformed block so it can be routed', () => {
    const parsed = parseReviewContract(block({ head: 'short' }))
    expect(parsed).toMatchObject({
      kind: 'malformed',
      run_id: 'rl-20261001090000-000001',
      head_sha: null
    })
  })

  it('treats "なし" as an empty section', () => {
    expect(parseReviewContract(block({ blocking: '- なし' })).kind).toBe('valid')
  })

  it('does not read the request comment template as a valid verdict', () => {
    const request = buildReviewRequestComment({
      runId: 'rl-20261001090000-000001',
      repoSlug: 'me/repo',
      prNumber: 1,
      headSha: SHA,
      attempt: 1,
      maxAttempts: 3,
      localOnlyArtifacts: [],
      untrackedFiles: [],
      previousBlockingFindings: []
    })
    expect(parseReviewContract(request).kind).toBe('malformed')
  })
})
