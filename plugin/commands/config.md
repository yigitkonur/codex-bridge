---
description: Show effective Codex Bridge configuration and diagnostics
argument-hint: "show [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" config "$ARGUMENTS"`
