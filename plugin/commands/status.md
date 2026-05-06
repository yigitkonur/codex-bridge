---
description: Show active and recent Codex Bridge jobs for this repository
argument-hint: "[job-id] [--group <name>] [--filter completed_fail|needs_attention] [--wait] [--watch [--interval 10s]] [--cleanup [--dry-run]] [--timeout-ms <ms>] [--all] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:

- Render the command output compactly.
- Preserve summary counts and needs-attention entries; failed or incomplete jobs are actionable, even when running count is zero.
- Preserve job ID, group, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:

- Present the full command output to the user.
- Do not summarize or condense it.
