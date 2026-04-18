# 05 — `bridge cancel` (no args) fails when multiple jobs are active

**Observed:** 2026-04-18 during the live-run cleanup.
**Codex version:** `codex-cli 0.104.0`

## What happened

I tried to cancel a stuck task with `bridge cancel --json` (no args). Expected per `gherkin-tests-v2/07-orchestration/04-cancel-interrupts-running-turn.md` scenario 3:

> `cancel` without args → cancels the latest running job in the current session. If no such job, `error.class: "not_found"`, exit 3.

Observed:

```json
{
  "ok": false,
  "schema_version": "1.0",
  "error": {
    "class": "validation",
    "code": "AMBIGUOUS_CANCEL",
    "message": "Multiple Codex jobs are active.",
    "retryable": false,
    "suggestion": "Pass a job id to `cancel`."
  },
  "command": "cancel"
}
```

Exit 6, `AMBIGUOUS_CANCEL`.

## Why this is a spec mismatch

The spec's assertion that bare `cancel` picks the "latest running job" is wrong. The actual behavior — when there are ≥ 2 active jobs — is to refuse to pick and force the user to be explicit. That's defensible UX, but the spec doesn't capture it.

Single-job case and zero-job case almost certainly still work as described; the bug is the spec's silence on the multi-job case.

## Suggested fix

Update `gherkin-tests-v2/07-orchestration/04-cancel-interrupts-running-turn.md` scenario 3 to enumerate three sub-scenarios:

- **3a. Zero active jobs:** exit 3, `NO_ACTIVE_JOBS`, `error.class: "not_found"`. (This was already verified by the subagent sweep.)
- **3b. Exactly one active job:** exit 0, cancels that job. (Untested in the subagent sweep; marked static-only.)
- **3c. Multiple active jobs:** exit 6, `AMBIGUOUS_CANCEL`, `error.class: "validation"`, suggestion names the fix ("Pass a job id to `cancel`"). **Observed live.**

The AMBIGUOUS_CANCEL path is a UX nicety — it protects users from cancelling the wrong job when parallelism is in play. Worth making the spec reflect this.

## Related

- `gherkin-tests-v2/07-orchestration/04-cancel-interrupts-running-turn.md` — the scenario missing case 3c.
