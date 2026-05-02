---
phase: 03-review-verdict-and-iterate-loop
plan: 03-02
subsystem: review
tags: [codex-bridge, auto-pipeline, completion-check, partial-state, generated-bundles]
requires:
  - phase: 03-01
    provides: normalized native and adversarial review result contract
provides:
  - auto-pipeline native review parsing through the shared review-result parser
  - fail-closed invalid completion-check handling
  - explicit pipeline stage, budget, review, fix, completion, and partial-state proof
  - baseline contract coverage for auto-pipeline partial-completion proof
affects: [auto-pipeline, task, review, session-events, baseline-contracts]
tech-stack:
  added: []
  patterns:
    - shared native review parsing in auto-pipeline
    - pipeline result object as the source of truth for task envelope partial proof
    - generated bundle synchronization through npm run build
key-files:
  created:
    - .planning/phases/03-review-verdict-and-iterate-loop/03-02-SUMMARY.md
  modified:
    - src/adapters/codex/pipeline.mjs
    - src/lib/session-log.mjs
    - src/codex-bridge.mjs
    - scripts/baseline-contracts.mjs
    - test/auto-pipeline-turn-watchdog.test.mjs
    - test/bridge-static.test.mjs
    - test/baseline-contracts.test.mjs
    - skill/scripts/codex-bridge.mjs
    - plugin/scripts/codex-bridge.mjs
key-decisions:
  - "Auto-pipeline native review findings now use the shared review-result parser and normalized verdict vocabulary."
  - "Malformed completion-check output is an incomplete check-stage result, never a heuristic success."
  - "Pipeline result, NDJSON, and terminal events share the same failing_stage and partial-state vocabulary."
patterns-established:
  - "Pipeline result payloads expose completedStages, failing_stage, stageTimeoutMs, totalTimeoutMs, reviewVerdict, reviewFindingCount, fixFilesTouched, completion, partial, missingItems, and completionSummary together."
  - "Task envelopes preserve the full pipeline result object rather than recomputing partial state from logs."
requirements-completed: [REVW-02]
duration: 10min
completed: 2026-05-02
---

# Phase 3 Plan 03-02: Auto-pipeline Partial-completion and Check-stage Proof Summary

**Auto-pipeline now fails closed on malformed completion checks and returns explicit stage, budget, review, fix, completion, and partial-state proof.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-05-02T03:30:36Z
- **Completed:** 2026-05-02T03:40:10Z
- **Tasks:** 5
- **Files modified:** 9

## Accomplishments

- Removed the pipeline-local native review parser wrapper and routed native review extraction through `parseNativeReviewText`.
- Changed malformed completion-check text to `complete: false` with `completion-check invalid-json` and actionable missing-item guidance.
- Added explicit partial-completion proof fields to pipeline returns, `PIPELINE_COMPLETE`, `PIPELINE_ERROR`, and `[INCOMPLETE]` event output.
- Updated task baseline contracts so static coverage names auto-pipeline stage/budget/partial-completion proof without claiming live review smoke.
- Regenerated the legacy skill and packaged plugin CLI bundles from source.

## Task Commits

1. **Task 03-02-01: Reuse shared review parsing in auto-pipeline** - `b85b605` (feat)
2. **Task 03-02-02: Fail closed on invalid completion-check JSON** - `8c62ce2` (fix)
3. **Task 03-02-03: Expose explicit partial and budget state** - `bcb8f6c` (feat)
4. **Task 03-02-04: Update baseline contracts for auto-pipeline proof** - `a5e7042` (test)
5. **Task 03-02-05: Regenerate bundles** - `0f3d6d5` (chore)

## Files Created/Modified

- `src/adapters/codex/pipeline.mjs` - Shared parser use, invalid-JSON fail-closed handling, and explicit pipeline proof result fields.
- `src/lib/session-log.mjs` - `[INCOMPLETE]` event formatting now includes `failing_stage` when known.
- `src/codex-bridge.mjs` - Task incomplete next-action logic reads `pipelineResult.failing_stage`.
- `scripts/baseline-contracts.mjs` - Task coverage now names auto-pipeline stage/budget/partial-completion proof.
- `test/auto-pipeline-turn-watchdog.test.mjs` - Covers parser-triggered fix, invalid JSON, review/fix/check failures, timeout, and success proof fields.
- `test/bridge-static.test.mjs` - Pins task envelope preservation of pipeline partial-proof fields.
- `test/baseline-contracts.test.mjs` - Pins baseline contract coverage text and failure-test mapping.
- `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs` - Generated CLI bundles refreshed by `npm run build`.

## Decisions Made

- Used normalized review verdicts (`approved`, `needs-attention`, `must-fix`) inside auto-pipeline events and results to match the shared review-result contract.
- Treated completion-check parse errors as a check-stage incomplete result instead of throwing a terminal pipeline error, preserving artifacts while failing closed.
- Kept `touchedFiles` as a compatibility alias while adding the clearer `fixFilesTouched` field.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `test/baseline-contracts.test.mjs` initially failed on stale generated bundles after source changes. This was expected for the plan order and was resolved by the planned `npm run build` regeneration before rerunning the baseline tests and full static gate.

## Known Stubs

None. Stub scan matches were existing initializer/test-fixture patterns such as empty arrays and null defaults, not user-facing placeholder behavior or unwired data.

## Threat Flags

None. This plan changed local pipeline result/event contracts and generated bundles only; it did not add network endpoints, auth paths, file-access trust boundaries, or schema mutations at a trust boundary.

## Verification

- `npm run build` - passed
- `node --test test/auto-pipeline-turn-watchdog.test.mjs test/bridge-static.test.mjs` - passed, 46 passed
- `node --test test/baseline-contracts.test.mjs` - passed, 5 passed
- `npm run verify:static` - passed, including `npm test` with 316 passed and 3 skipped, plus `Baseline contracts: OK`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

REVW-02 is satisfied for static coverage: downstream verdict/iterate work can now trust `pipeline` results for stage, budget, review, fix, check, partial, and missing-item proof. Authenticated live review smoke remains deferred to Phase 6.

## Self-Check

PASSED - summary file exists, task commits `b85b605`, `8c62ce2`, `bcb8f6c`, `a5e7042`, and `0f3d6d5` were verified in git history, and shared `.planning/STATE.md` / `.planning/ROADMAP.md` were not modified.

---
*Phase: 03-review-verdict-and-iterate-loop*
*Completed: 2026-05-02*
