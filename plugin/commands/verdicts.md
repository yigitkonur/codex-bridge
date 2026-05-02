---
description: List unresolved task verdicts that still block the Stop gate
argument-hint: "--pending"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" verdicts $ARGUMENTS`

Lists every task with an unresolved verdict — `approved` (awaiting merge), `needs-attention` (awaiting iterate or discard), or `must-fix` (awaiting iterate or discard). Tasks that have already been merged (`verdict.merged_at` set, or `meta.phase === "merged"`) are excluded.

Surface: this is the source of truth for the Stop hook's pending-verdict block. Until each row is either merged with `/codex-bridge:merge` or explicitly cleared with `/codex-bridge:verdict <task_id> --discard`, the Stop gate refuses to close the session.

Pass `--json` to receive:

```json
{
  "count": 1,
  "pending": [{
    "task_id": "task-...",
    "verdict": "approved",
    "summary": "...",
    "decided_at": "...",
    "branch": "subagent/codex/task-...",
    "branch_head_sha": "...",
    "reviewed_branch_head_sha": "...",
    "current_branch_head_sha": "...",
    "merge_ready": true,
    "merge_blocked_by": null,
    "merge_blockers": [],
    "merge_block_reason": null,
    "next_action": { "kind": "merge", "argv": ["merge", "task-..."] }
  }]
}
```

The bare invocation is human-readable: `task_id  verdict  branch  merge-ready|blocked:<reason>  summary` per line.

Currently only `--pending` is supported. The flag is required so the CLI contract leaves room for additional modes (e.g. `--resolved`) without silently changing default behavior.
