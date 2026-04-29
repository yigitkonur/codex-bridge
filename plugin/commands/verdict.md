---
description: Read or set the post-review verdict for a codex-bridge task
argument-hint: "<task_id> [--set approved|needs-attention|must-fix] [--summary <text>] [--finding <text>] [--reviewer <name>] [--discard]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" verdict "$ARGUMENTS"`

Three modes:

- **Read** (no flags): prints `~/.codex-bridge/jobs/<task_id>/verdict.json`. Errors with `NOT_FOUND` if no verdict exists.
- **Write** (`--set <verdict>`): persists the verdict (one of `approved`, `needs-attention`, `must-fix`). Optional `--summary`, `--finding`, `--reviewer` flags add details. Idempotent — re-running with the same `--set` overwrites cleanly.
- **Discard** (`--discard`): removes the entire `~/.codex-bridge/jobs/<task_id>/` directory. Required to clear the Stop gate's pending-verdict block when you intentionally don't want to merge a task.

Surface: write mode is read by `/codex-bridge:merge` (which refuses unless `verdict === "approved"`) and by `/codex-bridge:verdicts --pending` (which the Stop hook consumes to block session close on unresolved work).

Present the bridge's stdout verbatim. The bridge auto-fills `decided_at` and `schema_version`; don't try to set them manually.
