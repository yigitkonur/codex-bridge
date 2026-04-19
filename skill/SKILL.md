---
name: codex-bridge
description: >
  Delegate coding, refactoring, review, and multi-step implementation tasks to
  OpenAI Codex. Use this skill when the user asks Claude to "run this by Codex",
  "have Codex fix it", offload a plan→execute→review loop, spawn a background
  coding job that Claude can tail via the Monitor tool, run an adversarial code
  review, answer a [QUESTION] Codex raised mid-turn, follow up on a Codex
  [PLAN], or watch terminal events via the built-in `events --follow` / `wait`
  subcommands instead of raw `tail -f`. Also use for heavy-lift implementation
  jobs Claude would rather hand off. Every `--json` call returns a uniform
  envelope (`{ok, schema_version, command, result.phase, result.next_action,
  meta}`) with a ready-to-paste `result.monitor` hint pre-formatted for the
  Monitor tool.
compatibility: Requires Node.js 22+ and the Codex CLI on $PATH (npm i -g @openai/codex && codex login). macOS or Linux — the JSON-RPC broker uses unix sockets.
license: MIT
allowed-tools: Bash(node *) Monitor
metadata:
  version: "1.2.5"
  homepage: "https://github.com/yigitkonur/codex-bridge"
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

**Heads up:** sync `task --json` **blocks through the entire auto-pipeline** (review + completion check). With the default `auto_review: true`, a trivial prompt can stall 5–8 minutes while the reviewer times out with nothing to review. For interactive or low-latency work, either set `auto_review: false` in `config.yaml` or use the async+Monitor pattern below.

**Async (long tasks, plan approval, questions via `requestUserInput`):** launch foreground, set up Monitor in parallel on the events file. See the "Async launch + Monitor setup" section below for the full pattern — the events path is `~/.codex-bridge/sessions/<threadId>.events` (or wherever `config.session_dir` points).

Every `--json` call returns a uniform envelope:
```json
{ "ok": true,  "schema_version": "1.0", "command": "task", "result": { … }, "meta": { "duration_ms": 1234 } }
{ "ok": false, "schema_version": "1.0", "command": "task", "error": { "class": "auth", "code": "Unauthorized", "retryable": false, "suggestion": "…" } }
```

`result.next_action.command` is printed as `codex-bridge <sub> …` (shorthand). Before running it, substitute the real invocation: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs <sub> …`. There is no `codex-bridge` binary on `$PATH`.

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

A synchronous `task --json` call returns the same lifecycle outcome as a single envelope with `result.phase ∈ { plan-pending, done, incomplete }` and `result.next_action.command`. A failed turn returns an `ok:false` error envelope instead (class per the exit-code table above), not a success envelope with a `phase` field. Use sync when you don't need interim progress; use async + Monitor when you do.

**Important:** Codex has its own internal skills that may override plan mode behavior. It may skip planning and go directly to execution, or ask questions via text instead of the `requestUserInput` tool. If `[PLAN]` never arrives and `[DONE]` appears instead, Codex executed without planning — review the diff and send follow-ups as needed.

**Timeout:** The bridge has a configurable idle watchdog (default **300 s**; `idle_timeout_ms` in `config.yaml` or `--idle-timeout-ms <ms>` per-invocation on `task`/`send`). If no app-server events arrive for that long, an `[ERROR] … | ClientTimeout` is written and Monitor self-terminates. If Monitor is silent and `status <id>` shows `running` for more than ~5 minutes, the task is stuck. `cancel <id>` recovers. (`status`/`result`/`cancel`/`events` accept either a job id or the thread UUID; `send`/`steer` take thread ids. Run `status` with no argument to see the latest job id.)

**Heads up — `[ERROR]` is ambiguous:** the events-file `[ERROR]` fires for *any* turn-level failure, including an auto-pipeline sub-stage timeout, while the sync `task --json` envelope for the same run can still report `ok:true` with `result.phase: "incomplete"` and `result.pipeline.error` populated. Monitor self-terminates either way; treat `[ERROR]` as "something broke, read the pipeline field before retrying".

## Starting a Task

**Canonical pattern (recommended):** launch with `--json`, paste the ready-to-paste Monitor command straight from the envelope. The envelope is the only place the bridge guarantees you see the correct `jobId` — *not* the thread UUID that appears in `[codex] Thread ready (…)` stderr progress. Grabbing the thread UUID from stderr is a historical derailment pattern — do not do it.

```bash
LAUNCH=$(node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write --mode default --json "your prompt here")
JOB_ID=$(echo "$LAUNCH" | jq -r '.result.jobId')
EVENTS_FILE=$(echo "$LAUNCH" | jq -r '.result.eventsPath')
MONITOR_CMD=$(echo "$LAUNCH" | jq -r '.result.monitor.tool_hint.command')
# Then hand MONITOR_CMD (or the tool_hint object) to Claude Code's Monitor tool.
```

**Non-JSON shortcut (for humans at a shell):** rendered output now ends with a one-line footer that prints the jobId, events path, and Monitor command. Copy/paste the footer — do not reach into the stderr progress lines.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write --mode default "your prompt here"
# …Codex's final message…
#
# Job: task-mo5xxxxx-yyyyyy · Events: /Users/you/.codex-bridge/sessions/<threadId>.events · Monitor: node … events task-mo5xxxxx-yyyyyy --follow --filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION --timeout-ms 600000
```

