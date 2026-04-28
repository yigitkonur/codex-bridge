---
description: Wait until a Codex Bridge job writes a specific artifact path
argument-hint: "<job-id> <path> [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" await-artifact "$ARGUMENTS"`

Present the full command output to the user. Use this for autonomous fan-out jobs where each Codex task has an expected file output.
