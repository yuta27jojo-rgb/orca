# Independent review loop (`orca review-loop`)

The review loop lets an agent hand its finished branch to an independent reviewer through a
GitHub pull request and resume automatically when the verdict arrives. The reviewer is whoever
posts a structured verdict comment on the PR (for example ChatGPT with GitHub access). The
loop uses only `git`, the authenticated `gh` CLI and Orca automations — no model API, no API
key and no reviewer-specific integration.

## Flow

```text
agent: implement → test → commit
agent: orca review-loop start            push (never forced), open/reuse PR, post request,
                                         create a polling Orca automation, end the turn
Orca : every 10 min, precheck `review-loop tick`   reads PR head + comments (no agent tokens)
       exit 0 only on a new event → Orca starts / reuses the agent with a fixed prompt
agent: orca review-loop next             acknowledges the event, prints REVIEW_LOOP_NEXT_V1
       NEEDS_FIX → fix blocking findings only → test → commit → orca review-loop submit
       PASS → report; nothing is merged
```

Attempts are capped at 3. A NEEDS_FIX on attempt 3 ends in `HUMAN_REVIEW_REQUIRED`.

### Why an automation precheck instead of a sleeping agent

| Option                                  | Survives restart                         | Cost while waiting     | Verdict                           |
| --------------------------------------- | ---------------------------------------- | ---------------------- | --------------------------------- |
| Agent process polls (`wait`)            | No                                       | Agent turn held open   | Fallback only (`--resume manual`) |
| Finish turn, resume via Orca automation | Yes (persisted schedule + git-dir state) | One `gh` poll per tick | Default inside Orca               |

Orca automations already persist across restarts, run a bounded precheck command before
launching an agent, and with `--reuse-session` paste the prompt into the previous idle agent
session. The precheck is the loop's poller, so no new runtime service or RPC was needed.

## Verdict contract

The reviewer replies with one PR comment (or PR review body) containing:

```text
GPT_REVIEW_V1

run_id: <run id from the request>
head_sha: <full 40-character commit SHA that was reviewed>
verdict: PASS | NEEDS_FIX

blocking_findings:
- ...

non_blocking_findings:
- ...

final:
PASS | NEEDS_FIX
```

A comment counts only when all of these hold; otherwise it is recorded and ignored:

- it contains exactly one block starting with a line `GPT_REVIEW_V1` (free-text "PASS" never counts);
- `verdict` and `final` are the same exact token, NEEDS_FIX has ≥1 blocking finding and PASS has none;
- `run_id` names this run (other runs, PRs and repositories are never matched);
- the author is a trusted reviewer (`--trusted-reviewer`, default: the authenticated `gh` user)
  and, when `--trusted-app` is set, the comment was posted through that GitHub App;
- `head_sha` equals both the run's head and the PR's current head (`STALE_REVIEW` otherwise);
- no verdict was already accepted for that head (`DUPLICATE_REVIEW` otherwise).

The loop's own request comments carry a hidden marker and are never read as verdicts.

## Review policy sent to the reviewer

Every request comment carries a review policy (`src/cli/review-loop/review-policy.ts`) so the
reviewer judges against the current Definition of Done instead of chasing zero findings:
Critical and High are blocking; Medium blocks only if it prevents the Definition of Done, a major
use case, safe operation, or causes a material regression; Low is non-blocking backlog.
Speculative edge cases, future hardening, style, broad refactors and exhaustive-test goals never
justify NEEDS_FIX, and the reviewer must not widen the scope. PASS may list non-blocking findings.
It is an instruction to the reviewer only: Orca does not classify severity and reads the same
`GPT_REVIEW_V1` sections as before.

## State

Runs are JSON files under `<git common dir>/orca-review-loop/runs/<run_id>.json`, shared by
every worktree of the repository and never committed. Writes are atomic and each mutation holds
a per-run lock file, so the automation precheck and the agent cannot double-process an event.
Fields include `schema_version`, `run_id`, `repo`, `pr`, `branch`, `current_head_sha`,
`attempt`, `status`, `verdict`, `processed_reviews` (duplicate protection), `requests`,
`attempts_history`, `notification` (the single pending agent event), timestamps and `resume`
error counters.

Statuses: `AWAITING_REVIEW`, `NEEDS_FIX`, `PASSED`, `HUMAN_REVIEW_REQUIRED`,
`LOCAL_REVIEW_REQUIRED`, `BLOCKED` (`HEAD_CHANGED_EXTERNALLY` is recoverable with `submit`;
`PR_NOT_OPEN` is not) and `STOPPED`.

`tick` exit codes: `0` event dispatched to the agent, `3` still waiting, `4` nothing to do, `1`
error (GitHub unavailable or auth failure — never settles a run). A dispatched event stays
pending until the agent acknowledges it by running `next`; an unacknowledged event is
re-dispatched every 30 minutes, at most 3 times. The automation stays enabled while a review is
awaited or an event is unacknowledged, and is reconciled on every tick, `submit` and `next`.
A reviewer that never answers ends the run in `HUMAN_REVIEW_REQUIRED` after
`--review-timeout-hours` (default 24).

## What GitHub cannot show

The reviewer sees only what is pushed at `head_sha`. The request comment lists untracked files
of the author's worktree, and `--local-artifact <path>` declares critical local-only files
(local config, runtime state, databases). With any declared artifact, a PASS ends in
`LOCAL_REVIEW_REQUIRED`: review those files with the project's local review process.

## Limits

- GitHub (github.com) only; the PR is always opened in the repository of the push remote.
- If the reviewer posts through the same account the agent uses, authorship cannot prove the
  comment came from the reviewer; use `--trusted-app` when the reviewer posts via a GitHub App.
- The first resume launches a fresh agent session in the workspace; later events reuse it while
  it is idle. Desktop Orca must have a window open for automations to dispatch.
- The agent's resume command is quote-free (bare `node` plus `/` paths) because the prompt travels
  through the agent's argv. If `node` is not on PATH and its path contains spaces, the fallback is a
  quoted command that PowerShell will not run without `&`; put `node` on PATH.
- Reviewer provenance: when the agent's `gh` account and the reviewer's GitHub account are the
  same, the comment author alone cannot prove the verdict came from the independent reviewer.
  `--trusted-app` narrows trust to a GitHub App; stronger provenance is future hardening.
- `next` acknowledges the pending event; use `status` to inspect a run without acknowledging it.
- An interrupted `submit` (for example GitHub down while posting the request) is resumed by
  running `submit` again or by the next tick.
