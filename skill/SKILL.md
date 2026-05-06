---
name: codex-bridge
description: >
  Delegate substantial implementation, refactor, debug, and review work to
  OpenAI Codex through a hook-driven runtime. Use when the user says "have
  Codex…", "run this by Codex", asks for an adversarial review, or wants a
  plan→execute→review→merge loop. The bridge returns Monitor-ready event
  envelopes and keeps Codex execution separate from the orchestrator context.
compatibility: Requires Node.js 22+ and the Codex CLI on $PATH (npm i -g @openai/codex && codex login). macOS or Linux — the JSON-RPC broker uses unix sockets.
license: MIT
allowed-tools: Bash Monitor
metadata:
  version: "2.3.5"
  homepage: "https://github.com/yigitkonur/codex-bridge"
---

# Codex Bridge

Codex is the executor; you are the orchestrator. Your job is judgment: when to delegate, what risks to name, when to review, when to iterate.

**Path note:** examples use `${CLAUDE_SKILL_DIR}`. If it is unset, substitute the install path directly. There is no bare `codex-bridge` binary.

**Claude Code plugin install:** when installed as a plugin, prefer `/codex-bridge:task`, `/codex-bridge:review`, `/codex-bridge:status`, `/codex-bridge:result`, `/codex-bridge:events`, `/codex-bridge:timeline`, `/codex-bridge:wait`, `/codex-bridge:send`, `/codex-bridge:respond`, and `/codex-bridge:cancel`.

Tasks are read-only unless the command opts into writes or config sets a wider sandbox. For file-changing work, use `--write`; for bridge-managed isolation, pair it with `--worktree-auto`.

When using `--worktree-auto`, prompts and brief text must name repo-relative
paths (`src/file.ts`), not absolute paths inside the launch checkout. Absolute
checkout paths still point at the main workspace, so the bridge rejects them
before creating the task worktree.

**Sandbox enforcement:** users who pin a sandbox policy can opt into enforcement
that orchestrators cannot silently downgrade with `--read-only`:

```yaml
codex_bridge:
  sandbox_policy: "danger-full-access"
  sandbox_enforce: true
```

Run `/codex-bridge:setup --enforce-sandbox` once to install the Claude
permission-layer deny rules. The bridge also denies `task --read-only` in the
PreToolUse Bash hook when `sandbox_enforce: true`, and Explore agent reroutes
use `--write --worktree-auto` instead of `--read-only`. Known limitations:
auto-pipeline check, standalone `review`, standalone `adversarial-review`, and
the stop-time review gate run read-only by design; disable the stop-time review
gate when enforcing sandbox pins.

## Parallel dispatch

For N >= 2 parallel jobs in a Claude Code plugin install, use
`/codex-bridge:fan-out`:

```bash
/codex-bridge:fan-out --group <name> --prompt "..." --prompt "..." [--read-only|--write]
```

Do NOT use `Agent { subagent_type: "codex-bridge:codex-bridge-runner" }` for
parallel dispatch. The runner is for single substantial handoffs; fan-out uses
direct Bash dispatch and tags every job with the same group.

After dispatch, track the group:

```bash
/codex-bridge:status --group <name>
/codex-bridge:wait --group <name> --all
/codex-bridge:bundle --group <name> --output ./audit.tar.gz
```

## When to use codex-bridge

Use it for substantial implementation, multi-file refactors, migrations, adversarial review, background coding jobs, and task→review→follow-up loops.

Skip it for quick lookups, single-symbol greps, tiny one-file edits, or foreign long-running commands such as `npm test` and `xcodebuild`. Monitor only understands codex-bridge `.events` files.

## How the runtime helps you

The plugin enforces sandbox, plan-mode, Monitor, and event filtering automatically through hooks. You don't think about them. Specifically:

- **Monitor arms itself** when you dispatch a `--background` task. The exclude tags, timeout, and verbosity come from the workspace config (`.claude/codex-bridge.local.md`).
- **Plan-mode triggers** when the user's prompt contains keywords like "plan" / "planla". You can override with `--mode default`.
- **Sandbox is pinned** to the workspace's configured policy. `--read-only` flags are stripped if the user has set `sandbox.enforce: true`.
- **Cadences** (checkpoint, heartbeat, idle timeout) are set from config; you cannot widen them mid-flight.

