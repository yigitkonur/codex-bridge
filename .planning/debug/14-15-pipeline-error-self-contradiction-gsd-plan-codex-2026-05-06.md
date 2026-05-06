# Phase 1 — Analysis

## Scope

| Focus file | Case | Validation |
|---|---|---|
| `codex-bridge-feedback/codex/14-real-world-failure-cases/15-P1-pipeline-error-self-contradiction.md` | `PIPELINE_ERROR` has internally contradictory fields | Real P1 defect. `reviewVerdict: "approved"` on failed review is confirmed; `origin: pipeline:diff` was partly documented as last-completed-stage compatibility, but the field name is misleading enough that the fix should make `origin` match the failed stage and move prior progress to `lastCompletedStage`. |

## What The Problem Actually Is

`PIPELINE_ERROR` currently mixes fields that describe different stages and different moments in the pipeline lifecycle. In the reported shape, the event says:

| Field | Reported value | Consumer interpretation |
|---|---|---|
| `completedStages` | `["diff"]` | diff succeeded; review did not complete |
| `failing_stage` | `"review"` | review failed or stalled |
| `origin` | `"pipeline:diff"` | ambiguous: could mean diff caused the error, or diff was the last completed stage |
| `reviewVerdict` | `"approved"` | review completed cleanly |
| `reviewFindingCount` | `0` | review completed with no findings |

The actual machine-breaking contradiction is not the presence of two stage fields by itself; it is that review-specific success fields are emitted when the review stage did not reach its terminal success point. A consumer can reasonably branch on `failing_stage: "review"` and then be told, in the same object, that the review was approved.

The sync `result.pipeline` payload shares the same data path as `PIPELINE_ERROR`, so this is not only an `.ndjson` event bug. It can also leak into `task --json`, `result --json`, and any adapter result that embeds `pipeline`.

## Root Cause

The pipeline is implemented as an imperative sequence with shared scalar accumulators rather than a single explicit stage-state object:

| Current source fact | Effect |
|---|---|
| `src/adapters/codex/pipeline.mjs` initializes `reviewVerdict = "approved"` and `reviewFindingCount = 0` before review runs. | "Approved" is the default state, not evidence that review completed. |
| On failed review status, the review branch throws `PipelineStageError("review", ...)` before `completedStages.push("review")` and before parsing review output updates the verdict fields. | `completedStages` and `failing_stage` correctly show review did not complete, but review scalar defaults remain success-shaped. |
| The outer catch logs `PIPELINE_ERROR` with the current accumulator values unconditionally. | Error payloads include review fields even when the review stage failed before producing a verdict. |
| The outer catch returns the same accumulator values as `result.pipeline`. | The contradiction is preserved outside the event stream. |
| `origin` is derived from `completedStages[completedStages.length - 1]`, while `failing_stage` is derived from the thrown timeout/stage error. | There are two stage tokens with different meanings. That is only safe if the contract explicitly names the difference. |

This is a state-modeling defect: field population is based on "what variables exist right now" instead of "which stage reached which terminal state."

## Is It A Real Problem?

| Claim from focus file | Verdict | Reasoning |
|---|---|---|
| `reviewVerdict: "approved"` with `failing_stage: "review"` is contradictory. | Confirmed real defect. | Current code defaults review to approved and emits it on the failure path. Current tests even lock this shape in `test/auto-pipeline-turn-watchdog.test.mjs`. |
| `reviewFindingCount: 0` on failed review is contradictory. | Confirmed real defect. | A count of `0` means "completed and found zero findings" unless paired with an explicit failed/skipped status. It should be `null` or omitted when review did not complete. |
| `origin: "pipeline:diff"` contradicts `failing_stage: "review"`. | Valid contract hazard. | Some current references document `origin: pipeline:<lastCompleted>` and tell readers to use `failing_stage`, but other docs say `pipeline:<stage>` loosely and the field name `origin` naturally reads as the failed source. The simplest stable contract is `origin: pipeline:<failing_stage>` plus additive `lastCompletedStage`. |
| Priority P1. | Keep P1, not P0. | It degrades agent branching and schema trust, but a careful reader can still recover the truth from `completedStages` and `failing_stage`. It does not by itself corrupt workspace state or hide all failure. |

## Blast Radius

| Surface | Who notices | Manifestation |
|---|---|---|
| `.ndjson` `PIPELINE_ERROR` | Monitor parsers, forensic tools, orchestration agents | Branching code must special-case impossible review-success fields on review failure. |
| `task --json` / `result --json` pipeline object | Parent orchestrators and adapters | A failed pipeline can still report `reviewVerdict: "approved"`, causing poor retry guidance or false confidence. |
| Events-file `[ERROR]` block | Human and LLM readers | `origin` and `failing_stage` look contradictory unless the reader already knows the last-completed-stage convention. |
| Docs and examples | Skill/plugin users | Compressed references vary between `pipeline:<stage>` and `pipeline:<lastCompleted>`, so consumers may implement the wrong field semantics. |

