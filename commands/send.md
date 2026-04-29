---
description: Send a follow-up prompt to an existing Codex Bridge thread
argument-hint: "<thread-id> [--mode plan|default] [--effort <level>] [prompt]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" send "$ARGUMENTS"`

Present the full command output to the user. Use this for `[PLAN]` approval, plan revision, or plain-text follow-up questions from Codex. The first positional argument must be a `threadId`, not a `jobId`.