To inspect or change any of these: `/codex-bridge:config show` and `/codex-bridge:config set <key>=<value>`.

When a hook misbehaves: `CODEX_BRIDGE_HOOK_DISABLE=<name>` (or `=all`) bypasses it for one session. See `references/troubleshooting.md` for the full list.

## Core IDs

- **`jobId` / `task_id`** (`task-mo…` / `review-mo…`) — use for `status`, `result`, `wait`, `events`, `cancel`, `merge`, `verdict`, and `iterate`.
- **`threadId`** (UUID v7 `019d…`) — use for `send` and `steer`.

Do not pattern-match `[codex] Thread ready (019d…)` from stderr; that is a threadId. The `--json` envelope is canonical.

## Common commands

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --json --mode default "Inspect this bug and propose the smallest fix"
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --json --write --worktree-auto --background --effort high "Implement the requested change"
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs review --json --scope branch
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs status --json
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs events <jobId> --follow --exclude HEARTBEAT
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs respond <req-id> --answer "Use the existing API shape."
```

Every `--json` command returns `{ ok, schema_version, command, result, meta }` on success or `{ ok:false, error }` on failure. Use `result.next_action.command` and `result.monitor.tool_hint` verbatim. Sync `task --json` **blocks through the entire auto-pipeline** (review + completion check). With the default `auto_review: true`, a prompt with no code work still waits through the reviewer's stage timeout before returning. For interactive or low-latency work: pass `--no-pipeline` to keep diff capture while skipping review/fix/check, set `auto_review: false` in `config.yaml`, or use the async pattern below.

## Briefs

For non-trivial work, prefer a structured brief plus a real prompt. The brief is appended to the worker prompt and persisted with the task for review/check forensics.

```json
{
  "goal": "Add retry/backoff to the upstream fetcher",
  "worker_assignment": "Implement exponential backoff with jitter, max 3 attempts; preserve the public API; cover with a unit test.",
  "specific_concerns": [
    "Don't swallow non-retryable 4xx upstream errors",
    "Reuse the existing Config object"
  ]
}
```

`result.next_action.command` is already a ready-to-paste invocation in full `node /absolute/path/to/codex-bridge.mjs <sub> …` form — run it verbatim, no substitution required. The `codex-bridge <sub>` shorthand only appears in `--help` text and the printed exit-code doc; it is never written into the JSON envelope. There is no `codex-bridge` binary on `$PATH`.

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
| 8 | partial success | inspect `result` / `error.partial` for details |
| 1 | internal crash | escalate |

## How It Works

Every task follows this lifecycle:

1. **Plan phase** — Codex is instructed to plan first (effort: xhigh). May ask questions via `[QUESTION]` or produce a `[PLAN]`. Skip with `--mode default`.
2. **Plan approval** — If `[PLAN]` arrives, review and approve or revise.
3. **Execution phase** — Codex implements under the configured sandbox policy (see "Defaults that change Codex's behavior" below).
4. **Auto-pipeline** — emits observable signals: `[PIPELINE:diff]`→`[PIPELINE:diff:done]`, then optionally `[PIPELINE:review]`→`[PIPELINE:review:done]`, `[PIPELINE:fix]`→`[PIPELINE:fix:done] files=[a,b,c]`, `[PIPELINE:check]`→`[PIPELINE:check:done]`, and finally a terminal `[PIPELINE:done]` or `[PIPELINE:failed]`. Use `--no-pipeline` to keep diff capture but skip review/fix/check.
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
| Plan turn | 30 min | `turn_plan_ms` | `--turn-plan-ms` |
| Execute turn (also send turns in default mode) | 30 min | `turn_default_ms` | `--turn-default-ms` (task) / `--turn-timeout-ms` (send) |
| Per-stage pipeline (review/fix/check) | 12 min | `pipeline_stage_ms` | `--pipeline-stage-timeout-ms` |
| Pipeline total | 30 min | `pipeline_total_ms` | `--pipeline-total-timeout-ms` |
| Question unanswered (server request rejected) | 5 min | `question_answer_ms` | `--question-timeout-ms` |
| No-event idle (per turn) | 5 min | `idle_timeout_ms` | `--idle-timeout-ms` |

Idle fires a `[ERROR] … | ClientTimeout` with `origin: idle` (v1.4.1+; pre-1.4.1 this collapsed to `origin: turn`); pipeline-stage timeouts fire with `origin: pipeline:<actualStage>` and matching `failing_stage: <actualStage>`, while `PIPELINE_ERROR.lastCompletedStage` preserves the last finished stage. If Monitor goes silent and `status <id>` still reports `running` past the relevant timeout plus ~60 s buffer, the task is genuinely stuck — `cancel <id>` recovers.

### Observability guarantee (v1.3.0)

The `.events` file is **never silent for more than ~60 s** during a running turn, and an orchestrator always sees a rich summary at least every 5 min.

- **`[HEARTBEAT]` every ~60 s** (override: `CODEX_BRIDGE_HEARTBEAT_MS`). Non-terminal liveness pulse carrying elapsed time, phase, pid, last-item, budget remaining, and a re-attach tail command. Silence past ~90 s means the bridge wrapper is dead — investigate the pid, don't keep waiting.
- **`[CHECKPOINT]` every ~5 min** (override: `CODEX_BRIDGE_CHECKPOINT_MS`). Non-terminal rich summary: the last assistant message in full, every tool call in the interval with compact parameter previews (Read/Write/Edit paths, commands), git commits landed in that window, a `--shortstat` diff since the previous checkpoint, and a cumulative since-start diff. Designed so an orchestrator dropping in on a long-running task can catch up from one block instead of scrolling the entire ndjson.
- **Stall detection.** Three consecutive barren checkpoints (default: 15 min with zero commandExecution / fileChange / plan items — Codex alive but not progressing) fires a terminal `[ERROR] | StallDetected`. Monitor self-terminates; the orchestrator cancels or steers. Override the threshold with `CODEX_BRIDGE_STALL_CHECKPOINTS` (integer ≥ 2).
- **Early stall warning (`[STALL_WARNING]`).** v2.2.0. Fires at the first barren checkpoint (~5 min default) before the terminal stall fires at 15 min. Non-terminal; gives the orchestrator early warning to steer or cancel. Configurable via `stall_warning_threshold_ms` in config.yaml or `CODEX_BRIDGE_STALL_WARNING_MS` env var. Set to 0 to disable.
- **Attention routing (`[NEEDS_ATTENTION]`).** v2.2.0. Emitted alongside `[QUESTION]`, `[PLAN]`, and `[ERROR]`. At fan-out N, filter `NEEDS_ATTENTION` across all jobs to find "which jobs need me now?" without merging separate QUESTION/PLAN/ERROR streams.
- **File creation signals (`[ARTIFACT]`).** v2.2.0. Emitted when Codex creates a new file in the worktree (fileChange item with kind "create"). Structured fields: `filePath`, `size_bytes`. Gives the orchestrator explicit "artifact landed" events without diffing the worktree.
- **Scope drift heuristic (`[DRIFT_WARN]`).** v2.2.0. Fires when Codex touches files outside the inferred prompt scope (ratio > 30% AND > 3 drifted files). Conservative threshold; re-fires if scope is re-established then broken again. Non-terminal — orchestrator should review or cancel.
- **Finally-backstop.** A top-level `finally` block in `runBridgeTask` verifies a terminal tag landed before the turn returns or throws. If not, it synthesizes `[ERROR] | UnhandledExit`. That marker is itself a bug report — a turn exited past every instrumented branch; file an issue with the jobId and the events file.

**Raw-tail escape hatch.** The `Events dir:` / `Events file:` lines printed in the footer (and `result.eventsDir` / `result.eventsPath` in `--json`) are canonical paths you can `tail -f` directly, bypassing every bridge subcommand. Useful when the bridge CLI itself is behaving oddly — the file keeps being written as long as the wrapper process is alive.

### Interrupts vs progress signals (v1.4.0)

Tags in the stream fall into two semantic buckets. Orchestrators should handle them differently:

**Interrupts — act now.** Appear immediately, demand a response:

- `[QUESTION]` — Codex is blocked waiting for an answer; respond via `respond <request-id> --answer …`.
- `[PLAN]` — plan-mode turn produced a plan; terminal for wait/Monitor. Approve via `send <thread-id> --mode default "Implement the plan."` or revise.
- `[DONE]` / `[ERROR]` / `[INCOMPLETE]` / `[PLAN]` — terminal, Monitor self-closes. Branch on the origin line and `result.adapterResult.terminalTag` from `result --json`.

**Progress — periodic scan.** Informational; safe to process in batches:

- `[CHECKPOINT]` — primary LLM-facing digest (every ~5 min): last assistant message, tool calls with parameter previews, git commits, diff since last checkpoint. Read these for "what is Codex doing."
- `[HEARTBEAT]` — 60-s liveness pulse. **Excluded from Monitor by default** (would flood LLM context); still written to the `.events` file for raw-tail users and the 90-s liveness heuristic.
- `[PIPELINE:*]` / `[PIPELINE:*:done]` — auto-pipeline stage markers. Matter for "did the pipeline finish touching files" before you commit or verify.
- `[WARNING]` — circuit-breaker hit (e.g. headless-env osascript loop); cancel/steer if needed.
- `[CONFIRMED]` — a `[QUESTION]` got an answer; no action, just lifecycle trace.
- `[STALL_WARNING]` (v2.2.0) — early-warning signal before the terminal stall fires; actionable fields: `durationMs`, `remainingMs`, `last_action`.
- `[NEEDS_ATTENTION]` (v2.2.0) — composite tag emitted alongside QUESTION/PLAN/ERROR; filter this single tag across all parallel jobs to find which need attention now.
- `[ARTIFACT]` (v2.2.0) — a new file was created in the worktree; fields: `filePath`, `size_bytes`.
- `[DRIFT_WARN]` (v2.2.0) — Codex is touching files outside the inferred prompt scope; fields: `drifted_files`, `drift_ratio`, `prompt_scope`.

**Unknown tags pass through.** v1.4.0's default is `--exclude HEARTBEAT`, so any tag a future bridge version emits reaches the orchestrator verbatim. Your code should tolerate tags beyond this list — if you see `[FUTURE_TAG_V1_5] …`, show it and move on; don't assume the vocabulary is closed.

**Heads up — `[ERROR]` is ambiguous:** the events-file `[ERROR]` fires for *any* turn-level failure, including an auto-pipeline sub-stage timeout, while the sync `task --json` envelope for the same run can still report `ok:true` with `result.phase: "incomplete"` and `result.pipeline.error` populated. Monitor self-terminates either way; treat `[ERROR]` as "something broke — read `origin:` on the error line and `result.pipeline.error` in the envelope before retrying." Full triage in [references/error-recovery.md](references/error-recovery.md).

## Starting a Task

**Canonical pattern.** Launch with `--json`, read the envelope, hand `result.monitor.tool_hint` to Claude Code's Monitor tool. The envelope is the only place the bridge guarantees you see the correct `jobId` — *not* the thread UUID that appears in `[codex] Thread ready (…)` stderr progress.


```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --json --write --background --worktree-auto --brief @brief.json "Implement the task described in the Codex Bridge structured brief."
```

`specific_concerns` flows into adversarial review as privileged bias-correction context. Put "watch out for X" there, not in a sprawling worker prompt.

## Pointers

- **Per-command reference:** `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs <subcommand> --help`.
- **Config:** `config show --json` prints the merged config and layer diagnostics.
- **Event stream:** `events --help`; unknown tags are forward-compatible.
- **Error recovery:** `references/error-recovery.md`.
- **Brief composition:** `references/brief-composition.md`.
- **Monitor patterns:** `references/monitor-patterns.md`.
- **Notification format:** `references/notification-format.md`.
- **Troubleshooting:** `references/troubleshooting.md`.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --json --write --worktree-auto --background \
  --brief @brief.json \
  "Implement the task described in the Codex Bridge structured brief."
```

