# Phase 1 — Analysis

| Case | Validity | Severity | Problem |
|---|---|---:|---|
| 14.07 — `result.adapterResult.summary` truncates to the first line | Valid, with one correction | P1, not P0 | The canonical adapter result summary returns the job-index headline instead of the complete final assistant answer. The full answer was not lost: completed task jobs already persisted it under `storedJob.result.rawOutput`, and `result --json` exposed that raw stored job payload. |

## What The Problem Actually Is

`codex-bridge result <jobId> --json` is the primary orchestration surface for "what did Codex produce?" For task jobs, the bridge stored Codex's complete final assistant message in the detailed job file, but `adapterResult.summary` selected the short job index summary. In practice, an orchestrator reading `.result.adapterResult.summary` got only the first meaningful line of a multi-line verdict.

The flat claim that full output lived only in NDJSON is overstated. The detailed result envelope already carried `storedJob.result.rawOutput`. The bug is still real because the canonical adapter result field was misleading and the documented fallback path taught callers to query lower-level session artifacts.

## Root Cause

| Layer | Evidence | Root cause |
|---|---|---|
| Task execution | `src/lib/task-runtime.mjs` builds `rawOutput` from `result.finalMessage`, then creates `summary` with `firstMeaningfulLine(...)`. | Two different concepts were collapsed into one name: compact status headline vs. final answer. |
| Job persistence | `src/lib/tracked-jobs.mjs` persists detailed `result: execution.payload`, but writes `execution.summary` into the state index. | The state index correctly stayed compact, but later code treated its headline as the result answer. |
| Result adapter | `src/adapters/codex/index.mjs#getResult` returned `summary: job.summary ?? storedJob?.summary ?? null`. | `adapterResult.summary` preferred the compact index headline over the detailed stored final message. |
| Transcript fallback | `src/lib/envelope-helpers.mjs#extractItemText` capped `agentMessage` text at 500 chars. | NDJSON replay was optimized for previews even when the item was an assistant deliverable. |

## Is It A Real Problem?

Yes. It breaks a high-frequency orchestration contract: callers reasonably expect `adapterResult.summary` to answer "what did Codex say?" without spelunking into raw job internals. The severity should be downgraded from P0 to P1 because the complete final output was already persisted and available in the same `result --json` envelope as `storedJob.result.rawOutput`; this was not irreversible data loss.

## Blast Radius

| Consumer | Impact |
|---|---|
| Multi-job orchestrators reading `adapterResult.summary` | Lose most of structured verdicts, plans, or reports when output is multi-line. |
| Humans using rendered `result` | Usually less affected because rendering already prefers `storedJob.result.rawOutput`. |
| Status/list views | Should keep compact summaries; replacing the state-index summary globally would make status tables noisy. |
| NDJSON transcript users | Previously saw truncated assistant messages; fixed by preserving full `agentMessage` text. |

## Dependencies And Overlaps

| Overlap | Relationship | Decision |
|---|---|---|
| `result --transcript` missing | Same user journey: retrieve final answer cleanly. | Include a minimal transcript flag on `result` because it is small and directly requested by 14.07. |
| Final-vs-intermediate message marking | Makes transcript final-only deterministic from raw item stream. | Out of scope for this fix. Prefer stored final message for `--final-only` when available. |
| Broader event-stream truth issues | Different root cause. | Out of scope, except existing `terminalTag` logic remains untouched. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Cases | Root cause / fix surface |
|---|---|---|
| Result final-message contract | 14.07 | `src/adapters/codex/index.mjs#getResult` should derive `adapterResult.summary` and `adapterResult.finalMessage` from stored final output before falling back to legacy summaries. |
| Transcript retrieval ergonomics | 14.07 guardrail | `src/handlers/inspect.mjs#handleResult` should support `--transcript`, `--final-only`, and `--format markdown|text|json`; `src/lib/envelope-helpers.mjs` should preserve assistant messages in NDJSON. |
| Documentation and generated surfaces | 14.07 guardrail | Update command metadata, plugin command docs, skill docs, and generated CLI bundles after source changes. |

