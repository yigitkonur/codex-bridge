---
status: resolved
trigger: "14.12 focus case: [DONE] block reports cumulative workspace diff, not per-task diff"
created: 2026-05-06
updated: 2026-05-06
---

# Debug Session: 14.12 Done Block Task Diff

## Symptoms

- expected_behavior: "`[DONE]` summarizes what the specific job changed; workspace-wide dirty state is clearly separate context."
- actual_behavior: "`[DONE]` can show the cumulative `git diff HEAD` for the execution cwd, so read-only/no-op jobs in dirty workspaces appear to have changed many files."
- error_messages: "No thrown error; misleading terminal event text. Underlying ndjson may still show `TURN_COMPLETED.touchedFiles: []`."
- timeline: "Observed in the focused 14.12 field report across multiple parallel jobs."
- reproduction: "Run a no-pipeline or read-only/no-op task in a dirty workspace and inspect the terminal `[DONE]` block."

## Current Focus

- hypothesis: "Confirmed: final `[DONE]` stats were built from end-of-run workspace `git diff HEAD` snapshots and rendered as the headline job result; per-turn `touchedFiles` was recorded separately but not used for the human headline."
- test: "Source trace plus one-off runtime reproduction against the current working tree's task/workspace split behavior."
- expecting: "Minimal fix should make the headline use `task_diff` and render cumulative `workspace_diff` as explicitly labeled secondary context."
- next_action: "Resolved in current working tree; keep task/workspace diff tests green through build/test."
- reasoning_checkpoint:
  hypothesis: "`captureGitDiff(cwd)` defaults to `HEAD`, so final notification call sites that pass its `diffStat/files` into `formatDoneEvent` conflate pre-existing dirty workspace state with this task's changes."
  confirming_evidence:
    - "Committed `src/lib/task-runtime.mjs` skipped auto-pipeline for `request.noPipeline`, then called `captureGitDiff(request.cwd, session)` and passed `diff.diffStat/files` directly to `formatDoneEvent`."
    - "Committed `src/adapters/codex/pipeline.mjs` fell back to `captureGitDiff(cwd, session)` when task metadata lacked `base_sha/base_ref`, then passed that as final `[DONE]` stats."
    - "`TURN_COMPLETED` records `touchedFiles`, but the formatter call did not use that field for the headline."
  falsification_test: "A dirty-workspace, no-op/read-only task would refute this only if `[DONE]` displayed `0 files | +0 -0` while showing the pre-existing dirty diff under a separate workspace label."
  fix_rationale: "Compute/pass separate `taskDiff` and `workspaceDiff`; for non-worktree tasks without a base ref, derive task identity from `touchedFiles` or a start snapshot instead of `git diff HEAD`."
  blind_spots: "Line-number evidence uses committed HEAD plus current dirty working tree, which already contains partial 14.12 fix scaffolding; source was not edited or normalized in this mission."
- tdd_checkpoint:

## Evidence

- timestamp: 2026-05-06
  source: "codex-bridge-feedback/codex/14-real-world-failure-cases/12-P1-done-block-cumulative-vs-task-diff.md"
  observation: "Two independent reports saw `[DONE]` lines show the same large file/line stats for jobs whose ndjson `touchedFiles` was empty."
- timestamp: 2026-05-06
  checked: ".planning/debug/knowledge-base.md"
  found: "No knowledge-base entry was present for this symptom in the active debug directory."
  implication: "Proceed with source-grounded investigation rather than treating this as a known-pattern match."
- timestamp: 2026-05-06
  checked: "Committed `src/lib/session-log.mjs` (`git show HEAD`) lines 226-242 and 406-424."
  found: "`captureGitDiff` defaulted to `baseRef = HEAD` and returned aggregate `diffStat/files`; `formatDoneEvent` rendered the supplied `diffStat` directly in the `[DONE] ... | ${diffStat}` headline with no task/workspace distinction."
  implication: "The formatter made the caller's diff semantics visible as job outcome semantics."
- timestamp: 2026-05-06
  checked: "Committed `src/lib/task-runtime.mjs` (`git show HEAD`) lines 2372-2452."
  found: "`request.noPipeline` only wrote `PIPELINE_SKIPPED`; the auto-pipeline was skipped, then the direct terminal path ran `captureGitDiff(request.cwd, session)` and passed that workspace diff into `formatDoneEvent`."
  implication: "The field report's `--no-pipeline` no-op/read-only case is directly explained by the no-pipeline branch."
- timestamp: 2026-05-06
  checked: "Committed `src/adapters/codex/pipeline.mjs` (`git show HEAD`) lines 63-70 and 421-446."
  found: "Auto-pipeline used task `base_sha/base_ref` when present, but otherwise `captureTaskDiff()` fell back to `captureGitDiff(cwd, session)` and emitted that as `[DONE]` final stats."
  implication: "Worktree/registry-backed jobs can have task-relative stats; non-worktree/no-metadata jobs fall back to cumulative workspace stats."
- timestamp: 2026-05-06
  checked: "Current dirty working tree one-off runtime reproduction."
  found: "A read-only no-op task in a dirty repo now prints `[DONE] ... | task_diff: 0 files | +0 -0`, then `workspace_diff: 1 files | +1 -0` and `touchedFiles: []`."
  implication: "The already-present uncommitted scaffolding validates the minimal direction: split task and workspace diffs at the formatter boundary."

## Eliminated

- hypothesis: "Codex incorrectly reported touched files for the no-op jobs."
  evidence: "The field report and source both show `TURN_COMPLETED.touchedFiles: []` can exist while the human `[DONE]` line reports large file/line stats."
  timestamp: 2026-05-06
- hypothesis: "The problem is only a wording bug inside `formatDoneEvent`."
  evidence: "`formatDoneEvent` rendered exactly what callers passed; the semantic error started when final notification paths supplied workspace `captureGitDiff(...HEAD...)` data as the headline diff."
  timestamp: 2026-05-06

## Resolution

- root_cause: "Final `[DONE]` notification paths conflated two contracts. `captureGitDiff(cwd)` measures cumulative dirty state versus `HEAD`, including pre-existing staged/unstaged/untracked files. `runBridgeTask`'s committed no-pipeline terminal path and `runAutoPipeline`'s no-metadata fallback passed that aggregate diff into `formatDoneEvent`, whose headline reads as 'this job changed N files'. Per-task evidence (`TURN_COMPLETED.touchedFiles`) was available separately but not used for the headline."
- fix: "Applied in the current working tree: `formatDoneEvent` now accepts explicit `taskDiff`, `workspaceDiff`, `workspaceWasClean`, and `touchedFiles`; task runtime and auto-pipeline compute task-relative stats from registry base refs, clean-start snapshots, or `touchedFiles`, while keeping cumulative workspace state as a labeled secondary field. `--no-pipeline` retains diff/final-reporting and skips only review/fix/check."
- verification: "Rung 3 — focused unit/integration tests passed: `node --test test/session-log.test.mjs`, `node --test test/auto-pipeline-turn-watchdog.test.mjs`, and `node --test test/handler-runtime.test.mjs`. Standard repo checks also passed: `npm run build` and `npm test`."
- files_changed:
  - src/lib/session-log.mjs
  - src/lib/task-runtime.mjs
  - src/adapters/codex/pipeline.mjs
  - test/session-log.test.mjs
  - test/auto-pipeline-turn-watchdog.test.mjs
  - test/handler-runtime.test.mjs