Do not run `task --brief @brief.json` with no prompt; the CLI rejects empty
task requests. If a task returns `[INCOMPLETE]`, use `iterate <task_id>` or a
fresh worktree task. Do not use `--resume-last --worktree-auto`; thread resume
does not imply worktree continuity and the CLI rejects that combination.

**`--write` interacts with two layers — `sandbox_policy` override wins over the mode-derived default.** Under the shipped `sandbox_policy: "danger-full-access"` default, every turn (plan *or* default) runs with full filesystem access regardless of `--write`; plan-mode is a *reasoning* constraint, not a sandbox one. The "first turn is readOnly" behavior only applies when you've tightened `sandbox_policy` to `"read-only"` (or cleared the override so the mode-derived default kicks in) — in that configuration, a plan-mode first turn runs `readOnly` and `--write` has no effect until a `send <thread-id> --mode default …` approves the plan. Pass `--mode default` on `task` to skip the plan turn in either configuration. `--mode` on `task --background` is also applied — the override flows through the job record into the detached worker.

**Fallback when `jq` isn't available.** Rendered (non-JSON) output ends with a one-line footer printed verbatim after Codex's final message:

```
Job: task-mo5xxxxx-yyyyyy · Events: /Users/you/.codex-bridge/sessions/<threadId>.events · Monitor: node … events task-mo5xxxxx-yyyyyy --follow --exclude HEARTBEAT --timeout-ms 1800000
```

