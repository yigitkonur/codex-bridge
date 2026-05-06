# Phase 1 — Analysis

## Focus Case

| Case | Validity | Severity | Decision |
|---|---|---:|---|
| `04-P0-pipeline-stage-timeout-default-too-tight.md` | Valid for the live default before this fix; partially stale on documentation claims in this checkout. | P0 impact, P1 likelihood after mitigation | Keep as P0-class remediation because the default can make normal fan-out jobs fail at the review stage; implement the small default/recovery fix, not adaptive review splitting. |

## Problem

The auto-pipeline gives every post-task stage the same fixed timeout. Before this fix, the built-in and shipped config defaults were `pipeline_stage_ms: 300000` and `pipeline_total_ms: 900000`, so the native review stage had only 5 minutes even though it is an LLM call over the task diff. Moderate review workloads can cross that budget, producing `[ERROR] ... ClientTimeout` with `origin: pipeline:<lastCompleted>` and `failing_stage: review`.

The focused report also says `--pipeline-stage-timeout-ms` was missing from `SKILL.md` and `error-recovery.md`. That part is stale in this checkout: the root skill docs and recovery reference already mention the flag. The remaining docs gap is that defaults still advertised 5 min / 15 min and the generated `[ERROR]` action block did not directly show an `extend-timeout` relaunch.

## Root Cause

| Layer | Finding |
|---|---|
| Runtime defaults | `src/lib/runtime-options.mjs` owned the effective config defaults and still used a 5-minute stage budget. |
| Pipeline fallback | `src/adapters/codex/pipeline.mjs` had independent fallback constants with the same 5-minute / 15-minute values, so callers passing no resolved config still inherited the tight budget. |
| Pipeline shape | `runAutoPipeline` applies one fixed `stageMs` to review, fix, and check. Review is structurally slower because it calls the model over a diff; diff capture is local git/file I/O. |
| Recovery guidance | `formatErrorEvent` knew pipeline origin was special, but its actions stopped at `inspect` and `rerun-review`; repeated timeouts required users to discover the timeout flags elsewhere. |

## Real Problem Check

The default-too-tight claim is real. A timeout safety net should be above the median normal review workload, not at the floor for trivial diffs. The exact "35 of 30 jobs" count is a field-report data point, not a universal rate, but the mechanism is source-valid and high-impact for unattended batches.

P0 is justified as an impact classification because the failure compounds other event/result truth issues: jobs can finish their main Codex turn, fail the review pipeline afterward, and require explicit result/event inspection to avoid advancing orchestration state. It is not a data-loss P0 by itself; the blast radius is failed validation and false confidence, not direct repository corruption.

## Blast Radius

| Surface | Impact |
|---|---|
| `task` with auto-review enabled | Moderate diffs can fail in review after the main turn completes. |
| Background fan-out | A batch can accumulate many identical timeout failures before the orchestrator notices. |
| Recovery UX | Users may rerun review with the same budget or reach for unrelated flags if the action block does not surface the timeout override. |
| Generated skill/plugin bundles | Installed users inherit stale timeout defaults unless generated scripts and `plugin/config.yaml` are rebuilt. |

## Dependencies / Overlaps