The positional form takes **text**, not a path; use `--prompt-file` to load from disk.

**`--write` is not enough to enable file writing on the first turn.** With the default `mode: plan`, the task runs against a `readOnly` sandbox and `--write` has no effect until a `send <thread-id> --mode default …` approves the plan. To go straight to execution, pass `--mode default` on the `task` invocation — the flag overrides `config.mode` for that single run. Foreground only: `task --background --mode default` stores the override in the job record but the detached worker still reads `config.mode`. Config remains the session-wide default.

**Do not use the thread UUID as a job handle for `status` / `result` / `wait` / `events` / `cancel`.** Those commands accept either a jobId or a thread UUID, but the canonical handle is the jobId (`task-mo…` / `review-mo…`). Reserve the thread UUID for `send` and `steer`, which must use it.

The task starts in plan mode by default. The success envelope (or, for non-JSON, the footer) includes:
- **jobId** — the primary handle. Use this for `status`/`result`/`wait`/`events`/`cancel`.
- **threadId** — UUID v7, used by `send` and `steer` only. Avoid pattern-matching a prefix.
- **eventsPath** — full path to the `.events` file, promoted to top-level of the envelope in 1.2.5.
- **monitor** — `{command, tool_hint, shell_fallback, terminal_tags, timeout_ms}`. Paste `tool_hint` straight into Claude Code's Monitor tool.
- NDJSON log path — for retrospective analysis. Records turn params, turn completion, questions, confirmations, steers, errors, and pipeline stages; does not capture every wire-level item. See `references/ndjson-guide.md` for the full writer vocabulary.

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

Monitor command pattern (two equivalent variants — prefer the first):
```bash
# Preferred: CLI-native, handles file rotation, prefix-aware filter,
# self-terminates on any terminal tag (even if already written).
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs events "$JOB_ID" \
  --follow --filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION --timeout-ms 600000

# Fallback shell form.
tail -f "$EVENTS_FILE" | while IFS= read -r line; do echo "$line"; case "$line" in *"[DONE]"*|*"[ERROR]"*|*"[INCOMPLETE]"*) break ;; esac; done
```

Every `task --json` launch payload now returns `result.monitor` — paste `result.monitor.command` directly into a shell, or use `result.monitor.tool_hint` (keys: `description`, `command`, `timeout_ms`, `persistent`) as the argument object for the Claude Code `Monitor` tool.