That footer is your source of truth — do **not** pattern-match the `Thread ready (019d…)` line from stderr progress. The footer's `Job:` field is the `jobId`.

### Task-launch flags (added in 1.2.5)

| Flag | Effect | When to use |
|---|---|---|
| `--no-pipeline` | Keeps diff capture, skips auto-review/fix/check, and reports no-op write tasks as `[INCOMPLETE]` | You want a single turn and own the verification yourself |
| `--quiet` | Suppresses the `[codex] …` stderr progress stream | You want a clean console and rely on `events --follow` or Monitor |
| `--turn-default-ms <ms>` | Override per-turn timeout for execute turns | Large scaffolds that legitimately need >10 min |
| `--turn-plan-ms <ms>` | Override per-turn timeout for plan turns | Long-form planning across many specs |
| `--pipeline-stage-timeout-ms <ms>` | Override per-stage pipeline budget | Very large diffs; native reviewer needs longer than 12 min |
| `--pipeline-total-timeout-ms <ms>` | Override total pipeline budget | Very large runs |
| `--question-timeout-ms <ms>` | How long `requestUserInput` waits before rejecting the unanswered request | Slow loops / humans deliberating |
| `--idle-timeout-ms <ms>` | Override the no-event idle watchdog | Reasoning-heavy tasks that go quiet between app-server events |

