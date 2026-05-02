---
phase: 03-review-verdict-and-iterate-loop
plan: 03-01
subsystem: review
tags: [codex-bridge, review, registry, plugin, generated-bundles]
requires:
  - phase: 02
    provides: task registry and plugin command foundations
provides:
  - normalized native and adversarial review result contract
  - task-bound review execution context with reviewed HEAD binding
  - persisted registry review.json artifacts
  - plugin and reviewer surfaces aligned with implemented review flags
affects: [review, adversarial-review, verdict, iterate, merge, registry]
tech-stack:
  added: []
  patterns:
    - shared review-result normalization module
    - task registry artifact helpers for review.json
    - generated bundle synchronization through npm run build
key-files:
  created:
    - src/lib/review-result.mjs
    - test/review-result.test.mjs
  modified:
    - src/codex-bridge.mjs
    - src/adapters/codex/pipeline.mjs
    - src/lib/registry.mjs
    - src/prompts/adversarial-review.md
    - plugin/commands/review.md
    - plugin/commands/adversarial-review.md
    - plugin/commands/verdict.md
    - plugin/agents/codex-bridge-reviewer.md
    - scripts/baseline-contracts.mjs
    - plugin/scripts/codex-bridge.mjs
    - skill/scripts/codex-bridge.mjs
key-decisions:
  - "Normalized review outputs use bridge-owned wrapper fields while adversarial prompt output stays limited to raw schema fields."
  - "Task-bound review defaults to branch scope and rejects cwd conflicts before contacting Codex."
  - "review.json is written only through registry helpers after normalization and task metadata validation."
patterns-established:
  - "Review command surfaces return result.review_result with normalized keys for both native and adversarial review."
  - "Registry artifacts own schema_version, task_id, and timestamp fields at write time."
requirements-completed: [REVW-01, REVW-03]
duration: 20min
completed: 2026-05-02
---

# Phase 3 Plan 03-01: Native/adversarial review schema and context proof Summary

**Normalized task-bound native and adversarial reviews now persist registry review.json artifacts with reviewed HEAD proof.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-05-02T03:06:58Z
- **Completed:** 2026-05-02T03:26:46Z
- **Tasks:** 5
- **Files modified:** 18

## Accomplishments

- Added shared review-result normalization for native markdown review output and adversarial JSON output.
- Bound `review --task <task_id>` and `adversarial-review --task <task_id>` to registry task worktrees, default branch scope, and reviewed HEAD SHA capture.
- Persisted task-bound normalized reviews as stable `review.json` registry artifacts.
- Updated plugin commands, reviewer agent guidance, adversarial prompt wording, generated bundles, and baseline coverage.

## Task Commits

1. **Task 03-01-01: Create shared review-result normalization** - `c3700ab` (feat)
2. **Task 03-01-02: Bind review commands to task context** - `d1d225a` (feat)
3. **Task 03-01-03: Persist task-bound review artifacts** - `3132fed` (feat)
4. **Task 03-01-04: Align adversarial schema, prompt, and plugin surfaces** - `2f63f6e` (feat)
5. **Task 03-01-05: Regenerate bundles and update baseline coverage** - `600cdc5` (chore)

## Files Created/Modified

- `src/lib/review-result.mjs` - Shared normalized review contract, native parser, adversarial validator, and verdict mapping.
- `src/adapters/codex/pipeline.mjs` - Reuses shared native parsing for auto-pipeline review handling.
- `src/lib/registry.mjs` - Adds `readReview` and `writeReview` for registry `review.json` artifacts.
- `src/codex-bridge.mjs` - Wires task-bound review context, normalized review output, registry persistence, and verdict stdin payload parsing.
- `src/prompts/adversarial-review.md` - Clarifies raw adversarial schema output versus bridge wrapper fields.
- `plugin/commands/review.md`, `plugin/commands/adversarial-review.md`, `plugin/commands/verdict.md` - Document implemented task-bound review and JSON payload flows.
- `plugin/agents/codex-bridge-reviewer.md` - Directs reviewer flow through task-bound adversarial review and stdin verdict payloads.
- `test/review-result.test.mjs`, `test/registry.test.mjs`, `test/plugin-surfaces.test.mjs`, `test/adversarial-review-prompt.test.mjs` - Cover normalization, registry review persistence, task validation, generated/plugin docs, and prompt contract.
- `scripts/baseline-contracts.mjs` - Updates review/adversarial-review static coverage metadata while preserving live-smoke gaps.
- `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs`, `skill/prompts/adversarial-review.md`, `plugin/prompts/adversarial-review.md` - Generated outputs refreshed by `npm run build`.

## Decisions Made

- Kept adversarial model output schema small and raw, then added bridge-owned wrapper fields during normalization.
- Required task metadata to include usable worktree path and branch before review can run against a task.
- Parsed verdict stdin JSON as data instead of shell arguments so review text is never passed through a command-line string.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Wired `verdict --payload-stdin` parser**
- **Found during:** Task 03-01-04 (Align adversarial schema, prompt, and plugin surfaces)
- **Issue:** Plugin and reviewer surfaces needed a safe way to pass review verdict payloads, and docs already advertised stdin JSON payload behavior.
- **Fix:** Implemented stdin JSON parsing for `verdict --payload-stdin`, including SHA validation and tests that preserve untrusted review text as data.
- **Files modified:** `src/codex-bridge.mjs`, `plugin/commands/verdict.md`, `plugin/agents/codex-bridge-reviewer.md`, `test/plugin-surfaces.test.mjs`
- **Verification:** `node --test test/plugin-surfaces.test.mjs`; full plan verification passed.
- **Committed in:** `2f63f6e`

---

**Total deviations:** 1 auto-fixed (Rule 2)
**Impact on plan:** Required for correctness and security of the advertised review-to-verdict flow. No additional product scope was added.

## Issues Encountered

None. The full static test suite emitted the expected corrupt-state quarantine warning from the state recovery test and still passed.

## Known Stubs

None. Stub scan found only legitimate parser/test initializers and prompt placeholder assertions; no UI or data-source stubs were introduced.

## Threat Flags

None. The planned review target, artifact persistence, schema split, shell-injection, and generated-drift surfaces were covered by implementation and tests.

## Verification

- `npm run build` - passed
- `node --test test/review-result.test.mjs test/registry.test.mjs test/plugin-surfaces.test.mjs test/adversarial-review-prompt.test.mjs` - passed, 73 passed, 3 skipped
- `npm run verify:static` - passed, including `npm test` with 314 passed, 3 skipped, and baseline contracts OK

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 3 can now build iteration and verdict flows on top of persisted normalized review artifacts. The `iterate` command remains intentionally marked as a staged baseline gap until Plan 03-03 implements full orchestration.

## Self-Check

PASSED - summary file, created source/test files, and task commits `c3700ab`, `d1d225a`, `3132fed`, `2f63f6e`, and `600cdc5` were verified.

---
*Phase: 03-review-verdict-and-iterate-loop*
*Completed: 2026-05-02*
