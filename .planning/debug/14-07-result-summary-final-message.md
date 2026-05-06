---
status: resolved
trigger: "14.07 result.adapterResult.summary truncates to the first line; full verdict hidden in ndjson"
created: 2026-05-06T04:39:12Z
updated: 2026-05-06T04:48:43Z
---

# Debug Session: 14.07 Result Summary Final Message

## Symptoms

- Expected behavior: `codex-bridge result <jobId> --json` exposes the complete final assistant message through the canonical result surface used by orchestrators.
- Actual behavior: `result.adapterResult.summary` is populated from the job index summary, which is currently a first meaningful line for task jobs.
- Error messages: No thrown error; the failure is silent data loss in the user-facing envelope.
- Timeline: Reported from real-world multi-job orchestration in `codex-bridge-feedback/codex/14-real-world-failure-cases/07-P0-result-summary-truncates-to-first-line.md`.
- Reproduction: Store a completed task whose final message contains multiple lines, then inspect `result <jobId> --json`.

## Current Focus

- hypothesis: Confirmed. Task completion stores the full message in `storedJob.result.rawOutput`, but the result adapter used the compact job-index summary.
- test: `node --test test/result-summary-contract.test.mjs`
- expecting: `adapterResult.summary`, `adapterResult.finalMessage`, and `result --transcript --final-only --format text` return the complete final message.
- next_action: None for 14.07; unrelated dirty-tree test failures remain outside this focus case.
- reasoning_checkpoint: Focus case 14.07 only; broader event-stream/final-marker issues are out of scope unless needed for the canonical result contract.
- tdd_checkpoint: regression added and passing

## Evidence

- timestamp: 2026-05-06T04:39:12Z
  observation: `src/lib/task-runtime.mjs` builds task `summary` with `firstMeaningfulLine(rawOutput, ...)`.
- timestamp: 2026-05-06T04:39:12Z
  observation: `src/adapters/codex/index.mjs#getResult` returns `summary: job.summary ?? storedJob?.summary ?? null`.
- timestamp: 2026-05-06T04:39:12Z
  observation: `src/lib/envelope-helpers.mjs#extractItemText` truncates `agentMessage` text to 500 characters for NDJSON replay.
- timestamp: 2026-05-06T04:48:43Z
  observation: Added `test/result-summary-contract.test.mjs`; it failed red on first-line summary and 500-character assistant-message truncation before the fix, then passed after implementation.

## Eliminated

- hypothesis: The bridge has no stored copy of the final assistant message.
  reason: Completed task job details already persist `result.rawOutput`.
- hypothesis: The only viable fix is to parse Codex's own rollout files.
  reason: The bridge-owned stored job payload is already the stable source for the final assistant message.

## Resolution

- root_cause: `adapter.getResult()` preferred the state-index headline (`job.summary`) over the detailed stored final assistant message (`storedJob.result.rawOutput`); NDJSON replay also capped assistant messages at 500 characters.
- fix: Prefer stored final output for `adapterResult.summary` and new `adapterResult.finalMessage`; preserve full assistant messages in NDJSON replay; add `result --transcript --final-only --format text` for clean final-answer retrieval.
- verification: `node --test test/result-summary-contract.test.mjs`; `node --test test/codex-adapter-lifecycle.test.mjs`; `node src/codex-bridge.mjs result --help`; `npm run build`. Full suite still has unrelated dirty-tree failures in `test/handler-runtime.test.mjs` and `test/bridge-static.test.mjs`.
- files_changed: `src/adapters/codex/index.mjs`, `src/handlers/inspect.mjs`, `src/lib/envelope-helpers.mjs`, `src/commands-meta.mjs`, `test/result-summary-contract.test.mjs`, docs/command surfaces, generated CLI bundles.
