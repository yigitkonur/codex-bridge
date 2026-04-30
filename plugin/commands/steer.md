---
description: Send mid-turn guidance to an active Codex Bridge turn
argument-hint: "<thread-id> <turn-id> [prompt]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" steer "$ARGUMENTS"`

Present the full command output to the user. Use this only for an active turn when the bridge output provides both `threadId` and `turnId`.
