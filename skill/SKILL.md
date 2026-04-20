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
allowed-tools: Bash Monitor
metadata:
  version: "1.5.0"
  homepage: "https://github.com/yigitkonur/codex-bridge"
---

# Codex Bridge

Delegate coding tasks to Codex and manage the workflow via Monitor notifications. Codex is the executor; you are the orchestrator.

**Path note:** every example uses `${CLAUDE_SKILL_DIR}`. If that environment variable isn't set in your harness, substitute the install path directly (`~/.claude/skills/codex-bridge` for the default user-scope install, or wherever your skill installer placed this skill). Never rely on a bare `codex-bridge` binary — it doesn't exist; you always invoke `node <scriptPath>`.

## Identifiers (the single biggest source of derailment — read this first)

Two kinds of IDs flow through every task. Use the right one or commands fail:

- **`jobId`** (shape: `task-mo…` / `review-mo…`) — the canonical handle. Use for `status`, `result`, `wait`, `events`, `cancel`, `status --prune-orphans`. Deterministic, 1:1 with your launch.
- **`threadId`** (shape: UUID v7 `019d…`) — required by `send` and `steer`. Also accepted by the jobId-side commands above (so you don't strictly need to remember which is which), but using `jobId` there is cheaper and avoids an extra resolver step.

**Derailment pattern to avoid:** the stderr progress stream prints `[codex] Thread ready (019d…)` — do **not** pattern-match that UUID and use it as your `jobId`. It's a threadId. The correct handles come from the `--json` envelope (`result.jobId`, `result.threadId`, `result.eventsPath`, `result.monitor.tool_hint`) or from the one-line footer printed at the end of non-JSON rendered output (`Job: … · Events: … · Monitor: …`).

## Quick Start

Two patterns — pick by task shape.

**Sync (short, self-contained tasks):** one call, the envelope tells you what's next.
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --json --mode default "Rename getUserProfile to fetchUserProfile across the repo" \
  | jq '.result.phase, .result.jobId'
```

Sync `task --json` **blocks through the entire auto-pipeline** (review + completion check). With the default `auto_review: true`, a prompt with no code work still waits through the reviewer's stage timeout before returning. For interactive or low-latency work: pass `--no-pipeline`, set `auto_review: false` in `config.yaml`, or use the async pattern below.

**Async (long tasks, plan approval, questions via `requestUserInput`):** launch in the background and tail the events file with Monitor. Every `task --json` (background or foreground) returns `result.monitor.tool_hint` — pass it directly to Claude Code's Monitor tool. Full pattern in "Starting a Task" below.

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

1. **Plan phase** — Codex is instructed to plan first (effort: xhigh). May ask questions via `[QUESTION]` or produce a `[PLAN]`. Skip with `--mode default`.
2. **Plan approval** — If `[PLAN]` arrives, review and approve or revise.
3. **Execution phase** — Codex implements under the configured sandbox policy (see "Defaults that change Codex's behavior" below).
4. **Auto-pipeline** — emits observable signals: `[PIPELINE:diff]`→`[PIPELINE:diff:done]`, then optionally `[PIPELINE:review]`→`[PIPELINE:review:done]`, `[PIPELINE:fix]`→`[PIPELINE:fix:done] files=[a,b,c]`, `[PIPELINE:check]`→`[PIPELINE:check:done]`, and finally a terminal `[PIPELINE:done]` or `[PIPELINE:failed]`. Skip entirely with `--no-pipeline`.
5. **Final notification** — `[DONE]`, `[INCOMPLETE]`, or `[ERROR]`.

A synchronous `task --json` call returns the same lifecycle outcome as a single envelope with `result.phase ∈ { plan-pending, done, incomplete, workspace-dirty }` and `result.next_action.command`. `result.pipeline.touchedFiles` lists files the pipeline's fix stage wrote (empty if no pipeline fixes were applied). A failed Codex turn returns an `ok:false` error envelope instead (class per the exit-code table above), not a success envelope with a `phase: "error"` value. Use sync when you don't need interim progress; use async + Monitor when you do.

**Important:** Codex has its own internal skills that may override plan-mode behavior. It may skip planning and go directly to execution, or ask questions via text instead of the `requestUserInput` tool. If `[PLAN]` never arrives and `[DONE]` appears instead, Codex executed without planning — review the diff and send follow-ups as needed.

### Defaults that change Codex's behavior

Two shipped defaults affect what Codex does — know them before reading Codex output:

- **`sandbox_policy: "danger-full-access"`** — Codex runs **without a sandbox** by default. It can write anywhere in the filesystem, including `.git/` (so Codex can commit its own work). Opt into stricter profiles via `config.yaml` (`workspace-write` restricts to cwd; `read-only` forbids writes). Pre-1.2.0 default was `workspace-write`, which routinely triggered Codex to interpret sandbox denials as puzzles (e.g. osascript probes to reach a human terminal).
- **`skip_meta_skills: true`** — an `[ORCHESTRATOR DIRECTIVE]` is auto-prepended to every prompt telling Codex to skip any internal planning / ceremony / meta-skill chain it would normally walk before execution. Framework-agnostic: covers any skill chain that produces spec or plan scaffolding under paths like `docs/`, `plans/`, `specs/`, or similar before touching the deliverable. Without this, Codex can spend many minutes on that ceremony when the bridge is already orchestrating. Set `skip_meta_skills: false` if you're running without an orchestrator and specifically want that chain to run.

### Timeout budgets (every layer is configurable)

Six independent timeout budgets, each resolved `CLI flag → config.yaml key → built-in default`. Malformed flag values throw usage (exit 2) rather than silent fallback.

| Phase | Default | Config key | CLI flag |
|---|---|---|---|
| Plan turn | 15 min | `turn_plan_ms` | `--turn-plan-ms` |
| Execute turn (also send turns in default mode) | 30 min | `turn_default_ms` | `--turn-default-ms` (task) / `--turn-timeout-ms` (send) |
| Per-stage pipeline (review/fix/check) | 5 min | `pipeline_stage_ms` | `--pipeline-stage-timeout-ms` |
| Pipeline total | 15 min | `pipeline_total_ms` | `--pipeline-total-timeout-ms` |
| Question unanswered (auto-answers `{answers:{}}`) | 5 min | `question_answer_ms` | `--question-timeout-ms` |
| No-event idle (per turn) | 5 min | `idle_timeout_ms` | `--idle-timeout-ms` |

Idle fires a `[ERROR] … | ClientTimeout` with `origin: idle` (v1.4.1+; pre-1.4.1 this collapsed to `origin: turn`); pipeline-stage timeouts fire with `origin: pipeline:<lastCompleted>` and a separate `failing_stage: <actualStage>` field. If Monitor goes silent and `status <id>` still reports `running` past the relevant timeout plus ~60 s buffer, the task is genuinely stuck — `cancel <id>` recovers.

### Observability guarantee (v1.3.0)

The `.events` file is **never silent for more than ~60 s** during a running turn, and an orchestrator always sees a rich summary at least every 5 min.

- **`[HEARTBEAT]` every ~60 s** (override: `CODEX_BRIDGE_HEARTBEAT_MS`). Non-terminal liveness pulse carrying elapsed time, phase, pid, last-item, budget remaining, and a re-attach tail command. Silence past ~90 s means the bridge wrapper is dead — investigate the pid, don't keep waiting.
- **`[CHECKPOINT]` every ~5 min** (override: `CODEX_BRIDGE_CHECKPOINT_MS`). Non-terminal rich summary: the last assistant message in full, every tool call in the interval with compact parameter previews (Read/Write/Edit paths, commands), git commits landed in that window, a `--shortstat` diff since the previous checkpoint, and a cumulative since-start diff. Designed so an orchestrator dropping in on a long-running task can catch up from one block instead of scrolling the entire ndjson.
- **Stall detection.** Three consecutive barren checkpoints (default: 15 min with zero commandExecution / fileChange / plan items — Codex alive but not progressing) fires a terminal `[ERROR] | StallDetected`. Monitor self-terminates; the orchestrator cancels or steers. Override the threshold with `CODEX_BRIDGE_STALL_CHECKPOINTS` (integer ≥ 2).
- **Finally-backstop.** A top-level `finally` block in `runBridgeTask` verifies a terminal tag landed before the turn returns or throws. If not, it synthesizes `[ERROR] | UnhandledExit`. That marker is itself a bug report — a turn exited past every instrumented branch; file an issue with the jobId and the events file.

**Raw-tail escape hatch.** The `Events dir:` / `Events file:` lines printed in the footer (and `result.eventsDir` / `result.eventsPath` in `--json`) are canonical paths you can `tail -f` directly, bypassing every bridge subcommand. Useful when the bridge CLI itself is behaving oddly — the file keeps being written as long as the wrapper process is alive.

### Interrupts vs progress signals (v1.4.0)

Tags in the stream fall into two semantic buckets. Orchestrators should handle them differently:

**Interrupts — act now.** Appear immediately, demand a response:

- `[QUESTION]` — Codex is blocked waiting for an answer; respond via `respond <request-id> --answer …`.
- `[PLAN]` — plan-mode turn produced a plan; approve via `send <thread-id> --mode default "Implement the plan."` or revise.
- `[DONE]` / `[ERROR]` / `[INCOMPLETE]` — terminal, Monitor self-closes. Branch on the origin line and `result.phase`.

**Progress — periodic scan.** Informational; safe to process in batches:

- `[CHECKPOINT]` — primary LLM-facing digest (every ~5 min): last assistant message, tool calls with parameter previews, git commits, diff since last checkpoint. Read these for "what is Codex doing."
- `[HEARTBEAT]` — 60-s liveness pulse. **Excluded from Monitor by default** (would flood LLM context); still written to the `.events` file for raw-tail users and the 90-s liveness heuristic.
- `[PIPELINE:*]` / `[PIPELINE:*:done]` — auto-pipeline stage markers. Matter for "did the pipeline finish touching files" before you commit or verify.
- `[WARNING]` — circuit-breaker hit (e.g. headless-env osascript loop); cancel/steer if needed.
- `[CONFIRMED]` — a `[QUESTION]` got an answer; no action, just lifecycle trace.

**Unknown tags pass through.** v1.4.0's default is `--exclude HEARTBEAT`, so any tag a future bridge version emits reaches the orchestrator verbatim. Your code should tolerate tags beyond this list — if you see `[FUTURE_TAG_V1_5] …`, show it and move on; don't assume the vocabulary is closed.

**Heads up — `[ERROR]` is ambiguous:** the events-file `[ERROR]` fires for *any* turn-level failure, including an auto-pipeline sub-stage timeout, while the sync `task --json` envelope for the same run can still report `ok:true` with `result.phase: "incomplete"` and `result.pipeline.error` populated. Monitor self-terminates either way; treat `[ERROR]` as "something broke — read `origin:` on the error line and `result.pipeline.error` in the envelope before retrying." Full triage in [references/error-recovery.md](references/error-recovery.md).

## Starting a Task

**Canonical pattern.** Launch with `--json`, read the envelope, hand `result.monitor.tool_hint` to Claude Code's Monitor tool. The envelope is the only place the bridge guarantees you see the correct `jobId` — *not* the thread UUID that appears in `[codex] Thread ready (…)` stderr progress.

```bash
LAUNCH=$(node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write --mode default --background --json "your prompt here")
JOB_ID=$(echo "$LAUNCH" | jq -r '.result.jobId')
EVENTS_FILE=$(echo "$LAUNCH" | jq -r '.result.eventsPath')
TOOL_HINT=$(echo "$LAUNCH" | jq -c '.result.monitor.tool_hint')
# Then pass $TOOL_HINT straight to the Monitor tool, or run the equivalent command.
```

`--background` detaches the worker and returns the envelope immediately; drop it to keep the worker foreground. For foreground, the envelope is emitted after the turn completes (and after the auto-pipeline if configured).

The positional form takes **text**, not a path; use `--prompt-file` to load from disk.

**`--write` alone doesn't enable file writing on the first turn.** With the default `mode: plan`, the task runs against a `readOnly` sandbox and `--write` has no effect until a `send <thread-id> --mode default …` approves the plan. Pass `--mode default` on `task` to go straight to execution. `--mode` on `task --background` is also applied — the override flows through the job record into the detached worker.

**Fallback when `jq` isn't available.** Rendered (non-JSON) output ends with a one-line footer printed verbatim after Codex's final message:

```
Job: task-mo5xxxxx-yyyyyy · Events: /Users/you/.codex-bridge/sessions/<threadId>.events · Monitor: node … events task-mo5xxxxx-yyyyyy --follow --exclude HEARTBEAT --timeout-ms 1800000
```

That footer is your source of truth — do **not** pattern-match the `Thread ready (019d…)` line from stderr progress. The footer's `Job:` field is the `jobId`.

### Task-launch flags (added in 1.2.5)

| Flag | Effect | When to use |
|---|---|---|
| `--no-pipeline` | Skips the auto-review/fix/check stages for this one run | You want a single turn and own the verification yourself |
| `--quiet` | Suppresses the `[codex] …` stderr progress stream | You want a clean console and rely on `events --follow` or Monitor |
| `--turn-default-ms <ms>` | Override per-turn timeout for execute turns | Large scaffolds that legitimately need >10 min |
| `--turn-plan-ms <ms>` | Override per-turn timeout for plan turns | Long-form planning across many specs |
| `--pipeline-stage-timeout-ms <ms>` | Override per-stage pipeline budget | Large diffs; native reviewer needs longer |
| `--pipeline-total-timeout-ms <ms>` | Override total pipeline budget | Very large runs |
| `--question-timeout-ms <ms>` | How long `requestUserInput` waits before auto-answering `{}` | Slow loops / humans deliberating |
| `--idle-timeout-ms <ms>` | Override the no-event idle watchdog | Reasoning-heavy tasks that go quiet between app-server events |

All values are milliseconds; malformed (non-positive / non-numeric) inputs throw `usage` (exit 2). Example of a scaffold that needs extra execute time:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write --mode default --background \
  --turn-default-ms 1800000 --pipeline-stage-timeout-ms 600000 --json \
  "Bootstrap a complete Xcode project from the plan in ./docs/phase-1.md"
```

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

### [PIPELINE:\*:done] — a pipeline stage finished

Each stage emits a start tag (`[PIPELINE:review]`) and a done tag (`[PIPELINE:review:done] verdict=approve findings=0`). The `[PIPELINE:fix:done]` line includes `files=[a.ts,b.ts]` listing exactly what the fix stage wrote — distinct from the diff Codex produced in its execute turn. A terminal `[PIPELINE:done]` (or `[PIPELINE:failed]`) closes out the whole pipeline. After `[PIPELINE:done]` no more bridge-side writes are coming to the workspace.

### [DONE] — Task completed — **read this checklist before acting**

`[DONE]` means the turn and the pipeline both reached a terminal state. Before you edit, commit, or move on:

1. **Confirm pipeline truly stopped.** If the run had a pipeline, you should see `[PIPELINE:done]` (or `[PIPELINE:failed]`). Its presence means no further bridge-side writes are pending. If you see `[DONE]` without a `[PIPELINE:*:done]` for a run that had auto_review on, something is off.
2. **Read `result.pipeline.touchedFiles`** (in the `task --json` envelope) before accepting pipeline-applied changes. Empty list means the entire diff is Codex's own execute-turn work. Non-empty means the auto-fix stage wrote those specific files — inspect each before blind-accepting.
3. **Do not edit files Codex just wrote.** If you ask Codex to scaffold something and immediately modify one of its outputs, you'll fight Codex's internal repo model on the next `send`. Commit first, then edit in a separate conversation if needed.
4. **Don't use a generator as verification of its own output.** If your new files depend on `xcodegen` / `prisma generate` / `protoc` / similar, don't re-run the generator and compare diffs — the second run's output is non-deterministic for anything order-dependent. Compile with `xcodebuild` / `cargo build` / `tsc` against the committed tree instead.
5. **Verify on the committed tree, not the working copy.** Commit your intended changes, then rebuild from a clean tree. Working-copy builds can hide late pipeline writes.

Common follow-ups:
- Standalone review: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs review`
- Send a follow-up: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs send <thread-id> "also add tests"`
- Read the full result: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs result <job-id>`

### [INCOMPLETE] — Completion check found gaps

The notification lists missing items. Decide whether to fix them:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs send <thread-id> "Complete the missing items"
```

### workspace-dirty — Codex produced a diff but couldn't commit it

The sync envelope may return `ok:true, result.phase: "workspace-dirty"` when Codex's execute turn produced a non-empty diff but failed to commit (typically `SandboxError` — `workspace-write` denies `.git/` writes). The diff is intact and actionable; you commit on Codex's behalf, or re-run with `config.sandbox_policy: "danger-full-access"` (already the shipped default). `result.sandboxError` has the raw error message.

### [WARNING] — Circuit breaker tripped

Emitted when `command_failure_circuit_breaker: true` (default) detects 3 of 5 same-family command failures (osascript / applescript / open-app / computer-use) — typically Codex flailing in a headless environment. The event carries `family`, `threshold`, `sample`, and `turnInterrupted: no` (today, logging-only). Monitor does **not** self-terminate on `[WARNING]` — the stream keeps flowing. On seeing one, decide:

- Cancel: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs cancel <job-id>` if the environment genuinely can't run the family
- Steer: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs steer <thread-id> <turn-id> "This environment is headless — move on"` to redirect

### [ERROR] — Something failed

Each `[ERROR]` block carries an `origin:` line. The canonical vocabulary actually emitted today:

| `origin:` | Cause | First action |
|---|---|---|
| `idle` | No events from Codex for the idle window (upstream silent mid-turn). | `relaunch` with a larger `--idle-timeout-ms`. |
| `upstream:compact-proxy` | Remote compact proxy returned 502 ("Proxy request budget exhausted"). | Narrow required-reads, shorten follow-ups. |
| `upstream:transport` | Upstream WS/stream disconnected before `turn/completed`. Workspace unchanged. | `send` the same prompt; reasoning is lost but safe to retry. (Bridge auto-retries up to 3× with backoff in v1.5.0+.) |
| `upstream:response-chain-lost` (v1.5.0) | Upstream 400 `previous_response_not_found` — the resp_id is dead. | **New task**, not `send`; seed with committed state. See [error-recovery.md#response-chain-lost](references/error-recovery.md#response-chain-lost). Paired with `[HANDOFF]`. |
| `upstream:auth` (v1.5.0) | Upstream 401 Unauthorized (direct Codex or proxy). | Reauth the right layer (`codex login` or proxy reauth); do not retry. Paired with `[HANDOFF]`. |
| `upstream:invalid-request` (v1.5.0) | Upstream 400 `invalid_request_error` not covered by `response-chain-lost`. | Bridge auto-retries 3× with backoff. On exhaustion: rebuild prompt, relaunch fresh task. |
| `turn` | Every other turn-level failure. Distinguish by `errorCode`: `ContextWindowExceeded`, `Unauthorized`, `SandboxError`, generic turn-budget, etc. | See [error-recovery.md](references/error-recovery.md). |
| `pipeline:<lastCompleted>` | Auto-pipeline sub-stage failure. Check `failing_stage:` for the stage that actually stalled; the main task may still have succeeded. | `inspect` with `result`, then `rerun-review`. |
| `bridge:stall` / `bridge:unhandled-exit` | Bridge safety net fired — indicates a bridge bug. | File a report with the jobId + events file. |

A pipeline-origin `[ERROR]` can coexist with a `task --json` success envelope whose `result.phase: "incomplete"` and `result.pipeline.error` are set — read the envelope before retrying. The `actions:` block inside each `[ERROR]` is cause-aware and always ends with a `see:` line pointing to the right anchor in [references/error-recovery.md](references/error-recovery.md).

### Upstream retry + handoff (v1.5.0)

For `upstream:*` origins the bridge runs an exp-backoff retry loop before surfacing the error (policy keyed by origin; see `UPSTREAM_RETRY_POLICY` in the source). Each retry attempt emits a non-terminal `[RETRYING] attempt n/max | origin=… | backoff=…ms` block so a reader watching `events --follow` can tell a slow turn apart from a stalled one.

On retry exhaustion (or immediately for `upstream:auth`, which has no retry policy), the bridge emits a `[HANDOFF]` block **before** the terminal `[ERROR]`. The handoff surfaces the full continuation context — artifact paths, committed shas, retry history, upstream request id — so another agent (or a human) can pick up where the failed turn left off without hand-reconstructing state from `git log`. The same payload ships on the JSON envelope under `error.handoff`. See [references/orchestration-flows.md#recovering-from-upstream-state-loss](references/orchestration-flows.md#recovering-from-upstream-state-loss) for the consumer recipe.

When commits landed before the error, a `[PARTIAL] commits=[…]` block precedes `[HANDOFF]` (and mirrors to `error.partial`). The bridge snapshots git at turn start and diffs on failure; a non-empty `partial.commits` list is the cheapest way to answer "did my turn actually do anything before it died?"

## When NOT to use Monitor

Monitor is bound specifically to codex-bridge `.events` files and their tag vocabulary (`[DONE]`, `[ERROR]`, `[INCOMPLETE]`, `[PLAN]`, `[QUESTION]`, `[PIPELINE:*]`, `[WARNING]`, `[HEARTBEAT]`, `[CHECKPOINT]`). Re-arming Monitor on a foreign process whose stdout doesn't emit those tags will only ever time out — the filter never matches, Monitor waits the full `timeout_ms`, then reports `stream ended`. This wastes orchestrator turns and teaches the agent nothing.

**Monitor is single-job.** One Monitor call tails one `.events` file and self-terminates on one terminal tag. For N > 1 parallel Codex jobs, do **not** stack N Monitor calls — use `status --watch` for a live table view of all tracked jobs, or `await-artifact` to block on the specific file each job will produce. See "Running N jobs in parallel" below and `references/orchestration-flows.md` for the full fan-out / fan-in pattern.

| Situation | Use this |
|---|---|
| Codex task running in the background; you need the terminal tag | Monitor (canonical) |
| `xcodebuild` / `npm test` / `cargo build` / `pytest` / any foreign long command | `Bash` with `run_in_background: true`, then poll with `BashOutput` or wait for the task handle |
| Polling a file for content (not a tag) | Plain shell loop (`until [ -s path ]; do sleep 1; done`) |
| Watching pipeline's diff-level changes | `events --follow --filter PIPELINE` (symmetric `:done` tags as of 1.2.5) |

Rule: if the thing you're watching doesn't write to `~/.codex-bridge/sessions/<threadId>.events` with one of the listed tags, Monitor is the wrong tool.

## Running N jobs in parallel

When the orchestrator is fanning out more than one Codex job at a time, Monitor is the wrong primitive (it self-terminates on the first terminal tag of one stream). The right pattern is **async-first: launch N background tasks, then block on either `status --watch` for a live table or `await-artifact` for a specific file per job**.

```bash
# 1. Launch N jobs in background; collect their jobIds.
for prompt in prompts/*.md; do
  node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write --mode default --background --json \
    --prompt-file "$prompt" \
    | jq -r '.result.jobId' >> .jobs.txt
done

# 2a. OPTION A — watch all jobs in one live table (exits when every tracked job is terminal).
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs status --watch --interval 10s

# 2b. OPTION B — block on the specific artifact each job produces.
while read -r job; do
  node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs await-artifact "$job" "out/${job}.md" --timeout-ms 900000 --json
done < .jobs.txt
```

Rules:
- One `result` call per job to read the structured outcome (`jq '.result.phase'`).
- Don't try to stack N Monitor calls — stream ownership belongs to a single tail per `.events` file, and the LLM context can't reason about N parallel streams cleanly.
- `status --watch` is the fan-in view; `await-artifact` is the success-gate per job.
- Worked walkthrough with interleaved outputs in [references/orchestration-flows.md](references/orchestration-flows.md#running-n-jobs-in-parallel).

## Standalone Review

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs review --scope working-tree
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs review --scope branch --base main
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs adversarial-review "focus on SQL injection risks"
```

## Advanced (pointers)

Day-to-day work rarely needs these; the references have full details.

- **Mid-turn steering:** `steer <thread-id> <turn-id> "…"` — see [references/command-reference.md](references/command-reference.md#steer). Find `<turn-id>` in the `[PLAN]` line or the `TURN_PARAMS` / `TURN_COMPLETED` NDJSON records.
- **Block on terminal tags without streaming:** `wait <job-id> --timeout-ms 600000 --json` returns `{jobId, threadId, terminalTag, lastEventLine, elapsedMs, eventsPath}`. Exit 7 `WAIT_TIMEOUT` on deadline.
- **Stream events with filters:** default shape is `events <job-id> --follow --exclude HEARTBEAT --timeout-ms 1800000`. Exclusion-based filter (v1.4.0) means any new tag future bridge versions emit passes through automatically — an inclusion-based `--filter X,Y,Z` silently drops unknown tags and is *not* forward-compatible. `--filter` and `--exclude` are mutually exclusive. Filter is prefix-aware on the head tag (`PIPELINE` matches `[PIPELINE:review]`, `[PIPELINE:fix:done]`, …). Continuation lines of multi-line blocks inherit the header's decision, so an included `[CHECKPOINT]` block ships whole (not just its header). With `--json`, the closing envelope carries `{terminalTag, terminalLine, elapsedMs, filter, exclude}` so Monitor can distinguish happy-path close from timeout.
- **Retrospective analysis:** `summary <thread-id>` produces a markdown transcript from the NDJSON log.
- **Heartbeat monitor** (session-long commit tracking): see `references/monitor-patterns.md` Preset C.

## Configuration

Edit `${CLAUDE_SKILL_DIR}/config.yaml` to customize behavior. The keys you're most likely to touch:

| Key | Default | Why you'd change it |
|---|---|---|
| `mode` | `"plan"` | Set to `"default"` to always skip the plan turn |
| `auto_review` | `true` | Set to `false` to skip the auto-review/fix/check pipeline |
| `sandbox_policy` | `"danger-full-access"` | Tighten to `"workspace-write"` or `"read-only"` for stricter runs |
| `skip_meta_skills` | `true` | Set to `false` to let Codex run its own planning / ceremony / meta-skill chain before execution (framework-agnostic — any scaffold-producing chain) |
| `command_failure_circuit_breaker` | `true` | Controls whether `[WARNING]` fires on osascript / open-app / computer-use flailing |

**Six timeout keys** (`idle_timeout_ms`, `turn_plan_ms`, `turn_default_ms`, `pipeline_stage_ms`, `pipeline_total_ms`, `question_answer_ms`) — see the matrix in the "Timeout budgets" section above, or [references/error-recovery.md](references/error-recovery.md#timeout-values) for the full flag-to-config mapping.

Run `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs config show` to print the effective merged config plus which of the four source files are being read. Use it to debug "why isn't my config taking effect?".

Full documentation: [references/config-reference.md](references/config-reference.md).

## Session Files

Each task writes artifacts to `~/.codex-bridge/sessions/` (or `config.session_dir`):

- `{threadId}.events` — Monitor tails this. Tags emitted: `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, `[PLAN]`, `[QUESTION]`, `[CONFIRMED]`, `[WARNING]`, `[HEARTBEAT]` (every ~60 s during any running turn — non-terminal liveness pulse), `[CHECKPOINT]` (every ~5 min — non-terminal rich summary: last assistant message, tool calls, git delta, commits since last checkpoint), `[PIPELINE:diff|review|fix|check]` with matching `:done` pair, and terminal `[PIPELINE:done]` or `[PIPELINE:failed]`. A `[ERROR] | UnhandledExit` block indicates the bridge's finally-backstop fired — the turn exited without any other error branch emitting a terminal tag. A `[ERROR] | StallDetected` block indicates 3 consecutive checkpoints (15 min by default) had zero actionable items — Codex is alive but not progressing; orchestrator should cancel or steer.
- `{threadId}.ndjson` — Curated retrospective log (turn params, item completions, questions, errors, pipeline stages). Not a full wire mirror. See [references/ndjson-guide.md](references/ndjson-guide.md).
- `{threadId}.diff` — `git diff HEAD` snapshot captured by the pipeline.
- `{threadId}.plan.md` — Written when Codex emits a structured `item/completed` with `type: "plan"`.

A `{threadId}.pending.json` / `.response.json` pair appears transiently while a `requestUserInput` is in flight (consumed-on-read). `{threadId}.review.json`, `[REVIEW]`, `[PHASE]` have writer helpers but no active call sites — don't build tooling that depends on them.

## Troubleshooting

```bash
# Full health check (node, npm, codex, auth, broker runtime)
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs setup --json

# Fast auth-only probe
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs auth-status --json

# Pin behavior against a specific build / feature set
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs version --json

# "Why isn't my config taking effect?" — prints the merged config
# and which of the four source files were read.
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs config show

# Status shows a pile of "running" jobs that aren't actually alive?
# Reap orphaned state-file ghosts (status:"running"|"queued" with dead PIDs).
# Idempotent; safe to run repeatedly.
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs status --prune-orphans --json

# CLI exited with status 1 and no obvious error? Check the crash log.
ls -lt ~/.codex-bridge/crashes/ | head -5
# Each file is a JSON dump of the unhandled rejection / exception that
# produced the exit, including argv, cwd, nodeVersion, and the error stack.

# Auto-update: every `bridge task` / `send` / `result` / etc. invocation
# checks for a new release (anonymous, 1 h cache) and — if one exists —
# spawns `npx skills@latest add …` in the background with stdio routed to
# ~/.codex-bridge/auto-update.log. Rate-limited to one attempt per hour.
# The current call is not blocked; the NEW files land before your NEXT
# invocation. Opt out with CODEX_BRIDGE_NO_UPDATE_CHECK=1.

# Check auto-update history / last-attempt outcome
tail -20 ~/.codex-bridge/auto-update.log

# Force a fresh check (bypass the 1 h cache) and print current status
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs update --force

# Force immediate install synchronously (waits for npx to finish)
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs update --apply
```

When a command fails, **read `$?` first**. Exit 4 means re-auth; exit 7 means retry with backoff (check `error.code` — `ClientTimeout` branches by `origin:` per [references/error-recovery.md](references/error-recovery.md#clienttimeout)); exit 2/6 means fix the invocation before anything else.

### Claude Code on macOS — Xcode `build.db` I/O errors

When running `xcodebuild` from inside a Claude Code session on macOS, the sandbox around DerivedData intermittently returns `disk I/O error` on the build database. Fix by putting DerivedData **outside** the workspace: `xcodebuild -derivedDataPath /tmp/<project>-dd …`. Don't use the default workspace-side `DerivedData/` from inside Claude Code.

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
