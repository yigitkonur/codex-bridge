---
description: Show Codex CLI authentication status for Codex Bridge
argument-hint: "[--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" auth-status "$ARGUMENTS"`
