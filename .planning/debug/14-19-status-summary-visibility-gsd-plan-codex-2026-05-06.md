---
status: fixed
trigger: "14.19 pipeline-stage failures on 1-of-N jobs are invisible from status summary"
created: 2026-05-06
updated: 2026-05-06
---

# Phase 1 — Analysis

| Focus case | Validity | Priority | Decision |
|---|---|---:|---|
| `19-P1-pipeline-failure-invisible-from-status-running-count.md` | Real in the current source before this fix | P1 | Keep as P1. The defect does not corrupt job execution, but it can make a fan-out wave look clean when one job reached `[PIPELINE:failed]`. |

## What The Problem Actually Is

`status --json` answered "which jobs are still active?" but did not answer "which finished jobs require action?" A batch orchestrator polling `.result.running | length` could see `0`, conclude the wave was done, and miss a job whose `.events` file contained `[PIPELINE:failed]`.

The current code already had a stronger per-job `result` truth path: `codexAdapter.getResult()` can read `.events` and classify `[PIPELINE:failed]` as non-success. The multi-job status surface did not use that event truth. It only returned `running`, `latestFinished`, and `recent`, with terminal jobs mixed together by state-index status.

## Root Cause

| Layer | Root cause |
|---|---|
| State index | `runTrackedJob` marks a worker process as `completed` when the bridge process exits with status 0. That status is a worker lifecycle signal, not complete pipeline truth. |
| Status snapshot | `buildStatusSnapshot()` split scoped jobs into active vs. finished lists from `job.status` and never read job detail files or `.events`. |
| Event truth duplication | Event-terminal logic existed privately in the result adapter, so `result <job>` could see pipeline failure while `status` could not. |
| Orchestrator UX | Human output and JSON output lacked top-level `summary` and `needs_attention`, forcing manual grep or per-job result calls. |

## Is It A Real Problem?

Yes. The claim is source-valid and the P1 classification is appropriate for multi-job orchestration. It is not P0 by itself because no task is made worse by the read-side gap, and `result <job>` can expose the truth once the user inspects the right job. The real danger is false confidence at fan-out scale: one failed validation stage hides inside a terminal set of jobs.

The report's core requirement is valid: status should promote `[ERROR]` and `[PIPELINE:failed]` into aggregate failed counts and a job list requiring attention. The `status --filter` request is also valid for scripts and can be implemented as a small projection over the same classification data.

## Blast Radius

| Surface | What breaks | Who notices |
|---|---|---|
| `status --json` | `running.length === 0` can be mistaken for successful wave completion. | Batch orchestrators and supervising agents. |
| Human `status` | Failed/incomplete terminal jobs are not prominent unless they happen to be latest/recent and visually inspected. | Users watching large runs. |
| `status --watch --json` | Ticks reported active count but not failed/attention count. | Scripts using watch as a live fan-in view. |
| Pipeline failures | Jobs with `[DONE]` followed by `[PIPELINE:failed]` are the sharpest failure mode because worker state says completed. | Users relying on auto-review/check pipeline. |

## Dependencies / Overlaps

| Related case | Relationship | Scope decision |
|---|---|---|
| 14.02 terminalTag truth divergence | Same event-vs-worker truth split; result path already fixed separately. | Reuse the lesson, but do not rewrite adapter result classification here. |
| 14.04 pipeline timeout defaults | Common producer of `[PIPELINE:failed]`. | Out of scope except counting its failures visibly. |
| 14.15 pipeline error field contradiction | Same pipeline payload family. | Out of scope; this fix reads event tags/reasons only. |
| 23 broader status shape | Broader progress/status ergonomics. | Out of scope; this plan adds only summary, attention list, and filters required by 14.19. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Shared root cause / fix surface | Files / modules | Contract fixed |
|---|---|---|---|
| Event-derived status classification | `status` used only state-index lifecycle state. | `src/lib/job-control.mjs` | Every scoped job contributes to `summary` using `.events` when available; `[PIPELINE:failed]` and `[ERROR]` count as `completed_fail`. |
| Public status projection | JSON/human status lacked actionable aggregate fields. | `src/handlers/inspect.mjs`, `src/lib/render.mjs` | `status --json` returns `summary`, `needs_attention`, `by_state`; human status renders summary and attention before recent jobs. |
| Script filters | Orchestrators needed ad hoc `jq` or events grep. | `src/handlers/inspect.mjs`, `src/commands-meta.mjs`, `plugin/commands/status.md`, skill references | `status --filter completed_fail --json` and `status --filter needs_attention --json` return script-friendly subsets. |
| Regression coverage | No test pinned invisible 1-of-N pipeline failure. | `test/status-summary-visibility.test.mjs` | A completed worker with `[DONE]` then `[PIPELINE:failed]` is counted failed and listed in `needs_attention`. |

