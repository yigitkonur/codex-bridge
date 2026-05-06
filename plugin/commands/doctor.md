---
description: Diagnose stale Codex Bridge jobs and orphaned worktree artifacts
argument-hint: "[--clean [--yes] [--force]] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" doctor "$ARGUMENTS"`

Present the full command output to the user. If cleanup skipped dirty worktrees,
call out that `doctor --clean --force` is required before those paths are
removed.
