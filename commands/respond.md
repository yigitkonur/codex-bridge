---
description: Answer a Codex Bridge requestUserInput question
argument-hint: "<request-id> (--question-id <qid> --answer <answer> | --json-payload <json>) [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" respond "$ARGUMENTS"`

Present the full command output to the user. Preserve request IDs, question IDs, and any error envelope exactly as reported.
