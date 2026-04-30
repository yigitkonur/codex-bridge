---
description: Wait until a Codex Bridge job or thread reaches a terminal event
argument-hint: "<job-id-or-thread-id> [--timeout-ms <ms>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" wait "$ARGUMENTS"`

Present the full command output to the user. Do not summarize terminal errors; preserve the exact tag and follow-up command.
