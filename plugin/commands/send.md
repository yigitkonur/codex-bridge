---
description: Send a follow-up prompt to an existing Codex Bridge thread
argument-hint: "<thread-id> [--backend <name>] [--mode plan|default] [--on-branch <name>] [--effort <level>] [prompt]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" send "$ARGUMENTS"`

Present the full command output to the user. Use this for `[PLAN]` approval, plan revision, or plain-text follow-up questions from Codex. The first positional argument must be a `threadId`, not a `jobId`. Pass `--on-branch <name>` when the follow-up must only run from a specific checkout branch.
