---
description: Show the stored final output for a finished Codex Bridge job
argument-hint: "[job-id] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve job IDs, statuses, result payloads, file paths, line numbers, errors, and follow-up commands exactly as reported.

When interpreting JSON, treat `result.adapterResult.terminalTag` as authoritative. `result.adapterResult.workerExitCode` is diagnostic only; if `result.adapterResult.consistent` is `false`, call out the discrepancy.
