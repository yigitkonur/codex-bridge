---
description: Cancel an active background Codex Bridge job
argument-hint: "[job-id] [--keep-worktree] [--keep-branch] [--keep-all] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" cancel "$ARGUMENTS"`
