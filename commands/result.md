---
description: Show the stored final output for a finished Codex Bridge job
argument-hint: "[job-id] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve job IDs, statuses, result payloads, file paths, line numbers, errors, and follow-up commands exactly as reported.
