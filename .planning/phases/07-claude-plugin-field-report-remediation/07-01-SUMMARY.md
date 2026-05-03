# Plan 07-01 Summary: Runtime Contract Fixes

**Completed:** 2026-05-03
**Status:** Complete

## Delivered

- Delivered the rendered structured brief to the Codex worker prompt instead of
  only persisting it under `.codex-bridge/jobs/<task_id>/`.
- Preserved task-side and review-side brief schema validation details in
  `CliError.details`, with a concrete schema-repair suggestion for
  `BRIEF_SCHEMA_VIOLATION`.
- Rejected `task --resume-last --worktree-auto` with
  `RESUME_WORKTREE_CONFLICT`, because that flag combination resumes a thread
  without guaranteeing task worktree continuity.
- Added a first-run git preflight for automatic worktree creation so empty or
  non-committed repositories fail with a direct initial-commit suggestion.
- Made auto-pipeline final diff summaries task-base aware by diffing against
  the task worktree base ref/sha instead of the post-commit working tree.
- Emitted failing completion criteria in `[PIPELINE:check:done]` via
  `missing_items=[...]` when the completion check is incomplete.

## Source Paths

- `src/codex-bridge.mjs`
- `src/lib/git.mjs`
- `src/lib/session-log.mjs`
- `src/adapters/codex/pipeline.mjs`
- `test/bridge-static.test.mjs`
- `test/session-log.test.mjs`

## Verification

- `node --test test/bridge-static.test.mjs test/session-log.test.mjs test/brief.test.mjs`
- Covered brief prompt delivery, resume/worktree rejection, schema-error detail
  preservation, branch-aware diff capture, and missing-item event visibility.
