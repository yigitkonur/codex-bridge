---
description: Wait until Codex Bridge jobs match terminal or interrupt events
argument-hint: "[--all|--any] [--jobs <ids>] <job-id-or-thread-id...> [--predicate terminal|interrupt|error|both] [--timeout-ms <ms>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" wait "$ARGUMENTS"`

Present the full command output to the user. For `--any`, preserve the winner job id, thread id, state, terminal or interrupt tag, and events path. For `--all`, preserve the summary counts and every job row. Do not summarize terminal errors; preserve the exact tag and follow-up command.
