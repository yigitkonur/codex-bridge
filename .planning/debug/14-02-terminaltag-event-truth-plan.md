# Phase 1 — Analysis

| Case | Problem | Root Cause | Real Problem? | Blast Radius | Dependencies / Overlaps |
|---|---|---|---|---|---|
| `14.02 — terminalTag: DONE lies when events stream recorded [ERROR] or [PIPELINE:failed]` | `result --json` can report `adapterResult.terminalTag: "DONE"`, `phase: "done"`, and `exitCode: 0` for a job whose `.events` file records a terminal pipeline failure. The public result envelope answers "success" while the chronological event log answers "failure/incomplete." | The job registry records the worker turn as `completed` when the Codex worker exits with status 0. Auto-pipeline runs after that successful worker turn and can emit `[ERROR]` / `[PIPELINE:failed]` while returning a payload with `pipeline.error`; however `codexAdapter.getResult()` classified terminal state from `job.status` instead of reading the events file or the pipeline payload. The state machine had two truth sources: worker lifecycle and event lifecycle. | Yes. The P0 classification is justified for orchestrated background work because it creates silent false-success. The specific "35 of 30" frequency claim is session evidence, not a universal invariant, but the mechanism is real in current code: a completed worker plus failed pipeline yields a completed job record, and `getResult()` previously mapped that to `DONE`. | Multi-job orchestrators polling `result --json` can advance waves on jobs whose review/fix/check pipeline failed. Users notice later when expected edits, review verdicts, or artifacts are missing. The failure manifests after any post-turn pipeline error, especially timeouts in `review`, `fix`, or `check`, and is worst for `--background --write` fan-out. | Shares symptom class with the referenced runner false-completed case, but this focus case is specifically the result-envelope classifier. Shares trigger surface with pipeline timeout defaults, but fixing timeout budgets is out of scope. Shares event/payload contradiction concerns with pipeline error self-contradiction, but the needed fix here is making `result --json` event-authoritative. |

Judgment: treat this as a real P0-class protocol defect, not merely cosmetic. A command named `result` must summarize the terminal event stream; worker exit status should be diagnostic metadata only.

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Shared Root Cause / Fix Surface | Files / Modules | Contract Fixed | Verification |
|---|---|---|---|---|
| Result state truth | Result classification reads worker status instead of terminal event evidence. | `src/adapters/codex/index.mjs`, `src/adapters/index.d.ts` | `adapterResult.terminalTag`, `phase`, and `exitCode` are derived from `.events` when present; `workerExitCode`, `consistent`, and `discrepancyReason` expose divergence. | Unit test creates a completed job with `[ERROR]` and `[PIPELINE:failed]`; `getResult()` must report `ERROR`, not `DONE`. |
| Public contract docs | Users and slash commands need to know which result fields to trust. | `skill/references/state-machine.md`, `plugin/skills/codex-bridge/references/state-machine.md`, `skill/references/command-reference.md`, `skill/SKILL.md`, `plugin/skills/codex-bridge/SKILL.md`, `plugin/commands/result.md` | Document event stream as authoritative for `result --json`; worker exit code is informational; `consistent:false` is a warning state. | Build includes generated CLI bundles; docs are grep-checkable for `consistent` and `state-machine.md`. |

## Sequencing

1. Reproduce false-success with a focused regression test.
2. Implement event-authoritative classification in the Codex adapter result path.
3. Update the adapter type contract and user-facing references.
4. Run `npm run build`, `npm test`, and `npm run baseline:contracts -- --check`.
5. Fresh-context review the diff against this plan, then fix any verified findings before commit.

## Per-Cluster Work Items

| Cluster | Work Item | Behavior Change | Rollback / Risk |
|---|---|---|---|
| Result state truth | Add event terminal resolution that reads the stored `eventsPath`, then falls back to the configured session dir only when no stored path exists. | Jobs with `[ERROR]` report `terminalTag: "ERROR"`, `phase: "error"`, `exitCode: 1` even if worker status is `completed`. Jobs with only `[PIPELINE:failed]` classify as `INCOMPLETE`. Existing jobs with no events file keep worker-status fallback. | Risk: legacy jobs with present but terminal-less event files now return `UNKNOWN`/`error` instead of `DONE`. This is intentional for safety; rollback is reverting the adapter classifier and test. |
| Result state truth | Add consistency fields. | `workerExitCode` preserves the old worker signal; `consistent:false` and `discrepancyReason` make split-brain state machine cases machine-readable. | Risk: consumers that deep-compare exact result objects may see new keys. Existing CLI envelopes already tolerate additive fields. |
| Public contract docs | Add state-machine reference and point result docs to it. | Operators know to branch on `adapterResult.terminalTag` and investigate `consistent:false`. | Risk: docs can drift if terminal tags change. Keep the reference tied to `TERMINAL_TAGS` and update when adding tags. |

## Acceptance Criteria

| Case | Acceptance Check |
|---|---|
| `14.02` | A persisted completed job whose events contain `[ERROR] ... origin: pipeline:*` and `[PIPELINE:failed]` returns `adapterResult.terminalTag === "ERROR"`, `adapterResult.phase === "error"`, `adapterResult.exitCode === 1`, `adapterResult.workerExitCode === 0`, and `adapterResult.consistent === false`. |

## Out of Scope

- Changing default pipeline timeouts or retry policy from the referenced timeout critique.
- Reworking worker job status persistence, `status --watch`, or broader runner lifecycle semantics.
- Solving other per-issue files in `14-real-world-failure-cases/`.
- Implementing a new cancellation event tag or changing `wait` / `events --follow` terminal behavior.
- Addressing architectural proposals from feedback docs `00-13`, `15`, or the flat `14-real-world-failure-cases.md` beyond what this focus case requires.