The bug manifests when the pipeline aborts before review completes: review timeout, non-zero review result, auth failure, transport failure, or total-budget exhaustion during review. Review fields are valid on later failures only if review actually completed first, for example `failing_stage: "fix"` after a `must-fix` review.

## Dependencies And Overlaps

| Relationship | Status |
|---|---|
| Other `YOUR FOCUS` cases | None. Only case `14.15` is in scope. |
| Reference-only case `02-P0-terminaltag-done-lies-when-events-recorded-error.md` | Shares the larger "event truth must match result truth" theme, but its terminal-tag behavior is out of scope. |
| Reference-only case `19-P1-pipeline-failure-invisible-from-status-running-count.md` | May consume the same `pipeline.error`/`failing_stage` fields, but status aggregation is out of scope. |
| Current concurrent workspace changes | High coordination risk. Many source, test, skill, and plugin files are already dirty. Any implementation must avoid broad rewrites and stage only its own files. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Root cause | Fix surface | Contract fixed |
|---|---|---|---|
| A. Pipeline failure payload truth | Stage success fields are emitted from default scalar accumulators instead of terminal stage state. | `src/adapters/codex/pipeline.mjs`, `test/auto-pipeline-turn-watchdog.test.mjs`, generated `skill/scripts/codex-bridge.mjs`, generated `plugin/scripts/codex-bridge.mjs` | `PIPELINE_ERROR` and `result.pipeline` must not report a stage-specific verdict/count unless that stage completed. |
| B. Origin/failing-stage semantics | `origin` was overloaded as last-completed context even though readers expect it to name the error source. | `src/adapters/codex/pipeline.mjs`, `skill/references/notification-format.md`, `skill/references/error-recovery.md`, `skill/references/ndjson-guide.md`, plugin skill references as needed, focused pipeline tests | `origin` and `failing_stage` name the same failed stage; additive `lastCompletedStage` preserves prior progress. |

Recommended option: fix A fully and migrate B in one small contract change: set `origin` to `pipeline:<failing_stage>` and add `lastCompletedStage` for the old progress context. Consumers that only route on `origin.startsWith("pipeline:")` keep working; consumers that used the suffix as prior progress get an explicit replacement field.

## Sequencing

| Wave | Work | Prerequisites | Verify |
|---|---|---|---|
| 0. Reproduce and lock target contract | Add/update focused tests that currently fail under the desired contract: failed review before completion yields `reviewVerdict: null` and `reviewFindingCount: null` in both returned pipeline result and `PIPELINE_ERROR`. Preserve tests where review completed and later fix/check failed. | None. | `node --test --test-name-pattern "failed review" test/auto-pipeline-turn-watchdog.test.mjs` fails before implementation and passes after. |
| 1. Build failure payload from terminal stage state | In `runAutoPipeline`, replace unconditional review field emission on the catch path with a helper that only includes review fields when review reached the parse-success point. Use `null` for stable JSON keys, or omit keys only if the public contract is updated accordingly. | Wave 0 failing tests. | Failed-review tests pass; successful-review and fix-failure tests still pass. |
| 2. Clarify stage semantics | Add an explicit `lastCompletedStage` field to `PIPELINE_ERROR` and `result.pipeline`. Set `origin` from the same canonical failed-stage token as `failing_stage`. | Wave 1, because docs should describe implemented behavior. | Event tests assert `origin: "pipeline:review"`, `failing_stage: "review"`, and `lastCompletedStage: "diff"`. |
| 3. Align docs and generated outputs | Update authored skill references and any plugin copies that are not generated. Run `npm run build` after source changes to refresh generated scripts. | Waves 1-2. | `npm run build` leaves generated outputs aligned; docs no longer imply review fields exist before review completion. |
| 4. Full regression | Run the standard repo checks. | Waves 1-3. | `npm test` passes. If concurrent unrelated dirty work causes failure, record the failing tests and isolate whether any failure touches the changed contract. |

## Per-Cluster Work Items

### Cluster A — Pipeline Failure Payload Truth

Likely files:

| File | Change |
|---|---|
| `src/adapters/codex/pipeline.mjs` | Track review terminal completion separately from default intent. Set review verdict/count only after review output parses. Build error payload and returned `pipeline` object through one helper so `PIPELINE_ERROR` and sync result cannot drift. |
| `test/auto-pipeline-turn-watchdog.test.mjs` | Update the failed-review test that currently expects `reviewVerdict: "approved"`; assert `null` or absence. Add the same assertion against the `PIPELINE_ERROR` entry. Preserve fix/check failure tests where review did complete. |
| `test/bridge-static.test.mjs` | If static string assertions require review fields, update them to check the helper/contract instead of unconditional field presence. |
| `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs` | Generated by `npm run build`; do not hand-edit. |