All values are milliseconds; malformed (non-positive / non-numeric) inputs throw `usage` (exit 2). Example of a scaffold that needs extra execute time:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write --mode default --background \
  --turn-default-ms 1800000 --pipeline-stage-timeout-ms 1200000 --pipeline-total-timeout-ms 3600000 --json \
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
6. **Use bridge merge gates for worktree tasks.** For `subagent/codex/<task_id>`
   branches, run `result`, review or `adversarial-review`, record/inspect the
   `verdict`, then use `merge <task_id>`. Manual `git merge subagent/codex/*`
   is a recovery path, not the normal happy path.
7. **Cancel cleans up abandoned worktree tasks.** `cancel <job-id>` removes the
   bridge-created worktree and `subagent/*/<task_id>` branch by default. Use
   `--keep-worktree`, `--keep-branch`, or `--keep-all` only when you explicitly
   need to inspect the cancelled checkout afterward.

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

- Cancel: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs cancel <job-id>` if the environment genuinely can't run the family; add `--keep-all` only if you need to inspect a cancelled worktree
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
| `pipeline:<stage>` | Auto-pipeline sub-stage failure. `<stage>` matches `failing_stage:`; `PIPELINE_ERROR.lastCompletedStage` records the previous completed stage. The main task may still have succeeded. | `inspect` with `result`, then `rerun-review`. |
| `bridge` | Bridge safety net fired — indicates a bridge bug. Distinguish `StallDetected` vs `UnhandledExit` by `errorCode`. | File a report with the jobId + events file. |

A pipeline-origin `[ERROR]` can coexist with a `task --json` success envelope whose `result.phase: "incomplete"` and `result.pipeline.error` are set — read the envelope before retrying. The `actions:` block inside each `[ERROR]` is cause-aware and always ends with a `see:` line pointing to the right anchor in [references/error-recovery.md](references/error-recovery.md).

### Upstream retry + handoff (v1.5.0)

For `upstream:*` origins the bridge runs an exp-backoff retry loop before surfacing the error (policy keyed by origin; see `UPSTREAM_RETRY_POLICY` in the source). Each retry attempt emits a non-terminal `[RETRYING] attempt n/max | origin=… | backoff=…ms` block so a reader watching `events --follow` can tell a slow turn apart from a stalled one.

On retry exhaustion (or immediately for `upstream:auth`, which has no retry policy), the bridge emits a `[HANDOFF]` block **before** the terminal `[ERROR]`. The handoff surfaces the full continuation context — artifact paths, committed shas, retry history, upstream request id — so another agent (or a human) can pick up where the failed turn left off without hand-reconstructing state from `git log`. The same payload ships on the JSON envelope under `error.handoff`. See [references/orchestration-flows.md#recovering-from-upstream-state-loss](references/orchestration-flows.md#recovering-from-upstream-state-loss) for the consumer recipe.

When commits landed before the error, a `[PARTIAL] commits=[…]` block precedes `[HANDOFF]` (and mirrors to `error.partial`). The bridge snapshots git at turn start and diffs on failure; a non-empty `partial.commits` list is the cheapest way to answer "did my turn actually do anything before it died?"

## When NOT to use Monitor

Monitor is bound specifically to codex-bridge `.events` files and their tag vocabulary (`[DIRECTIVES]`, `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, `[PLAN]`, `[QUESTION]`, `[CONFIRMED]`, `[PIPELINE:*]`, `[WARNING]`, `[HEARTBEAT]`, `[CHECKPOINT]`, `[PARTIAL]`, `[RETRYING]`, `[HANDOFF]`). Re-arming Monitor on a foreign process whose stdout doesn't emit those tags will only ever time out — the filter never matches, Monitor waits the full `timeout_ms`, then reports `stream ended`. This wastes orchestrator turns and teaches the agent nothing.