## Sequencing

1. Reproduce the missing field with a focused status snapshot test.
2. Add event-aware classification in `buildStatusSnapshot()` while preserving current-session scoping and `--all`.
3. Promote `summary`, `needs_attention`, and `by_state` into the JSON result and human renderer.
4. Add `status --filter` as a projection over the same classified data.
5. Update command metadata and plugin/skill status guidance.
6. Rebuild generated `skill/scripts/` and `plugin/scripts/` outputs.
7. Verify focused tests, then run the standard build/test suite against the already dirty branch.

## Per-Cluster Work Items

| Cluster | Change in behavior | Verification |
|---|---|---|
| Event-derived status classification | `status` reads each scoped job's detail/event path, falls back to configured `session_dir`, and classifies the latest terminal truth. `[PIPELINE:failed]` overrides an earlier `[DONE]` for status summary purposes. | `node --test test/status-summary-visibility.test.mjs` checks `summary.completed_fail === 1` with `running.length === 0`. |
| Public status projection | `status --json` includes `summary.total`, `summary.running`, `summary.completed_success`, `summary.completed_fail`, `summary.completed_incomplete`, `summary.cancelled`, `summary.interrupts`, `summary.awaiting_attention`, `needs_attention`, and `by_state`. | CLI subprocess test parses `status --all --json` and asserts `needs_attention[0].state === "PIPELINE_FAILED"`. |
| Script filters | `--filter completed_fail` returns `filtered_jobs` for failed jobs and keeps related `needs_attention`; `--filter needs_attention` returns actionable entries. Invalid or incompatible filter use fails with usage errors. | CLI subprocess test parses `status --filter completed_fail --json` and asserts only the pipeline-failed job is returned. |
| Documentation | Help and plugin command docs tell users not to treat `running === 0` as success. | `node src/codex-bridge.mjs status --help` shows `--filter`; plugin surface tests pass. |

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Status polling now reads event files for scoped jobs, adding I/O at fan-out scale. | Keep the classifier lightweight and scoped to the already listed jobs; no execution path changes. | Revert the `job-control.mjs` classification block and remove `summary`/filter tests. |
| Existing consumers with exact JSON shape checks may see additive fields. | Additive fields preserve existing `running`, `latestFinished`, and `recent`. | Consumers can ignore new keys; rollback is a single status projection revert. |
| `[PIPELINE:failed]` is counted as `completed_fail` while per-job result maps it to an incomplete terminal tag. | This is intentional for the wave-level question "which jobs failed validation and need investigation?" The raw state is preserved in `needs_attention.state = PIPELINE_FAILED`. | If needed, split later into `completed_pipeline_failed`; not required for 14.19. |
| Legacy jobs without stored event paths may still lack event truth. | Fallback checks configured `session_dir` by `threadId`; jobs with no thread/event file keep worker-state classification. | No rollback needed; fallback is best-effort and non-mutating. |

## Acceptance Criteria

| Case | Acceptance check |
|---|---|
| 14.19 | A two-job status snapshot with one successful job and one worker-completed job whose events contain `[DONE]` then `[PIPELINE:failed]` returns `summary.running === 0`, `summary.completed_success === 1`, `summary.completed_fail === 1`, `summary.awaiting_attention === 1`, and `needs_attention[0].state === "PIPELINE_FAILED"`. |
| 14.19 filter | `status --filter completed_fail --json` returns the pipeline-failed job in `filtered_jobs` without requiring manual events grep. |

## Out Of Scope

- Broader status/progress redesign from case 23 and reference docs.
- Changing worker lifecycle semantics in `runTrackedJob`.
- Reclassifying `result.adapterResult.terminalTag` or result-envelope fields.
- Fixing producers of `[PIPELINE:failed]`, including timeout defaults or pipeline stage payload contradictions.
- Hook architecture, Monitor lifecycle, CLI recovery envelope, and multi-agent scalability proposals from reference docs `00-13`, `15`, the flat `14` summary, or `README.md`.
