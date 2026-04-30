---
description: Show Codex Bridge version and update status
argument-hint: "[--check-update] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" version "$ARGUMENTS"`
