---
name: codex-bridge
description: >
  Orchestrate Codex as Claude Code's execution aide. Use when delegating 
  coding tasks, reviews, or multi-step work to Codex. Manages plan→execute→review 
  cycles with Monitor-based notifications.
compatibility: Requires Node.js 22+ and codex CLI (npm i -g @openai/codex)
allowed-tools: Bash(node *) Monitor
---

# Codex Bridge

Delegate coding tasks to Codex and manage the workflow via Monitor notifications. Codex is the executor; you are the orchestrator.

## Quick Start

Two patterns — pick by task shape.

**Sync (short, self-contained tasks):** one call, the envelope tells you what's next.
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --json "What is 2+2?" | jq '.result.phase, .result.next_action.command'
# "done"
# "codex-bridge result task-abc123"
```

**Async (long tasks, plan approval, questions via `requestUserInput`):** launch foreground, set up Monitor in parallel on the events file. See the "Async launch + Monitor setup" section below for the full pattern — the events path is `~/.codex-bridge/sessions/<threadId>.events` (or wherever `config.session_dir` points).

Every `--json` call returns a uniform envelope:
```json
{ "ok": true,  "schema_version": "1.0", "command": "task", "result": { … }, "meta": { "duration_ms": 1234 } }
{ "ok": false, "schema_version": "1.0", "command": "task", "error": { "class": "auth", "code": "Unauthorized", "retryable": false, "suggestion": "…" } }
```

Exit code is the fast gate — branch on `$?` before parsing:

| `$?` | Meaning | Action |
|---|---|---|
| 0 | success | continue |
| 2 | bad flag / missing arg | fix the command |
| 3 | resource not found | check the id |
| 4 | auth failed | `codex login` |
| 5 | conflict (already running) | check state |
| 6 | validation (bad input) | fix the input |
| 7 | transient (timeout / network / rate-limit) | retry with backoff |
| 1 | internal crash | escalate |

## How It Works

Every task follows this lifecycle:

1. **Plan phase** — Codex is instructed to plan first (effort: xhigh). May ask questions via `[QUESTION]` or produce a `[PLAN]`.
2. **Plan approval** — If `[PLAN]` arrives, review and approve or revise.
3. **Execution phase** — Codex implements in workspace-write mode.
4. **Auto-pipeline** (silent) — Review → fix → completion check runs internally. Only the final result reaches you.
5. **Final notification** — `[DONE]`, `[INCOMPLETE]`, or `[ERROR]`.

A synchronous `task --json` call returns the same lifecycle outcome as a single envelope with `result.phase ∈ { plan-pending, done, incomplete, error }` and `result.next_action.command`. Use sync when you don't need interim progress; use async + Monitor when you do.

**Important:** Codex has its own internal skills that may override plan mode behavior. It may skip planning and go directly to execution, or ask questions via text instead of the `requestUserInput` tool. If `[PLAN]` never arrives and `[DONE]` appears instead, Codex executed without planning — review the diff and send follow-ups as needed.

**Timeout:** If no terminal tag (`[DONE]`/`[ERROR]`/`[INCOMPLETE]`) appears within 10 minutes, the task may be stuck. Check status with `status <job-id>` and consider canceling with `cancel <job-id>`. (`status`/`result`/`cancel` resolve **job** ids, not thread ids; `send`/`steer` take thread ids. Run `status` with no argument to see the latest job id.)

## Starting a Task

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write "your prompt here"
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write --prompt-file prompt.md
```

The positional form takes **text**, not a path; use `--prompt-file` to load from disk.

The task starts in plan mode by default. Output includes:
- Thread ID (e.g., `thr_abc123`)
- Events file path (for Monitor)
- NDJSON log path (for retrospective analysis)

### Async launch + Monitor setup

Always launch async, then set up Monitor:

```bash
# Step 1: Launch
RESULT=$(node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write "prompt")

# Step 2: Extract paths from output
THREAD_ID=<from output>
EVENTS_FILE=<from output>

# Step 3: Verify events file exists before Monitor
test -f "$EVENTS_FILE" && echo "ready"

# Step 4: Set up Monitor (self-terminating on [DONE]/[ERROR]/[INCOMPLETE])
```

Monitor command pattern:
```bash
tail -f "$EVENTS_FILE" | while IFS= read -r line; do echo "$line"; case "$line" in *"[DONE]"*|*"[ERROR]"*|*"[INCOMPLETE]"*) break ;; esac; done
```

