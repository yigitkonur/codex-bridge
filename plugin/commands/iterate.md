---
description: Closed-loop task → review → verdict → re-dispatch until approved or N rounds (default 3)
argument-hint: "<task_id_or_prompt> [--max 3] [--brief @<path>] [--backend <name>] [--write]"
allowed-tools: Bash(node:*), Agent, Monitor, AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" iterate "$ARGUMENTS"`

The closed loop pattern is:

1. `/codex-bridge:task --worktree-auto --write` — dispatch worker into a per-task worktree
2. `/codex-bridge:review <task_id>` — run codex review on the worktree diff
3. `/codex-bridge:verdict <task_id> --set <verdict>` — persist the reviewer's call
4. If `verdict === "approved"`: `/codex-bridge:merge <task_id>` — ff-merge
5. If `verdict === "needs-attention"` and `iteration < max`: re-dispatch task with the review findings folded into the brief, repeat from step 2

In v2.0.0 the iterate orchestration is **staged** — the slash command and dispatcher entry are wired but the multi-round loop runs as a follow-up. For today, the canonical workflow is:

- Run the steps manually as documented above, OR
- Use the `codex-bridge-reviewer` subagent (`plugin/agents/codex-bridge-reviewer.md`) to collapse review+verdict into one subagent call. The reviewer agent stays out of the parent context — the only thing that comes back is the verdict line.

Present the bridge's stdout verbatim. The bridge returns a structured envelope with `result.iteration_max`, `result.iterations` (empty until orchestration lands), and `result.next_action` pointing at the manual workflow command.
