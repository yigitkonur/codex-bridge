---
created: 2026-05-03T07:28:08Z
title: Codex Bridge field report remediation
area: tooling
files:
  - src/codex-bridge.mjs
  - src/adapters/codex/
  - src/lib/
  - hooks/
  - skill/SKILL.md
  - skill/references/brief-composition.md
  - skill/references/error-recovery.md
  - skill/references/monitor-patterns.md
  - skill/references/orchestration-flows.md
  - README.md
  - test/
  - .planning/field-reports/2026-05-03-codex-bridge-claude-plugin-issues.md
---

## Problem

A real Claude Code field session using Codex Bridge `2.0.0` exposed several
experience and correctness gaps across the CLI, skill text, Monitor/event
surface, artifact layout, and worktree/resume lifecycle.

The highest-risk issues are:

- `--brief` is persisted but not delivered to the Codex worker prompt or
  worktree.
- `--resume-last --worktree-auto` can resume thread context while losing
  worktree continuity.
- Skill/help examples imply `--brief` can stand alone, but the CLI requires a
  prompt and the worker still cannot see the brief.
- Pipeline summaries can report `0 files | +0 -0` for branches with committed
  changes.
- Check failures report only `missing=N`, not the failing acceptance criteria.
- The real session bypassed bridge verdict/merge and fell back to manual
  `git merge --ff-only`.

The complete P0-P2 register is documented in:

`.planning/field-reports/2026-05-03-codex-bridge-claude-plugin-issues.md`

## Solution

Plan a new milestone focused on Claude agent experience hardening. Convert the
field report into implementation phases covering:

1. Brief delivery and schema-error recovery.
2. Resume/iterate/worktree continuity semantics.
3. Pipeline diff/check/verdict correctness.
4. Monitor progress and artifact discoverability.
5. Skill, command help, README, and reference docs alignment.
6. Cleanup and first-contact ergonomics.

Every fix should be source-first, covered by tests, and followed by
`npm run build` plus `npm test`. Generated `skill/` and `plugin/` surfaces must
be included whenever source or skill text changes.