| Related case | Relationship | Scope decision |
|---|---|---|
| `02-P0-terminaltag-done-lies-when-events-recorded-error.md` | Timeout failures are one trigger for false-success reporting. | Out of scope; this plan reduces trigger frequency and improves recovery only. |
| `05-P0-no-pipeline-flag-silently-no-ops-the-task.md` | Tight timeout made `--no-pipeline` look like an obvious workaround. | Out of scope; do not redesign `--no-pipeline` here. |
| `19-P1-pipeline-failure-invisible-from-status-running-count.md` | Visibility gap after pipeline failure. | Out of scope. |
| `27-P2-skill-doc-gaps.md` | Historical docs gap for timeout flag. | Only update timeout defaults and action guidance needed by 14.04. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Root cause | Fix surface | Contract |
|---|---|---|---|
| Timeout calibration | Built-in and fallback pipeline budgets are below normal review workload. | `src/lib/runtime-options.mjs`, `src/adapters/codex/pipeline.mjs`, `skill/config.yaml`, generated bundles | Default pipeline stage budget is 12 min; total budget is 30 min; CLI/config overrides still win. |
| Recovery action truth | Pipeline timeout action block omits the direct timeout relaunch path. | `src/lib/session-log.mjs`, generated bundles, recovery references | Pipeline-origin `[ERROR]` includes `inspect`, `rerun-review`, `extend-timeout`, and a stable recovery anchor. |
| Documentation alignment | User-facing docs/config references still mention old 5 min / 15 min defaults in some authored surfaces. | `skill/SKILL.md`, `skill/references/error-recovery.md`, `skill/references/config-reference.md`, `skill/references/command-reference.md`, packaged plugin skill references | Runtime docs describe 12 min / 30 min defaults and point large reviews at timeout overrides. |
| Regression coverage | No focused test pins the calibrated defaults or action block. | `test/auto-pipeline-turn-watchdog.test.mjs`, `test/config-diagnostics.test.mjs`, `test/session-log.test.mjs` | Tests fail if defaults regress to 300000/900000 or pipeline errors stop surfacing `extend-timeout`. |

## Sequencing

1. Patch source defaults and pipeline fallback constants together.
2. Patch pipeline timeout actions and incomplete-result next action.
3. Align authored skill/config/reference docs and packaged plugin guidance.
4. Add focused tests for fallback defaults, merged config defaults, and pipeline-origin error actions.
5. Run `npm run build` to refresh generated skill/plugin outputs.
6. Verify with focused tests and full static gate on a clean branch.

## Per-Cluster Work Items

| Cluster | Files / modules | Behavior change | Verification |
|---|---|---|---|
| Timeout calibration | `src/lib/runtime-options.mjs`, `src/adapters/codex/pipeline.mjs`, `skill/config.yaml`, `plugin/config.yaml`, `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs` | No-override auto-pipeline runs report `stageTimeoutMs: 720000` and `totalTimeoutMs: 1800000`. | `auto-pipeline fallback budgets match calibrated runtime defaults`; `runtime defaults include calibrated pipeline and retention budgets`. |
| Recovery action truth | `src/lib/session-log.mjs`, generated scripts | Pipeline-origin `[ERROR]` action block includes `extend-timeout: ... task --pipeline-stage-timeout-ms 1200000 --pipeline-total-timeout-ms 3600000`. | `pipeline timeout error actions surface timeout relaunch budget`. |
| Documentation alignment | Root skill docs/config references and packaged plugin skill references | Users see 12 min / 30 min defaults and a large-review override recipe. | Grep for old active defaults returns no matches in `src`, `skill`, `plugin`, `test`, and AGENTS surfaces. |

## Risk + Rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Longer default waits delay detection of genuinely hung review/fix/check stages. | Total pipeline budget remains bounded at 30 min; users can lower `pipeline_stage_ms` per project. | Revert the default/fallback constants or set local config back to tighter budgets. |
| `extend-timeout` relaunch example may encourage duplicate task launches when only standalone review is needed. | Action block lists `inspect` and `rerun-review` before relaunch; docs say inspect the result first. | Remove the action line while keeping raised defaults. |

## Acceptance Criteria

| Case | Check |
|---|---|
| 14.04 | A no-override auto-pipeline run exposes `stageTimeoutMs === 720000` and `totalTimeoutMs === 1800000`, and a pipeline-origin `ClientTimeout` event includes an `extend-timeout` action with `--pipeline-stage-timeout-ms`. |

## Out of Scope

- Adaptive diff-size timeout scaling or review sub-stage splitting.
- Result/event terminal truth fixes from case 14.02.
- `--no-pipeline` semantics from case 14.05.
- Status/watch visibility changes from case 19.
- Broad hook architecture, Monitor lifecycle, CLI envelope, or multi-agent scalability proposals from reference docs `00-13`, `15`, and the flat `14` summary.
