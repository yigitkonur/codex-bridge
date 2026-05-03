# Plan 07-02 Summary: Skill And Agent Experience Alignment

**Completed:** 2026-05-03
**Status:** Complete

## Delivered

- Updated the root skill and packaged plugin skill so agents see the true
  contract:
  - tasks are read-only unless `--write` is passed;
  - write tasks should use `--worktree-auto`;
  - `--brief` is a structured brief plus a real prompt, not a prompt
    replacement;
  - follow-up work on a task should use `iterate <task_id>` instead of
    `task --resume-last --worktree-auto`;
  - bridge merge/verdict flow is the canonical closeout path.
- Added/updated brief-composition references with valid top-level keys and
  correct examples.
- Updated error-recovery guidance for `BRIEF_SCHEMA_VIOLATION` and first-run
  worktree failures.
- Updated CLI examples and README usage so end users do not copy the broken
  field-report pattern.
- Updated the UserPromptSubmit hook guidance so intercepted prompts point to
  `iterate <task_id>` for task-state continuity.

## Source Paths

- `README.md`
- `skill/SKILL.md`
- `skill/references/brief-composition.md`
- `skill/references/command-reference.md`
- `plugin/skills/codex-bridge/SKILL.md`
- `plugin/skills/codex-bridge/references/brief-composition.md`
- `plugin/skills/codex-bridge/references/error-recovery.md`
- `hooks/user-prompt-submit.mjs`
- `plugin/hooks/user-prompt-submit.mjs`

## Verification

- `npm run build` regenerated packaged runtime/plugin surfaces.
- Static tests assert the new CLI/runtime contracts remain present.
