---
description: Check for a newer Codex Bridge release
argument-hint: "[--force] [--apply|--yes] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" update "$ARGUMENTS"`