Behavior change:

- Failed review before completion: `reviewVerdict` and `reviewFindingCount` become `null` or absent.
- Failed fix/check after completed review: review verdict/count remain populated.
- `completedStages` remains the prefix of stages that actually completed.
- `failing_stage` remains the canonical failed/stalled stage.

Verification:

- A review non-zero-status fixture emits no approved review verdict.
- A review timeout fixture emits no approved review verdict.
- A fix failure after a `must-fix` review still emits `reviewVerdict: "must-fix"` and the finding count.
- No failed pipeline emits `PIPELINE_COMPLETE`.

Rollback:

- Revert the helper and test updates as one commit if downstream consumers cannot handle `null` review fields. Because the generated scripts are build artifacts, revert them with the source commit.

### Cluster B — Origin/Failing-Stage Semantics

Likely files:

| File | Change |
|---|---|
| `src/adapters/codex/pipeline.mjs` | Add `lastCompletedStage` to error payloads and return values. Set `origin: pipeline:<failing_stage>` for terminal pipeline aborts. |
| `skill/references/notification-format.md` | State: `origin` and `failing_stage` identify the failed stage; `lastCompletedStage` records prior progress; review fields are `null`/absent unless review completed. |
| `skill/references/ndjson-guide.md` | Expand `PIPELINE_ERROR` field list to include `failing_stage`, `lastCompletedStage`, and conditional review fields. |
| `plugin/skills/codex-bridge/references/*` | Keep plugin reference wording aligned if these are not generated from `skill/references`. |
| `test/session-log.test.mjs` | Assert the rendered recovery guidance does not imply `origin` is the failed stage. |

Behavior change:

- Consumers can branch on either `origin` or `failing_stage` without resolving a contradiction.
- Consumers that already filter `origin.startsWith("pipeline:")` keep working.
- Consumers that need prior progress read `lastCompletedStage` instead of parsing `origin`.
- Documentation stops teaching two incompatible readings of `origin`.

Verification:

- `formatErrorEvent` renders pipeline recovery actions for `origin: pipeline:review` and `failingStage: review`.
- Docs and tests agree on `origin` semantics.
- No plan requires consumers to parse the `error` string to know the failed stage.

Rollback:

- If the origin migration causes downstream schema concerns, revert only the `origin` derivation to the previous last-completed suffix while keeping `lastCompletedStage` and null review fields. That restores prior routing without reintroducing invented review success.

## Risk Notes

| Risk | Mitigation |
|---|---|
| Existing consumers treat `reviewVerdict` as always a string. | Use `null` rather than key omission, update docs, and mention the contract change in `CHANGELOG.md` if implementation lands in a release branch. |
| Changing `origin` breaks monitors that used the suffix as last-completed context. | Keep the `pipeline:` prefix stable, add `lastCompletedStage` as the explicit replacement, and update skill/plugin docs. |
| Helper accidentally strips valid review verdicts from fix/check failures. | Add explicit tests for failed fix/check after completed review. |
| Build drift between source and generated CLI bundles. | Run `npm run build`; review only generated diffs corresponding to source changes. |
| Concurrent agents already modified many files. | Read every file before editing, keep changes narrowly scoped, stage only touched files, and do not reformat adjacent code. |

## Acceptance Criteria

| Case | Acceptance check |
|---|---|
| `14.15` failed review status | A fixture where review returns non-zero before completion produces `PIPELINE_ERROR.data.failing_stage === "review"`, `completedStages === ["diff"]`, and `reviewVerdict`/`reviewFindingCount` are `null` or absent in both NDJSON and returned `result.pipeline`. |
| `14.15` review timeout | A fixture where `auto-review` times out before completion produces the same no-verdict contract and does not emit `PIPELINE_COMPLETE` or `[DONE]`. |
| `14.15` later-stage failure | A fixture where review completes with findings and fix fails still preserves the completed review verdict/count, proving the guard is terminal-state based rather than blanket deletion. |
| `14.15` origin semantics | Docs and tests prove `origin === "pipeline:${failing_stage}"` and `lastCompletedStage` carries the previous completed stage. |

## Out Of Scope

- Redesigning all pipeline events into a full per-stage object schema.
- Reworking terminal-tag truth or result/status consistency outside this `PIPELINE_ERROR` payload.
- Fixing monitor lifecycle, `events --follow`, status aggregation, cancel cleanup, worktree isolation, base-ref behavior, no-pipeline handling, or result-summary rendering from other feedback files.
- Changing Codex app-server protocol behavior.
- Broad documentation rewrites beyond the exact event-contract references needed for this case.
