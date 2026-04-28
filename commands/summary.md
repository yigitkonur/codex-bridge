---
description: Summarize a Codex Bridge thread from recorded session artifacts
argument-hint: "<thread-id> [--tail <n>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" summary "$ARGUMENTS"`

Present the full command output to the user. Use this after `events` or `status` when the user needs a compact replay of the thread artifacts without reopening raw `.ndjson`.
