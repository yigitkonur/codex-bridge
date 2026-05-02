---
phase: 3
plan: 03-03
name: Verdict, approved-head merge, and iterate orchestration
subsystem: review-verdict-iterate-loop
tags:
  - verdict
  - merge-safety
  - iterate
  - plugin-surface
  - baseline-contracts
requirements:
  - REVW-03
  - REVW-04
dependency_graph:
  requires:
    - 03-01
    - 03-02
  provides:
    - branch-bound verdict recording
    - approved-head merge readiness
    - implemented iterate review loop
    - iterate baseline contract coverage
  affects:
    - src/codex-bridge.mjs
    - src/lib/iterate-loop.mjs
    - plugin/commands/iterate.md
    - plugin/commands/verdict.md
    - plugin/commands/verdicts.md
    - plugin/commands/merge.md
    - plugin/agents/codex-bridge-reviewer.md
    - plugin/skills/codex-bridge/references/orchestration-flows.md
    - scripts/baseline-contracts.mjs
    - test/iterate-loop.test.mjs
    - test/plugin-surfaces.test.mjs
    - test/git-worktree.test.mjs
    - test/baseline-contracts.test.mjs
    - skill/scripts/codex-bridge.mjs
    - plugin/scripts/codex-bridge.mjs
tech_stack:
  added:
    - pure injectable iterate-loop helper
  patterns:
    - source-first runtime changes with generated bundle refresh
    - branch-head based merge readiness
    - stdin JSON payloads for untrusted review data
key_files:
  created:
    - src/lib/iterate-loop.mjs
    - test/iterate-loop.test.mjs
  modified:
    - src/codex-bridge.mjs
    - plugin/commands/iterate.md
    - plugin/commands/verdict.md
    - plugin/commands/verdicts.md
    - plugin/commands/merge.md
    - plugin/agents/codex-bridge-reviewer.md
    - plugin/skills/codex-bridge/references/orchestration-flows.md
    - scripts/baseline-contracts.mjs
    - test/plugin-surfaces.test.mjs
    - test/git-worktree.test.mjs
    - test/baseline-contracts.test.mjs
    - skill/scripts/codex-bridge.mjs
    - plugin/scripts/codex-bridge.mjs
decisions:
  - Preserve full verdict stdin payload metadata as JSON data and normalize branch SHA aliases to branch_head_sha.
  - Treat merge readiness as derived state with explicit blockers instead of a separate persisted approval flag.
  - Implement iterate orchestration through an injectable helper so task/review/verdict/follow-up failures are independently testable.
  - Keep follow-up review text out of shell argv by using task-bound review artifacts and payload-stdin verdict writes.
metrics:
  completed_at: 2026-05-02T23:42:38Z
  duration: not measured - manual executor without SDK timing support
  tasks_completed: 5
  commits: 5 task commits plus this summary commit
---

# Phase 3 Plan 03-03: Verdict, approved-head merge, and iterate orchestration Summary

## One-Liner

Branch-bound verdicts with approved-head merge safety and a real iterate loop that runs task -> review -> verdict -> follow-up until approval or explicit incomplete state.

## Completed Tasks

| Task | Name | Commit | Key Files |
| --- | --- | --- | --- |
| 03-03-01 | Wire verdict --payload-stdin | b618b11 | `src/codex-bridge.mjs`, `test/plugin-surfaces.test.mjs` |
| 03-03-02 | Expose branch-bound verdict and pending merge readiness | 69a85c1 | `src/codex-bridge.mjs`, `test/git-worktree.test.mjs` |
| 03-03-03 | Implement iterate orchestration helper | ff1e769 | `src/codex-bridge.mjs`, `src/lib/iterate-loop.mjs`, `test/iterate-loop.test.mjs`, `test/plugin-surfaces.test.mjs` |
| 03-03-04 | Update plugin commands and reviewer handoff | 858ad4a | `plugin/commands/*.md`, `plugin/agents/codex-bridge-reviewer.md`, `test/plugin-surfaces.test.mjs` |
| 03-03-05 | Remove Phase 3 baseline gap and regenerate bundles | b5d88a0 | `scripts/baseline-contracts.mjs`, generated `skill/` and `plugin/` bundles, plugin skill reference |

## What Changed

- Verdict stdin writes now preserve untrusted review payload fields as JSON data, reject conflicting mutation modes before mutation, and normalize `branch_head_sha`, `reviewed_branch_head_sha`, and `branchHeadSha` into the branch-head contract used by merge.
- Pending verdict output now reports `merge_ready`, blocker codes, current branch head, reviewed branch head, and the next merge action so stale or incomplete approvals are diagnosable.
- `iterate` now uses a real loop helper with tested statuses for approval, iteration limits, task failure, review failure, verdict failure, and follow-up dispatch failure.
- Plugin commands and reviewer handoff docs now describe implemented iterate statuses, task-bound review artifacts, payload-stdin verdict writes, and approved-head merge safety.
- Baseline contracts now mark iterate as implemented with real success and failure tests, and generated runtime bundles were refreshed with `npm run build`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical coverage] Hardened already-present verdict stdin behavior**
- **Found during:** Task 03-03-01
- **Issue:** 03-01 had already introduced verdict stdin support, but 03-03 still needed the stricter preservation, alias normalization, SHA validation, and negative-mode coverage from this plan.
- **Fix:** Verified the existing path, filled the missing behavior and tests, and documented it instead of duplicating the parser.
- **Files modified:** `src/codex-bridge.mjs`, `test/plugin-surfaces.test.mjs`
- **Commit:** b618b11

**2. [Rule 2 - Contract documentation drift] Updated stale plugin skill reference**
- **Found during:** Task 03-03-05 stale-contract sweep
- **Issue:** `plugin/skills/codex-bridge/references/orchestration-flows.md` still described iterate as staged after implementation and docs updates.
- **Fix:** Updated the reference to describe the implemented loop and explicit incomplete statuses.
- **Files modified:** `plugin/skills/codex-bridge/references/orchestration-flows.md`
- **Commit:** b5d88a0

## Known Stubs

None. Stub-pattern scanning on changed source, tests, scripts, and plugin docs produced only ordinary option defaults, test fixtures, or existing placeholder-word comments unrelated to UI/runtime stubs.

## Verification

| Command | Result |
| --- | --- |
| `npm run build` | PASS |
| `node --test test/plugin-surfaces.test.mjs test/git-worktree.test.mjs test/registry.test.mjs test/iterate-loop.test.mjs` | PASS - 83 tests, 80 passed, 3 skipped |
| `npm run verify:static` | PASS - build, full `npm test` 331 tests / 328 passed / 3 skipped, baseline contracts OK |
| `rg -n 'not-yet-orchestrated' src test scripts plugin` | PASS - no matches |
| `rg -n 'staged.*iterate|iterate.*staged|staged orchestration|manual task/review/verdict' src test scripts plugin` | PASS - no matches |

## Acceptance Criteria

- REVW-03 satisfied: verdict recording, pending inspection, and approved-head merge safety are implemented and tested.
- REVW-04 satisfied: iterate performs real orchestration through injectable production helpers and returns explicit incomplete states with artifact pointers.
- The old staged iterate baseline gap is removed only after tests prove the new loop.

## Self-Check: PASSED

- Summary file exists at `.planning/phases/03-review-verdict-and-iterate-loop/03-03-SUMMARY.md`.
- Task commits found: b618b11, 69a85c1, ff1e769, 858ad4a, b5d88a0.
- No tracked file deletions were introduced by task commits.
- `.planning/STATE.md` and `.planning/ROADMAP.md` were intentionally left unchanged for orchestrator-owned tracking.
