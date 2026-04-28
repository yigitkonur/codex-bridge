---
description: Show effective Codex Bridge configuration
argument-hint: "show [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" config "$ARGUMENTS"`
