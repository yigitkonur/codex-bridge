---
status: resolved
trigger: "14.05 focus case: --no-pipeline with --write silently no-ops the task while reporting DONE"
created: 2026-05-06
updated: 2026-05-06
---

# Debug Session: no-pipeline-flag-noop-05

## Symptoms

- expected_behavior: "`task --write --no-pipeline` should still run the Codex turn and keep useful diff observability while skipping slower review/fix/check validation stages."
- actual_behavior: "Reported jobs completed quickly with DONE and no touched files; cumulative dirty workspace diff could make the no-op look successful."
- error_messages: "No explicit error; the failure mode is a false-success no-op."
- reproduction: "Dispatch a write-mode task with `--background --write --no-pipeline` where Codex returns zero status but touches no files."

## Current Focus

- hypothesis: "`--no-pipeline` does not block the Codex turn; it skips the entire auto-pipeline and then unconditionally emits `[DONE]` for any zero-exit turn, even when a write-mode run touched no files."
- test: "Trace task parsing, background request persistence, task runtime, Codex adapter touchedFiles capture, auto-pipeline stages, and terminal event rendering."
- expecting: "Minimal fix should add a no-op write guard for `--write --no-pipeline` and clarify docs/tests; it should not invent a diff-application stage because pipeline diff only captures git diff."
- next_action: "Resolved in runtime/tests/docs."

## Evidence

- checked: "Task argument parsing and request propagation"
  found: "`src/handlers/task.mjs` parses `--no-pipeline` as a boolean and passes it into foreground/background `runBridgeTask` requests."
  implication: "Foreground and background runs share the same runtime bug surface."

- checked: "Codex turn dispatch path"
  found: "`executeTaskRun` dispatches the Codex turn before any pipeline/noPipeline branch and exposes `touchedFiles` from Codex file-change notifications."
  implication: "`--no-pipeline` does not itself prevent the Codex turn from running."

- checked: "`runAutoPipeline` stage semantics"
  found: "Pipeline `diff` stage only calls `captureGitDiff`; it does not apply a proposed diff."
  implication: "The report is overstated on mechanism: there is no bridge diff-application stage to skip."

- checked: "`request.noPipeline` terminal path"
  found: "When `request.noPipeline` was true, runtime logged `PIPELINE_SKIPPED`, bypassed `runAutoPipeline`, captured `git diff HEAD`, emitted `[DONE]`, and set phase `done` without checking `request.write` or `result.payload.touchedFiles`."
  implication: "The silent success/no-op part of the report is real."

## Eliminated

- hypothesis: "`--no-pipeline` prevents the Codex turn from starting."
  evidence: "`executeTaskRun` is called before the runtime branches on `request.noPipeline`."

- hypothesis: "The auto-pipeline `diff` stage is what applies Codex edits to disk."
  evidence: "`runAutoPipeline` stage `diff` emits pipeline events and calls `captureGitDiff`; no patch/apply code exists in that stage."

## Resolution

- root_cause: "`--no-pipeline` was implemented as a full auto-pipeline bypass followed by unconditional success rendering for any zero-exit Codex turn. The implementation did not guard `--write` runs that produced `touchedFiles: []`, and it reported cumulative `git diff HEAD`, so pre-existing workspace changes could make a no-op task look successful."
- fix: "`--no-pipeline` keeps diff capture while skipping review/fix/check, and write-mode no-op runs return `[INCOMPLETE] no_files_touched`."
- verification: "`npm run build` passed. `node --test test/handler-runtime.test.mjs test/auto-pipeline-turn-watchdog.test.mjs test/session-log.test.mjs test/bridge-static.test.mjs test/baseline-contracts.test.mjs test/broker-lifecycle.test.mjs` passed with 87 passing, 0 failing. Full `npm test` was attempted; the no-pipeline tests passed, but unrelated pre-existing `test/git-worktree.test.mjs` merge/worktree cleanup cases failed on this branch lineage."
- files_changed: ["src/lib/work-delta.mjs", "src/lib/task-runtime.mjs", "src/adapters/codex/pipeline.mjs", "src/lib/session-log.mjs", "test/handler-runtime.test.mjs", "test/auto-pipeline-turn-watchdog.test.mjs", "test/bridge-static.test.mjs", "test/session-log.test.mjs", "skill/SKILL.md", "skill/references/command-reference.md", "skill/references/error-recovery.md", "skill/references/ndjson-guide.md", "skill/references/notification-format.md", "plugin/skills/codex-bridge/references/error-recovery.md", ".planning/debug/14-05-no-pipeline-flag-noop-gsd-plan.md"]
