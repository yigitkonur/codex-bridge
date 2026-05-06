---
description: Wait until one or more Codex Bridge jobs reach a terminal event
argument-hint: "[--any] <job-id-or-thread-id...> | --group <name> --all [--timeout-ms <ms>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" wait "$ARGUMENTS"`

Present the full command output to the user. For `--any`, preserve the winner job id, thread id, terminal tag, and events path. Do not summarize terminal errors; preserve the exact tag and follow-up command.
