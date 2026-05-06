---
status: resolved
trigger: "14.05 focus case: --no-pipeline with --write silently no-ops the task while reporting DONE"
created: 2026-05-05
updated: 2026-05-06
---

# Debug Session: no-pipeline-flag-noop-05

## Symptoms

- expected_behavior: "`task --write --no-pipeline` should still run the Codex turn and apply the produced diff, while skipping slower review/fix/check validation stages."
- actual_behavior: "Reported jobs completed quickly with DONE and no touched files; the focus report claims the flag skips the entire pipeline including diff application."
- error_messages: "No explicit error; the failure mode is a false-success no-op."
- timeline: "Observed in Agent 3 batch 2 after users tried to work around auto-review pipeline timeouts."
- reproduction: "Dispatch a write-mode task with `--background --write --no-pipeline`."

## Current Focus

- hypothesis: "`--no-pipeline` does not block the Codex turn or bridge-side edit application; it skips the whole auto-pipeline and then unconditionally emits `[DONE]` for any zero-exit turn, even when a write-mode run touched no files."
- test: "Source trace completed across task parsing, background request persistence, task runtime, Codex adapter touchedFiles capture, auto-pipeline stages, and terminal event rendering."
- expecting: "Minimal fix should add a no-op write guard for `--write --no-pipeline` and clarify docs/tests; it should not invent a diff-application stage because pipeline diff only captures git diff."
- next_action: "Resolved in runtime/tests/docs; monitor unrelated full-suite plugin-surface failure separately."
- reasoning_checkpoint:
- tdd_checkpoint:

## Evidence

- timestamp: 2026-05-06
  checked: "Implemented runtime fix"
  found: "`--no-pipeline` now runs diff-only pipeline reporting, and pipeline completion receives the task-start git snapshot plus turn touched files."
  implication: "Skipping validation no longer removes task-diff observability."

- timestamp: 2026-05-06
  checked: "Implemented no-op guard"
  found: "Write-mode runs with no touched files and unchanged git state now emit `[INCOMPLETE]` with `no_files_touched` instead of `[DONE]`."
  implication: "A pre-existing dirty workspace can no longer make this no-op failure mode look successful."

- timestamp: 2026-05-06
  checked: "Focus report `05-P0-no-pipeline-flag-silently-no-ops-the-task.md`"
  found: "Report claims `task --background --write --no-pipeline` returned `[DONE]` with `touchedFiles: []` and misleading cumulative diff stats; proposed contract is skip review/fix/check while preserving useful write behavior."
  implication: "Symptoms are coherent and map to task runtime/pipeline flags; report's mechanism needed source validation."

- timestamp: 2026-05-06
  checked: "Task argument parsing and request propagation"
  found: "`src/handlers/task.mjs` parses `--no-pipeline` as a boolean, passes it into both background `buildTaskRequest` and foreground `runBridgeTask`; `buildTaskRequest` persists `noPipeline: Boolean(noPipeline)`."
  implication: "Foreground and background runs share the same noPipeline runtime flag, so the reported background behavior can come from the common runtime path."

- timestamp: 2026-05-06
  checked: "Codex turn dispatch path"
  found: "`executeTaskRun` dispatches the Codex turn before any pipeline/noPipeline branch and exposes `touchedFiles` from Codex `fileChange` notifications."
  implication: "`--no-pipeline` does not itself prevent the Codex turn from running or prevent Codex tool/file changes from being applied."

- timestamp: 2026-05-06
  checked: "`runAutoPipeline` stage semantics"
  found: "Pipeline `diff` stage only calls `captureGitDiff`; it does not apply a proposed diff. Review/check are validation calls; fix is a follow-up Codex turn only if review findings exist."
  implication: "The report is overstated on mechanism: there is no bridge diff-application stage in the current source to skip."

- timestamp: 2026-05-06
  checked: "`request.noPipeline` terminal path"
  found: "When `request.noPipeline` is true, runtime logs `PIPELINE_SKIPPED`, bypasses `runAutoPipeline`, captures `git diff HEAD`, emits `formatDoneEvent`, and sets phase `done` without checking `request.write` or `result.payload.touchedFiles`."
  implication: "The silent success/no-op part of the report is real: a zero-exit write-mode turn with no file changes becomes `[DONE]`."

- timestamp: 2026-05-06
  checked: "`captureGitDiff` and `[DONE]` formatting"
  found: "`captureGitDiff` summarizes current workspace diff against `HEAD` including untracked files; `formatDoneEvent` prints that diff stat."
  implication: "If the workspace was already dirty, `[DONE]` can show large pre-existing diff stats even when the current task touched zero files."

- timestamp: 2026-05-06
  checked: "Existing tests"
  found: "`test/handler-runtime.test.mjs` has a task-worker regression with `noPipeline: true` and fake `touchedFiles: []`, then asserts the stored job is `completed`."
  implication: "Current test coverage locks in the false-success behavior instead of guarding against no-op write tasks."

## Eliminated

- hypothesis: "`--no-pipeline` prevents the Codex turn from starting."
  evidence: "`executeTaskRun` calls `adapter.dispatch` and only later branches on `request.noPipeline` after `result.exitStatus` is known."
  timestamp: 2026-05-06

- hypothesis: "The auto-pipeline `diff` stage is what applies Codex edits to disk."
  evidence: "`runAutoPipeline` stage `diff` only emits pipeline events and calls `captureGitDiff`; no patch/apply code exists in the stage."
  timestamp: 2026-05-06

## Resolution

- root_cause: "`--no-pipeline` is implemented as a full auto-pipeline bypass followed by unconditional success rendering for any zero-exit Codex turn. The implementation does not guard `--write` runs that produce `touchedFiles: []`, and it reports cumulative `git diff HEAD`, so pre-existing workspace changes can make a no-op task look successful. The report is real for silent-DONE/no-op behavior, but overstated in saying the skipped pipeline diff stage applies edits."
- fix: "Implemented: `--no-pipeline` keeps diff capture while skipping review/fix/check, and write-mode no-op runs return `[INCOMPLETE] no_files_touched`. Docs and regression tests were updated."
- verification: "`npm run build` passed; `node --test test/handler-runtime.test.mjs test/auto-pipeline-turn-watchdog.test.mjs test/bridge-static.test.mjs test/baseline-contracts.test.mjs` passed; full `npm test` passed with 420 passing, 1 skipped, 0 failing."
- files_changed: ["src/lib/task-runtime.mjs", "src/adapters/codex/pipeline.mjs", "test/handler-runtime.test.mjs", "test/auto-pipeline-turn-watchdog.test.mjs", "test/bridge-static.test.mjs", "skill/SKILL.md", "skill/references/command-reference.md", "skill/references/error-recovery.md", "skill/references/ndjson-guide.md", "skill/references/notification-format.md", "plugin/skills/codex-bridge/references/error-recovery.md", "skill/scripts/codex-bridge.mjs", "plugin/scripts/codex-bridge.mjs", ".planning/debug/14-05-no-pipeline-flag-noop-gsd-plan.md"]
