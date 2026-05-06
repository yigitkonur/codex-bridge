---
status: resolved
trigger: "Focus case 03-P0-destructive-diff-not-flagged-or-paused: destructive Codex diffs are not flagged or paused before continuation."
created: 2026-05-06
updated: 2026-05-06
---

# Debug Session: P0 Destructive Diff Stop Gate

## Symptoms

- expected_behavior: "Destructive review/task diffs should be surfaced as a pause requiring explicit user confirmation before continuation."
- actual_behavior: "The focus critique claims destructive diffs can pass through review/auto-pipeline without a dedicated destructive-change pause."
- error_messages: "No runtime exception; the failure is a missing safety classification and pause contract."
- timeline: "Reported in the external codex-bridge feedback corpus as a current platform failure."
- reproduction: "Produce or review a diff that deletes files or removes most file contents, then observe whether the bridge flags and pauses before treating the result as approved or actionable."

## Current Focus

- hypothesis: "Confirmed: the auto-pipeline used diff capture as observability, then delegated safety judgment to native review text."
- test: "Added task-base and turn-start destructive diff tests covering reject, approve, and direct-write committed diffs."
- expecting: "High-risk diffs pause with a QUESTION request before review/fix/check; rejection or timeout returns INCOMPLETE."
- next_action: "None for this focus case; broader sensitive-path matching and Monitor redesign remain out of scope."
- reasoning_checkpoint: "Worktree-auto reduces direct checkout blast radius, but a committed destructive task branch still needs a deterministic pre-review pause."
- tdd_checkpoint: "Regression tests fail without the pipeline gate because review/fix mocks are invoked before any user decision."

## Evidence

- `runAutoPipeline` now captures task-base or turn-start diffs for risk, classifies file stats, emits `[PIPELINE:diff:large_change]`, and pauses through the existing pending-request IPC when configured for `pause`.
- `captureGitDiff` exposes structured `fileStats`, allowing the classifier to use deletion and changed-file thresholds instead of parsing display text.
- Config defaults/schema now include `destructive_diff_mode`, `destructive_diff_lines_deleted`, and `destructive_diff_files_changed`.
- Focused tests cover rejected destructive task-base diff, approved destructive task-base diff, committed direct-write diff checked against the turn-start snapshot, and config validation.

## Eliminated

- The defect is not in the Stop hook; stop-time review cannot prevent the auto-pipeline from continuing after a destructive task result.
- A naive `git diff HEAD` gate is insufficient because task worktrees may already contain committed destructive changes; task-base and turn-start references are required.
- A new approval command was unnecessary; the existing `[QUESTION]` / `respond` mechanism already provides the right pause contract.

## Resolution

- root_cause: "Diff statistics were emitted but never used as policy input; the pipeline advanced to review/fix/check without a deterministic high-risk diff precondition."
- fix: "Added a config-aware destructive-diff classifier and approval gate before review/check/fix. In pause mode it asks the user through existing pending-request IPC, continues on approve, and returns INCOMPLETE on reject or timeout."
- verification: "`npm run build`; `npm test` -> 420 pass, 0 fail, 1 skipped. Focused destructive-diff tests passed inside the full suite."
- files_changed: "src/adapters/codex/pipeline.mjs; src/lib/session-log.mjs; src/lib/runtime-options.mjs; src/lib/config.mjs; src/lib/task-runtime.mjs; src/adapters/index.d.ts; test/destructive-diff-gate.test.mjs; skill/plugin config and notification docs; generated skill/plugin bridge bundles; .planning/debug/p0-destructive-diff-stop-gate-gsd-plan.md."