**Monitor is single-job.** One Monitor call tails one `.events` file and self-terminates on one terminal tag. For N > 1 parallel Codex jobs, do **not** stack N Monitor calls — use `status --watch` for a live table view of all tracked jobs, or `await-artifact` to block on the specific file each job will produce. See "Running N jobs in parallel" below and `references/orchestration-flows.md` for the full fan-out / fan-in pattern.

| Situation | Use this |
|---|---|
| Codex task running in the background; you need the terminal tag | Monitor (canonical) |
| `xcodebuild` / `npm test` / `cargo build` / `pytest` / any foreign long command | `Bash` with `run_in_background: true`, then poll with `BashOutput` or wait for the task handle |
| Polling a file for content (not a tag) | Plain shell loop (`until [ -s path ]; do sleep 1; done`) |
| Watching pipeline's diff-level changes | `events --follow --filter PIPELINE` (symmetric `:done` tags as of 1.2.5) |

Rule: if the thing you're watching doesn't write to `~/.codex-bridge/sessions/<threadId>.events` with one of the listed tags, Monitor is the wrong tool.

## Group-based multi-job orchestration

For fan-out workflows, label related dispatches with `--group <name>` and use group-aware read commands:

```bash
# Dispatch a wave with a group label
for prompt in prompts/*.md; do
  node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs task --write --mode default --background --json \
    --group audit-2026-05 --prompt-file "$prompt"
done

# Filter status to only the group
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs status --group audit-2026-05 --json

# Watch only the group until all jobs terminate
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs status --watch --group audit-2026-05
```

Group names are alphanumeric + hyphens, max 64 chars. Dispatches without `--group` work exactly as before.

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
- One `result` call per job to read the structured outcome (`jq '.result.adapterResult.terminalTag, .result.adapterResult.phase, .result.adapterResult.consistent'`).
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
- **Merged forensic timeline:** `timeline <job-id>` interleaves `.events`, `.ndjson`, the task log, and worker stderr by timestamp. Use `--source events`, `--since <iso-ts>`, or `--format json|html` for narrower incident analysis.
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

### Conversational config editing

Use `/codex-bridge:config` to read or change config without manually editing YAML:

```
/codex-bridge:config show              # see all settings + provenance
/codex-bridge:config set mode=default
/codex-bridge:config set idle_timeout_ms=600000
/codex-bridge:config explain mode
/codex-bridge:config reset             # restore plugin defaults
/codex-bridge:config validate          # check the workspace config for errors
```

After any `set` or `reset`: restart Claude Code to apply (hooks load at session start).