Use `timeout_ms: 600000` (10 min) as a safety net. If Monitor times out with no terminal tag, the task is likely stuck — run `status <id>` to check (or bare `status` to list the session's jobs), then `cancel <id>` if needed. `status`, `result`, and `cancel` accept **either** a job id (e.g. `task-mo2n0i8z-cbefzo`) or the thread UUID — both resolve to the same job. `send` and `steer` take thread ids.

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
- Read the full result: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs result <job-id-or-thread-id>` (the `[DONE]` action line prints the job id; `result` also accepts the thread UUID directly).

### [INCOMPLETE] — Completion check found gaps

The notification lists missing items. Decide whether to fix them:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs send <thread-id> "Complete the missing items"
```

### [ERROR] — Something failed

The notification includes the error type and recovery suggestions. Each `[ERROR]` block now carries an `origin:` line — `origin: turn` for main-turn failures, `origin: pipeline:<stage>` for auto-pipeline sub-stage failures (review / fix / check). Use it to branch: pipeline-origin errors can coexist with a success envelope whose `result.phase: "incomplete"` and `result.pipeline.error` set, so read the sync envelope before retrying.

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

### Blocking on terminal tags
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs wait <job-id-or-thread-id> --timeout-ms 600000 --json
```
Blocks on `.events` via `fs.watch`; returns `{jobId, threadId, terminalTag, lastEventLine, elapsedMs, eventsPath}`. Exits 7 `WAIT_TIMEOUT` on deadline. Prefer this over `status --wait` when you only need the terminal signal (no intermediate streaming).

### Streaming events with filters
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs events <job-id-or-thread-id> --follow \
  --filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION --timeout-ms 600000
```
Dumps `.events` then follows appends. Tag filter is prefix-aware (`PIPELINE` matches `[PIPELINE:review]`, `[PIPELINE:fix]`, …). `--follow` self-terminates on any terminal tag (even if already present in the initial dump). Without `--follow`, the command dumps once and exits.

### Retrospective analysis
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs summary <thread-id>
```

### Heartbeat monitor (session-long, commit tracking)
```bash
# Persistent monitor — emits only when new commits appear.
# $BASE_REF is the branch you're measuring against; defaults to main.
# When you're *on* main, set BASE_REF=HEAD@{1} (or any merge-base target).
: "${BASE_REF:=main}"
LAST=0; while true; do C=$(git log --oneline "${BASE_REF}..HEAD" 2>/dev/null | wc -l | tr -d ' '); P=$(pgrep -f codex 2>/dev/null | wc -l | tr -d ' '); [ "$C" != "$LAST" ] && echo "[HEARTBEAT] commits=$C (+$((C-LAST))) codex=$P" && LAST=$C; sleep 60; done
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

Each task can produce up to four artifacts in `~/.codex-bridge/sessions/` (or `config.session_dir`):

- `{threadId}.events` — Monitor tails this. Tags actually emitted today: `[DONE]` `[ERROR]` `[INCOMPLETE]` `[PLAN]` `[QUESTION]` `[CONFIRMED]` `[PIPELINE:diff|review|fix|check]`.
- `{threadId}.ndjson` — Curated retrospective log: turn params, turn completion, per-item completions (`ITEM_COMPLETED` — assistant messages, tool calls, file changes, plans), questions, confirmations, steers, errors, and pipeline stages. Not every wire notification is logged.
- `{threadId}.diff` — `git diff HEAD` snapshot captured by the pipeline.
- `{threadId}.plan.md` — Written only when Codex emits a structured `item/completed` with `type: "plan"`. When Codex's internal skills route around formal planning, this file is absent.

A `{threadId}.pending.json` / `.response.json` pair may also appear transiently while a `requestUserInput` is in flight — these are consumed-on-read by the worker.

**Not currently produced:** a `{threadId}.review.json` file and the `[REVIEW]` / `[PHASE]` events are listed in `src/lib/AGENTS.md` and have writer helpers (`writeReview`, `formatReviewEvent`, `formatPhaseEvent`) but no code path calls them in the current build. Don't write tooling that depends on them.

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
