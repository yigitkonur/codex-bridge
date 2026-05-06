---
status: fixed
trigger: "14.19 pipeline-stage failures on 1-of-N jobs are invisible from status summary"
created: 2026-05-06
updated: 2026-05-06
---

# Phase 1 - Analysis

| Focus case | Validity | Priority | Decision |
|---|---|---:|---|
| `19-P1-pipeline-failure-invisible-from-status-running-count.md` | Real in the pre-fix source | P1 | Keep P1. The defect does not corrupt execution, but it can make a fan-out wave look clean after one job reaches `[PIPELINE:failed]`. |

## What The Problem Actually Is

`status --json` answered "which jobs are still active?" but did not answer "which finished jobs require action?" A batch orchestrator polling only `running.length` could see `0`, advance the wave, and miss a completed worker whose `.events` file contained `[PIPELINE:failed]`.

The per-job result path could already read event truth. The multi-job status surface did not, so terminal pipeline failure was hidden unless a user manually inspected the right job or grepped the event file.

## Root Cause

| Layer | Cause |
|---|---|
| State index | Worker lifecycle status is recorded as `completed` when the bridge process exits 0; that is not the same as pipeline success. |
| Status snapshot | `buildStatusSnapshot()` split jobs by state-index `status` only and did not read stored job detail or `.events` files. |
| Event truth | `[PIPELINE:failed]` was event truth available to result/forensics but absent from multi-job fan-in. |
| UX contract | JSON and human status lacked top-level `summary` and `needs_attention`, so scripts had no obvious success gate beyond active count. |

## Is It A Real Problem?

Yes. This is a real P1 for multi-agent orchestration because it creates a false-success read-side gap at fan-out scale. It is not P0 by itself: no job execution is made worse, and per-job inspection can still recover the truth once the user knows which job to inspect.

## Blast Radius

| Surface | Impact |
|---|---|
| `status --json` | `running.length === 0` can be mistaken for "all successful". |
| Human `status` | Failed/incomplete terminal jobs are not promoted above normal recent jobs. |
| `status --watch --json` | Live ticks did not include failed/attention counts. |
| Pipeline jobs | `[DONE]` followed by `[PIPELINE:failed]` was the sharpest case because state-index status stayed `completed`. |

## Dependencies / Overlaps

| Related case | Relationship | Scope decision |
|---|---|---|
| 14.02 terminal-tag truth divergence | Same event-vs-worker truth split. | Reuse the lesson, do not rewrite result classification here. |
| 14.04 pipeline timeout defaults | Common producer of `[PIPELINE:failed]`. | Out of scope except surfacing failures. |
| 14.15 pipeline payload contradiction | Same pipeline event family. | Out of scope; this fix reads tags/reasons only. |
| 14.23 broader status shape | Broader status ergonomics. | Out of scope; this fix adds only summary, attention list, watch tick counts, and filters needed for 14.19. |

# Phase 2 - GSD Implementation Plan

## Grouping

| Cluster | Files | Contract fixed |
|---|---|---|
| Event-derived status classification | `src/lib/job-control.mjs` | Every scoped job contributes to status summary using `.events` when available; `[PIPELINE:failed]` and `[ERROR]` count as `completed_fail`. |
| Public status projection | `src/handlers/inspect.mjs`, `src/lib/render.mjs` | Multi-job status exposes `summary`, `needs_attention`, and `by_state`; human status renders summary/attention first. |
| Script filters | `src/handlers/inspect.mjs`, `src/commands-meta.mjs`, plugin/skill command docs | `status --filter completed_fail --json` and `status --filter needs_attention --json` return script-friendly subsets. |
| Regression coverage | `test/status-summary-visibility.test.mjs` | A worker-completed job with `[DONE]` then `[PIPELINE:failed]` is counted failed and listed in `needs_attention`. |

## Sequencing

1. Add a focused test fixture with one successful completed job and one completed worker whose events contain `[PIPELINE:failed]`.
2. Classify status jobs from event truth in `buildStatusSnapshot()` without changing job execution.
3. Add summary/attention/filter projections and human rendering.
4. Update focused command docs and plugin command guidance.
5. Rebuild generated skill/plugin bundles.
6. Run focused tests, build, and the full test suite.

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Status now reads event files for scoped jobs. | Scope reads to the same jobs status already lists; no execution path changes. | Revert the `job-control.mjs` classifier and remove summary/filter tests. |
| JSON consumers with exact-shape checks see additive fields. | Preserve existing `running`, `latestFinished`, and `recent`. | Additive fields can be ignored; rollback is isolated to status projection. |
| `[PIPELINE:failed]` becomes `completed_fail` while raw worker status may be `completed`. | Preserve raw state in job entries and expose `needs_attention.state = PIPELINE_FAILED`. | A later change could split a separate pipeline-failed bucket if needed. |

## Acceptance Criteria

| Case | Check |
|---|---|
| 14.19 | A two-job status snapshot with one success and one `[DONE]` then `[PIPELINE:failed]` job returns `summary.running === 0`, `summary.completed_success === 1`, `summary.completed_fail === 1`, `summary.awaiting_attention === 1`, and `needs_attention[0].state === "PIPELINE_FAILED"`. |
| 14.19 filter | `status --filter completed_fail --json` returns the pipeline-failed job in `filtered_jobs`; `status --filter needs_attention --json` returns the same actionable entry. |

## Out Of Scope

- Broader status/progress redesign from case 23.
- Changing worker lifecycle semantics in `runTrackedJob`.
- Reclassifying result-envelope terminal fields.
- Fixing producers of `[PIPELINE:failed]`, including timeout defaults or pipeline payload contradictions.
- Hook architecture, Monitor lifecycle, CLI recovery envelope, and multi-agent scalability proposals from reference docs `00-13`, `15`, the flat `14` summary, or `README.md`.