Use `timeout_ms: 600000` (10 min) as a safety net. If Monitor times out with no terminal tag, the task is likely stuck — run `status <thread-id>` to check, then `cancel <thread-id>` if needed.

## Responding to Events

### [PLAN] — Codex produced a plan

Read the plan, then approve or revise:
```bash
# Approve (switches to execution mode)
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs send <thread-id> --mode default "Implement the plan."

# Revise (stays in plan mode)
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs send <thread-id> "Revise step 2: use token bucket instead"
```

### [QUESTION] — Codex needs information

If Codex uses the `requestUserInput` tool, a `[QUESTION]` notification appears with options. Respond with one:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs respond <request-id> --question-id <qid> --answer "<label>"
```

**Note:** Codex may ask questions via plain text in its assistant message instead of using `requestUserInput`. In that case, no `[QUESTION]` notification appears — the turn completes with the question in the output text. Use `send` to reply:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs send <thread-id> "Use dark theme with purple accents"
```

### [DONE] — Task completed

The notification includes file change summary, diff path, and action commands. You can:
- Run a standalone review: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs review`
- Send a follow-up: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs send <thread-id> "also add tests"`
- Read the full result: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs result <thread-id>`

### [INCOMPLETE] — Completion check found gaps

The notification lists missing items. Decide whether to fix them:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs send <thread-id> "Complete the missing items"
```

### [ERROR] — Something failed

The notification includes the error type and recovery suggestions.

## Standalone Review

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs review --scope working-tree
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs review --scope branch --base main
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs adversarial-review "focus on SQL injection risks"
```

## Advanced

### Mid-turn steering
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs steer <thread-id> <turn-id> "Focus on auth first"
```

### Retrospective analysis
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs summary <thread-id>
```

### Heartbeat monitor (session-long, commit tracking)
```bash
# Persistent monitor — emits only when new commits appear
LAST=0; while true; do C=$(git log --oneline main..HEAD 2>/dev/null | wc -l | tr -d ' '); P=$(pgrep -f codex 2>/dev/null | wc -l | tr -d ' '); [ "$C" != "$LAST" ] && echo "[HEARTBEAT] commits=$C (+$((C-LAST))) codex=$P" && LAST=$C; sleep 60; done
```

## Configuration

Edit `${CLAUDE_SKILL_DIR}/config.yaml` to customize behavior. Key options:
- `mode`: "plan" (default) or "default"
- `effort`: reasoning effort for execution ("high" default, plan always uses "xhigh")
- `auto_review`: true/false — run review after task completion
- `post_task_prompt`: completion check prompt (empty to disable)
- `session_dir`: where session logs are stored

See [references/config-reference.md](references/config-reference.md) for full documentation.

## Session Files

Each task produces:
- `{threadId}.events` — Monitor tails this (actionable tags only)
- `{threadId}.ndjson` — Full structured log (for retrospective analysis with jq)
- `{threadId}.diff` — Git diff of all changes
- `{threadId}.plan.md` — Proposed plan text (if plan mode)

Read [references/ndjson-guide.md](references/ndjson-guide.md) before querying NDJSON files.

## Troubleshooting

```bash
# Full health check (node, npm, codex, auth, broker runtime)
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs setup --json

# Fast auth-only probe
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs auth-status --json

# Pin behavior against a specific build / feature set
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs version --json
```

When a command fails, **read `$?` first**. Exit 4 means re-auth; exit 7 means retry with backoff; exit 2/6 means fix the invocation before anything else.

## Reference Files

| File | When to read |
|------|-------------|
| [command-reference.md](references/command-reference.md) | Full command and flag documentation |
| [monitor-patterns.md](references/monitor-patterns.md) | Monitor presets for different scenarios |
| [notification-format.md](references/notification-format.md) | Exact format of each notification tag |
| [ndjson-guide.md](references/ndjson-guide.md) | How to parse NDJSON with jq |
| [orchestration-flows.md](references/orchestration-flows.md) | End-to-end flow diagrams |
| [error-recovery.md](references/error-recovery.md) | Error types and recovery strategies |
| [config-reference.md](references/config-reference.md) | YAML configuration options |
| [prompt-writing.md](references/prompt-writing.md) | Writing effective Codex prompts |