## Sequencing

| Wave | Work | Prerequisites | Verification |
|---|---|---|---|
| 1 | Add red regression tests for multi-line `adapterResult.summary`, full `agentMessage` extraction, and `result --transcript --final-only --format text`. | Focus file read; current code traced. | `node --test test/result-summary-contract.test.mjs` fails on the old behavior. |
| 2 | Change result adapter to prefer stored final output, while leaving compact job-index summaries intact for status views. | Wave 1. | Regression test passes; existing adapter lifecycle tests still pass. |
| 3 | Add result transcript rendering and preserve full assistant text in NDJSON replay. | Wave 2. | Transcript CLI test passes without direct NDJSON queries. |
| 4 | Update command help/docs and run build. | Waves 2-3. | `npm run build`; generated bundles include new handler and metadata. |
| 5 | Run target and full verification, then commit only this case's files. | Wave 4. | Target tests plus `npm test` if unrelated dirty work does not break the suite. |

## Per-Cluster Work Items

| Cluster | Files/modules likely touched | Behavior change | Fixed contract | Verification |
|---|---|---|---|---|
| Result final-message contract | `src/adapters/codex/index.mjs`, `test/result-summary-contract.test.mjs` | `adapterResult.summary` and `adapterResult.finalMessage` expose the complete stored final assistant message when present. | `result --json` canonical answer field is complete. | Multi-line fixture asserts exact full text. |
| Transcript retrieval ergonomics | `src/handlers/inspect.mjs`, `src/lib/envelope-helpers.mjs`, `test/result-summary-contract.test.mjs` | `result --transcript --final-only --format text` prints only the final answer; `agentMessage` NDJSON text is no longer capped at 500 chars. | Callers no longer need NDJSON archaeology for final output. | CLI spawn test and extraction unit test. |
| Documentation/generated surfaces | `src/commands-meta.mjs`, `plugin/commands/result.md`, `skill/SKILL.md`, `plugin/skills/codex-bridge/SKILL.md`, `skill/references/command-reference.md`, `skill/references/ndjson-guide.md`, generated `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs` | Help and skill docs name the final-answer path. | Public docs match runtime flags. | `node src/codex-bridge.mjs result --help`; `npm run build`. |

## Risk And Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Status views become too verbose if the index summary changes globally. | Do not change `runTrackedJob` index summary; change only the `result` adapter payload. | Revert `storedFinalMessage` use in `getResult`. |
| Transcript `--final-only` could pick an intermediate NDJSON message when no stored final message exists. | Prefer stored final message whenever present; use NDJSON last assistant only as fallback. | Keep `finalMessage` field and remove transcript flag if needed. |
| Larger NDJSON files due to full assistant messages. | Only assistant messages are preserved in full; tool previews remain capped. | Reintroduce a high cap if real storage pressure appears. |

## Acceptance Criteria

| Case | One-line check |
|---|---|
| 14.07 | A completed task with a multi-line `storedJob.result.rawOutput` returns that exact text from `result.adapterResult.summary` and `result.adapterResult.finalMessage`. |
| 14.07 transcript guardrail | `codex-bridge result <jobId> --transcript --final-only --format text` prints the same final message without reading `.ndjson` manually. |
| 14.07 NDJSON guardrail | `extractItemText({ type: "agentMessage", text })` returns full `text`, including content beyond 500 chars. |

## Out Of Scope

- Adding final/intermediate markers to all app-server `agentMessage` events.
- Reworking all event-stream semantics from feedback files `00-13` or `15`.
- Changing status table/list summaries to multi-line output.
- Solving unrelated P0 cases in `14-real-world-failure-cases/`.
- Altering worktree lifecycle, destructive-diff gates, runner exit-code semantics, CLI cwd parsing, or pipeline timeout defaults except where already modified by unrelated parallel work.