From the CLI: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs config show` prints the effective merged config plus which of the four source files are being read. Use it to debug "why isn't my config taking effect?".

Full documentation: [references/config-reference.md](references/config-reference.md).

## Session Files

Each task writes artifacts to `~/.codex-bridge/sessions/` (or `config.session_dir`):

- `{threadId}.events` — Monitor tails this. Tags emitted: `[DIRECTIVES]` (first event of every turn — non-terminal echo of the effective runtime config: `mode`, `effort`, `sandbox`, `approval` when set, `quiet`, `skip_meta_skills`, `pipeline`, `model` when set), `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, `[PLAN]`, `[QUESTION]`, `[CONFIRMED]`, `[WARNING]`, `[HEARTBEAT]` (every ~60 s during any running turn — non-terminal liveness pulse), `[CHECKPOINT]` (every ~5 min — non-terminal rich summary: last assistant message, tool calls, git delta, commits since last checkpoint), `[PIPELINE:diff|review|fix|check]` with matching `:done` pair, and terminal `[PIPELINE:done]` or `[PIPELINE:failed]`. v2.2.0 adds: `[STALL_WARNING]` (early stall warning after 5 min of no actionable progress), `[NEEDS_ATTENTION]` (alongside QUESTION/PLAN/ERROR for fan-out routing), `[ARTIFACT]` (new file created), `[DRIFT_WARN]` (out-of-scope file touch heuristic). A `[ERROR] | UnhandledExit` block indicates the bridge's finally-backstop fired — the turn exited without any other error branch emitting a terminal tag. A `[ERROR] | StallDetected` block indicates 3 consecutive checkpoints (15 min by default) had zero actionable items — Codex is alive but not progressing; orchestrator should cancel or steer.
- `{threadId}.ndjson` — Curated retrospective log (turn params, item completions, questions, errors, pipeline stages). Not a full wire mirror. See [references/ndjson-guide.md](references/ndjson-guide.md).
- `{threadId}.diff` — `git diff HEAD` snapshot captured by the pipeline.
- `{threadId}.plan.md` — Written when Codex emits a structured `item/completed` with `type: "plan"`.

A `{threadId}.pending.json` / `.response.json` pair appears transiently while a `requestUserInput` is in flight (consumed-on-read). `{threadId}.review.json` is written by adversarial review; `[REVIEW]` and `[PHASE]` remain reserved helper formats.

## Forensics: when something fails

The detached background worker dup's its stderr to `<logFile>.worker.err` (sibling of the per-job `.log`). Network errors, rate-limit replies, codex-CLI parser failures, sandbox denials, and process-level crashes land there. The bridge surfaces them two ways so first-pass triage stays in-stream:

- **Event stream** — when worker.err grows during a turn, the bridge polls every 5 s and emits `[WORKER_STDERR] <threadId> | size=… | delta=… | class=…` with the last 500 bytes appended as `tail:`. Throttled to one block every 30 s with delta aggregation; one final drain runs on terminal so a stack trace written milliseconds before the worker exits still lands. `class` is a heuristic (`network`, `rate_limit`, `permission`, `crash`, `missing_dependency`, `unknown`) — always read the tail itself when triaging.
- **Result envelope** — `result --json` populates `result.adapterResult.workerErr.{path, size_bytes, tail, truncated, error_class_hint}` when the file is non-empty. Read the `path` for full content; `tail` is bounded to ~500 bytes.

```bash
# Spot-check after a job fails:
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs result <task_id> --json | jq '.result.adapterResult.workerErr'

# Or pull the full stderr file:
cat "$(node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs result <task_id> --json | jq -r '.result.adapterResult.workerErr.path')"
```

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

# Broader health report: stale jobs, orphan task worktrees/branches, old
# session files, disk usage, and Codex CLI/auth status. Add --clean --yes
# for non-interactive cleanup; dirty worktrees require --force.
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs doctor --json

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

`version --json` reports the bridge capability list plus the active backend (`active_backend`) and its declared `adapter_capabilities`; prefer those fields over prose assumptions when choosing backend-dependent flows. It resolves the backend through `--backend`, `CODEX_BRIDGE_BACKEND`, cwd config, workspace config, then skill/user config.

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
| [state-machine.md](references/state-machine.md) | How `result --json` derives terminal state |
| [error-recovery.md](references/error-recovery.md) | Error types and recovery strategies |
| [config-reference.md](references/config-reference.md) | YAML configuration options |
| [prompt-writing.md](references/prompt-writing.md) | Writing effective Codex prompts |

When in doubt, ask the runtime first, then read prose. Prose ages; the runtime is canonical.
