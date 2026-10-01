/**
 * Instructions for the independent reviewer on what deserves a blocking verdict. They live in
 * the request comment only: Orca never classifies severity, it just reads the reviewer's
 * `blocking_findings` / `non_blocking_findings` sections.
 */
export const REVIEW_POLICY_LINES: readonly string[] = [
  '**Review policy.** Judge this change against its current Definition of Done and Critical Path (stated in the PR description; if none is stated, the evident purpose of the change). The goal is a usable, safe change that reaches roughly 80% completeness, not a zero-finding review.',
  '',
  'Severity and blocking:',
  '- Critical: always blocking.',
  '- High: always blocking.',
  '- Medium: blocking only if it prevents the current Definition of Done, breaks a major use case, makes real operation unsafe, or causes a material regression. Otherwise it is non-blocking.',
  '- Low: non-blocking backlog.',
  '',
  'Do NOT choose NEEDS_FIX for any of these reasons alone:',
  '- speculative edge cases, or problems that might only occur in the future',
  '- future extensibility or preventive hardening',
  '- stylistic preference, or code that could merely be cleaner',
  '- unnecessary abstraction, broad refactoring, or improvements outside the current Critical Path',
  '- missing exhaustive tests, when the required tests exist and pass',
  '- Medium or Low findings with no real-world impact',
  '- the goal of bringing the number of findings to zero',
  '',
  'Scope control. Do not require unrelated refactors, architecture redesign, future feature work, new abstraction layers or wrappers, generalized solutions for a one-off issue, broad test-suite expansion, preventive security hardening unrelated to a current risk, or unrelated documentation cleanup. The only exception is the minimal change needed to resolve a Critical or High finding.',
  '',
  'Prefer PASS when the main use case works, the Definition of Done is met, required tests pass, and no Critical or High issue remains, with no data-destruction risk, secret-leak risk, serious security regression, or serious regression.',
  '',
  'PASS means: the Definition of Done is met, no Critical or High issue remains, no Medium issue blocks real operation, and the change is usable for its intended purpose. PASS does not mean perfect, future-proof, every edge case covered, every suggestion applied, or zero findings.',
  '',
  'Where findings go: `blocking_findings` holds only Critical, High, and Medium findings that block the Definition of Done. `non_blocking_findings` holds all other Medium findings, Low findings, and backlog ideas. Prefix each finding with its severity, for example `[High] ...`. Having non-blocking findings is not a reason for NEEDS_FIX, and PASS may list them.',
  ''
]
