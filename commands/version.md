---
description: Show Codex Bridge version and update status
argument-hint: "[--backend <name>] [--check-update] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" version "$ARGUMENTS"`
