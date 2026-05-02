---
description: Closed-loop task → review → verdict → re-dispatch until approved or N rounds (default 3)
argument-hint: "<task_id_or_prompt> [--max 3] [--brief @<path>] [--backend <name>] [--write]"
allowed-tools: Bash(node:*), Agent, Monitor, AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" iterate "$ARGUMENTS"`

The command owns the closed loop:

1. Prompt input starts a write-enabled task in a new per-task worktree.
2. Existing `<task_id>` input resumes from registry metadata for that task.
3. Each iteration reads task artifacts, runs `adversarial-review --task <task_id> --json`, writes `verdict <task_id> --payload-stdin --json`, and records `review.json` / `verdict.json`.
4. `approved` stops and returns `result.next_action.argv: ["merge", "<task_id>"]`.
5. `needs-attention` and `must-fix` start a follow-up task in the same worktree while `iteration < max`.
6. When `--max` is reached, the command returns `status: "iteration-limit"` and preserves the latest review/verdict artifact pointers.

JSON statuses:

- `approved` — review approved the current branch head; merge is the next action.
- `iteration-limit` — the loop reached `--max` before approval.
- `task-failed` — task launch or task artifact read failed.
- `review-failed` — adversarial review failed or did not produce normalized `review_result`.
- `verdict-failed` — verdict persistence failed.
- `follow-up-failed` — review required another pass, but redispatch failed.

Each `result.iterations[]` entry includes `iteration`, `task_id`, `review_result`, `verdict`, `reviewed_branch_head_sha`, artifact pointers, and `next_task_id` when a follow-up task was launched.

Present the bridge's stdout verbatim. Do not build shell commands that embed review finding text; the bridge passes review-derived verdicts through JSON stdin payloads.
