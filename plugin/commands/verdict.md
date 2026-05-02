---
description: Read or set the post-review verdict for a codex-bridge task
argument-hint: "<task_id> [--set approved|needs-attention|must-fix] [--summary <text>] [--finding <text>] [--reviewer <name>] [--payload-stdin] [--discard]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" verdict "$ARGUMENTS"`

Modes:

- **Read** (no flags): prints the stored verdict plus `merge_readiness`. Errors with `NOT_FOUND` if no verdict exists.
- **Write** (`--set <verdict>`): persists the verdict (one of `approved`, `needs-attention`, `must-fix`). Optional `--summary`, `--finding`, `--reviewer` flags add details. Idempotent — re-running with the same `--set` overwrites cleanly.
- **Stdin write** (`--payload-stdin`): reads a JSON object from stdin with `verdict`, optional `summary`, optional `findings`, optional `reviewer`, optional `review_id`, optional `review_kind`, optional raw review fields, and one branch-head field: `branch_head_sha`, `reviewed_branch_head_sha`, or `branchHeadSha`. The bridge validates the SHA and stores normalized `branch_head_sha` plus the compatibility alias `reviewed_branch_head_sha`.
- **Discard** (`--discard`): removes only `~/.codex-bridge/jobs/<task_id>/verdict.json` — the rest of the registry entry (meta.json, session-log.jsonl, etc.) is preserved for audit. Use this to clear the Stop gate's pending-verdict block when you intentionally don't want to merge a task.

Surface: write mode is read by `/codex-bridge:merge` (which refuses unless `verdict === "approved"`) and by `/codex-bridge:verdicts --pending` (which the Stop hook consumes to block session close on unresolved work).

`merge_readiness` reports `merge_ready`, `merge_blocked_by`, `branch`, `branch_head_sha`, `reviewed_branch_head_sha`, `current_branch_head_sha`, and a structured `next_action`. Approved verdicts without a matching current branch head are blocked until review is rerun and a fresh stdin payload is written.

Present the bridge's stdout verbatim. The bridge auto-fills `decided_at` and `schema_version`; don't try to set them manually.
