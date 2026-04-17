# 06 / 01 — Error code names drift between Gherkin, code, and docs

**Scenarios under test:**
- `Scenario Outline: Error type maps to correct ERROR code`
- `references/error-recovery.md` Codex `codexErrorInfo` → exit-code table

---

## [BROKE] `TooManyRetries` / `NotSteerable` error codes do not exist in source

Gherkin `06-error-classification.feature:53` expects:

| codexError | errorCode (shown in events) |
|---|---|
| ResponseTooManyFailedAttempts | **TooManyRetries** |
| ActiveTurnNotSteerable | **NotSteerable** |

But the source (`src/lib/codex.mjs:553`, `src/lib/cli-errors.mjs:60`) reuses the raw Codex enum names verbatim when writing the events file. So the real emission is:
```
[ERROR] <threadId> failed | ResponseTooManyFailedAttempts
[ERROR] <threadId> failed | ActiveTurnNotSteerable
```

A grep for the Gherkin's short names against real `.events` files finds nothing.

**Root cause in skill text:** The Gherkin scenarios were written against a shorter display-name scheme that the renderer never implemented. `error-recovery.md` uses the full names, so at least that doc is correct.

**Fix target:**
1. Option A — teach `render.mjs` / `session-log.mjs` to display short names (`TooManyRetries`, `NotSteerable`). Less work for agent grep.
2. Option B — rewrite Gherkin Examples table to the long names.

Option B is the minimal fix and matches `error-recovery.md`.

---

## [BROKE] Timeout values: three docs, three numbers

| Phase | Gherkin (`05-timeout*.feature`) | `error-recovery.md` | SKILL.md |
|---|---|---|---|
| Plan turn | 300 s | 5 min (300 s) | — |
| Execution turn | 600 s | 10 min (600 s) | — |
| Auto-review | 300 s | 5 min (300 s) | — |
| Completion check | **120 s** | **5 min** | — |
| Auto-pipeline total | 900 s | 15 min (900 s) | — |
| No-event idle | 120 s | 2 min (120 s) | "10 minutes" (informal) |

Completion-check diverges: 120 s (Gherkin) vs 5 min (error-recovery). The other rows are consistent, just unit-style-drift.

**Fix target:** Pick one canonical table and link to it from both SKILL.md and Gherkin. `error-recovery.md` already has the right schema — make it the source of truth, drop the Gherkin table or replace it with `See error-recovery.md`.

---

## [BROKE] `ERROR` NDJSON entries don't exist (carried over from 04/02)

Gherkin `Scenario: All errors are logged to NDJSON regardless of will_retry` says NDJSON should contain an `ERROR` tag. My 9 real ndjson files contain zero `ERROR` tags. The bridge does not persist error notifications to NDJSON at all.

**Fix target:** Either the bridge should persist `ERROR` into NDJSON (small code change), or both the Gherkin and `ndjson-guide.md` need to admit this.

---

## [NICE] CLI-level error envelopes (`cli-errors.mjs`) match exit-code table

Every static CLI error I exercised (`MISSING_PROMPT`, `INVALID_EFFORT`, `USAGE_ERROR`, `JOB_NOT_FOUND`, `PENDING_REQUEST_NOT_FOUND`) produced correct class + exit code + suggestion. This is the part of error-recovery.md that actually holds up.
