# Command Reference

## Global

- `-j, --json` — machine-readable output on stdout. On failure, a JSON error envelope is still written to stdout (success payload shape is per-command for now; error shape is uniform).
- `-C, --cwd <dir>` — override the working directory (git ops + Codex spawn use this).
- `-h, --help` — per-subcommand help; short-circuits before any Codex turn.

Progress lines (`[codex] …`) always go to **stderr**; stdout is reserved for the final rendered markdown or JSON envelope.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | crash / unhandled internal error (crash log written to `~/.codex-bridge/crashes/`) |
| 2 | usage error (unknown subcommand, unknown flag, missing argument) |
| 3 | not found (job, thread, resource) |
| 4 | auth failure (run `codex login`) |
| 5 | conflict (already running, state mismatch) |
| 6 | validation error (bad input) |
| 7 | transient error (timeout, network, rate-limit) — retry with backoff |
| 8 | partial success (command completed with caveats — inspect `result` / `error.partial` for details) |

### Success envelope (every `--json` success)

```json
{
  "ok": true,
  "schema_version": "1.0",
  "command": "status",
  "result": { "...": "per-command shape" },
  "meta": { "duration_ms": 313 }
}
```

### Error envelope (every failure under `--json`)

```json
{
  "ok": false,
  "schema_version": "1.0",
  "error": {
    "class": "not_found",
    "code": "JOB_NOT_FOUND",
    "message": "No job found for \"bogus\".",
    "retryable": false,
    "suggestion": "Run `status` to list known jobs."
  },
  "command": "status"
}
```

`error.class` maps 1:1 to exit code (see table above). `error.code` is a stable SCREAMING_SNAKE_CASE token you can switch on. `ok` is a single universal branch key across every subcommand.

Every CLI-boundary error returns this envelope, including **unknown subcommands** (routed through `error.code: "UNKNOWN_SUBCOMMAND"`, class `usage`, exit 2) and **unknown flags** (`USAGE_ERROR`, exit 2). An agent can parse stdout as JSON on any failure path when `--json` is requested, or detect the same `USAGE_ERROR` anywhere in argv (`--json`, `-j`) on the unknown-subcommand branch.

Codes introduced in the current build:

- `INVALID_THREAD_ID` (validation, 6) — `send`/`steer` rejected a non-UUID thread id before any Codex call.
- `WAIT_TIMEOUT` (timeout, 7) — `wait` exceeded `--timeout-ms` without a terminal tag.
- `REVIEW_EMPTY_DIFF` (validation, 6) — `review --scope working-tree` (or `--scope auto` resolving there) on a clean tree + index.
- `UNKNOWN_SUBCOMMAND` (usage, 2) — typo at the subcommand slot.

### Codex turn failures

When a task or review Codex turn fails, the exit code is mapped from Codex's own error taxonomy:

| `codexErrorInfo` | exit code | class |
|---|---|---|
| `Unauthorized` | 4 | auth |
| `ContextWindowExceeded` | 6 | validation |
| `UsageLimitExceeded` | 7 | rate_limit |
| `HttpConnectionFailed`, `ResponseStreamConnectionFailed`, `ResponseStreamDisconnected` | 7 | network |
| `ClientTimeout` (synthesized on transport silence) | 7 | timeout |
| `ProcessDeath` (Codex process exited) | 7 | dependency_failed |
| `InternalServerError` | 7 | dependency_failed |
| `BadRequest` | 6 | validation |
| `SandboxError` | 5 | conflict |
| `ResponseTooManyFailedAttempts` | 1 | internal |
| `ActiveTurnNotSteerable`, `Other`, unrecognized variants | 1 | internal |

Codes synthesized by the bridge from upstream error messages (string-matched in `classifyError`, not carried on Codex's `codexErrorInfo`):

| Synthesized `error.code` | Exit | Class | Retryable? |
|---|---|---|---|
| `UPSTREAM_STREAM_DISCONNECTED` (transport drop: websocket closed / ECONNRESET / socket hang up) | 7 | network | yes (auto-retried by `upstream:transport` policy) |
| `PreviousResponseNotFound` (upstream 400 `previous_response_not_found` — dead resp_id) | 7 | dependency_failed | yes, **by new task only**; `send` on the same thread repeats the 400 forever |
| `UpstreamUnauthorized` (upstream 401 from Codex auth or proxy layer) | 4 | auth | no — reauth before relaunch |
| `UpstreamInvalidRequest` (upstream 400 `invalid_request_error` not matched by the above) | 6 | validation | yes — auto-retried 3× before handoff |

### `task --json` `phase` + `next_action`

Synchronous `task --json` returns a `result.phase` and `result.next_action` alongside the usual fields so a single call is self-sufficient — no need to tail `.events`.

| `phase` | Meaning | `next_action.command` |
|---|---|---|
| `plan-pending` | Plan detected; awaiting approval | `codex-bridge send <tid> --mode default "Implement the plan."` |
| `done` | Task completed (pipeline ran clean or was skipped) | `codex-bridge result <job-id>` |
| `incomplete` | Pipeline's completion check flagged gaps | `codex-bridge send <tid> "Complete the missing items"` |
| `workspace-dirty` | Codex produced a diff but the sandbox blocked the final commit (e.g. `workspace-write` refused `.git/` writes). Success envelope includes `sandboxError` + `touchedFiles`. | `git -C <cwd> add -A && git -C <cwd> commit -m "<subject>"` (or re-run with `sandbox_policy: danger-full-access`) |

A failed `task --json` **does not** return a success envelope with `phase=error`. It returns the standard error envelope (`ok:false, error:{class,code,…}`) on stdout, and the exit code reflects the error class. The phases above apply only to successful turns.

## task

Start a new Codex task. Default: plan mode, configured sandbox, foreground.

```
codex-bridge task [--backend <name>] [--write] [--worktree-auto | --no-worktree-auto] [--base-ref <ref>] [--on-branch <name>] [--effort <level>] [--mode <plan|default>] [-m <model>]
                  [--prompt-file <path>] [--resume | --resume-last] [--fresh]
                  [--background] [--no-pipeline] [--quiet]
                  [--idle-timeout-ms <ms>] [--turn-plan-ms <ms>] [--turn-default-ms <ms>]
                  [--pipeline-stage-timeout-ms <ms>] [--pipeline-total-timeout-ms <ms>]
                  [--question-timeout-ms <ms>] [--json] [prompt or file.md]
```

| Flag | Description |
|------|-------------|
| `--backend <name>` | Select backend for this run. In this build only `codex` is implemented; other names exit 6 `BACKEND_INCAPABLE`. |
| `--write` | Request write-capable execution. Write-mode tasks use per-task worktree isolation by default. **Ship default note:** `sandbox_policy` ships as `"danger-full-access"`, which takes precedence over the mode-derived branch — so Codex can write when the turn enters default mode. |
| `--worktree-auto` | Explicitly request the default worktree isolation for `--write`. Prompts must use repo-relative paths for files inside the launch checkout; absolute launch-checkout paths are rejected. |
| `--no-worktree-auto` | Opt out of default worktree isolation and let Codex write in the launch checkout. Use only when in-place edits are intentional. |
| `--base-ref <ref>` | Base ref for isolated write tasks. Omit to inherit the current branch; pass `main`, `master`, `refs/heads/<branch>`, a commit SHA, or `current`. The dispatch envelope records `worktree.base_ref`, `worktree.base_ref_source`, and `worktree.base_sha`. |
| `--on-branch <name>` | Assert the launch checkout is on `<name>` before dispatch. Mismatch fails with `BRANCH_MISMATCH`; during task execution, later detected branch movement emits `[BRANCH_SWITCHED]`. |
| `--effort <level>` | Reasoning effort for this task turn, including plan mode: none, minimal, low, medium, high, xhigh |
| `--mode <plan\|default>` | Override `config.mode` for this single run. Honored on both foreground and background paths. Rejected with `USAGE_ERROR` (exit 2) for any other value. |
| `-m, --model <name>` | Upstream model for this task turn and its auto-pipeline stages; `spark` resolves to `gpt-5.3-codex-spark` |
| `--prompt-file <path>` | Read prompt from file instead of argv/stdin |
| `--resume`, `--resume-last` | Continue the latest tracked thread for this session. Thread-only resume; rejected with `--worktree-auto`. Use `iterate <task_id>` for follow-up work that must preserve task worktree state. |
| `--fresh` | Start a new thread even if a resumable one exists |
| `--background` | Detached worker; returns immediately with a job id |
| `--no-pipeline` | Keep diff capture but skip auto-review/fix/check for this single run (overrides `auto_review` / `post_task_prompt` from config). Ndjson carries a `PIPELINE_SKIPPED` entry naming the skipped validation stages; write-mode runs that touch no files report `[INCOMPLETE] no_files_touched`. |
| `--quiet` | Suppress the `[codex] …` stderr progress stream so agents don't pattern-match the threadId out of progress lines. **`--json` implies `--quiet`** (v1.4.1) unless `--quiet=false` is passed explicitly: when the envelope is consumed by a machine, the stderr UUID trap would otherwise derail it. |
| `--idle-timeout-ms <ms>` | Override no-event idle watchdog (default `idle_timeout_ms = 300000`) |
| `--turn-plan-ms <ms>` | Override per-turn timeout for plan turns (default `turn_plan_ms = 1800000` = 30 min; raised in v1.3.0 from the pre-1.3.0 5 min hard-code) |
| `--turn-default-ms <ms>` | Override per-turn timeout for execute turns (default `turn_default_ms = 1800000` = 30 min; raised in v1.3.0 from the pre-1.3.0 10 min hard-code) |
| `--pipeline-stage-timeout-ms <ms>` | Override per-stage pipeline timeout (default `pipeline_stage_ms = 720000`) |
| `--pipeline-total-timeout-ms <ms>` | Override total pipeline timeout (default `pipeline_total_ms = 1800000`) |
| `--question-timeout-ms <ms>` | How long `requestUserInput` waits before logging `QUESTION_TIMEOUT` and replying with `result: { answers: {} }` (empty-answer success, not a rejection — `src/codex-bridge.mjs:2197`). Default `question_answer_ms = 300000`. |

All `*-ms` flags require positive integers; malformed values throw `USAGE_ERROR` (exit 2) rather than silent fallback.

Plan mode defaults to `effort: xhigh`, but an explicit `--effort` is honored. Empty prompts fail fast with exit 6 — no billed Codex turn.

`--mode default` + `--write` skips the plan turn and runs execution directly under `workspaceWrite` (or `danger-full-access` if configured). The override flows through `buildTaskRequest` → stored job record → detached worker, so `task --background --mode default` executes in default mode as expected.

Every `task` launch success envelope includes `result.runtime` with requested/effective mode, model, effort, per-stage models, enabled pipeline stages, and warning strings when a resolved value differs. It also includes `result.monitor = { command, shell_fallback, terminal_tags, exclude_tags, timeout_ms, tool_hint }`. `result.monitor.command` is a ready-to-paste `node <scriptPath> events <jobId> --follow --exclude HEARTBEAT,CHECKPOINT --timeout-ms 1800000` invocation (v1.4.0 switched the Monitor default to exclusion-based filtering so future tags pass through — `exclude_tags` names the excluded list); `result.monitor.tool_hint` is the argument object for the `Monitor` tool (`description`, `command`, `timeout_ms`, `persistent`).

Thread IDs returned by `task` are UUID v7 strings (e.g. `019d9a86-1c8a-7f41-8032-6c76bbe730a1`). There is no `thr_` prefix; do not build regexes that assume one.

## send

Resume a thread with a new prompt. Used for plan approval, revisions, and follow-ups.

```
codex-bridge send <thread-id> [--backend <name>] [--mode <plan|default>] [--on-branch <name>] [--effort <level>] [--quiet]
                              [--idle-timeout-ms <ms>] [--turn-timeout-ms <ms>]
                              [--question-timeout-ms <ms>] [--json] [prompt or file.md]
```

| Flag | Description |
|------|-------------|
| `--backend <name>` | Select backend for this follow-up. In this build only `codex` is implemented; other names exit 6 `BACKEND_INCAPABLE`. |
| `--mode <plan\|default>` | Switch collaboration mode. Omit to keep current mode. |
| `--on-branch <name>` | Assert the checkout is on `<name>` before resuming the thread. Mismatch fails with `BRANCH_MISMATCH`; a branch movement detected after the follow-up emits `[BRANCH_SWITCHED]`. |
| `--effort <level>` | Override reasoning effort for this turn |
| `--quiet` | Suppress `[codex] …` stderr progress |
| `--idle-timeout-ms <ms>` | Override no-event idle watchdog |
| `--turn-timeout-ms <ms>` | Single knob for the turn budget; maps onto `turn_plan_ms` when `--mode plan`, `turn_default_ms` otherwise (also when no `--mode` flag is passed) |
| `--question-timeout-ms <ms>` | Override `requestUserInput` answer timeout |

Plan approval: `send <thread-id> --mode default "Implement the plan."`
Plan revision: `send <thread-id> "Revise step 2: ..."`

`send` validates `--mode` (must be `plan` or `default`; else exit 2 `USAGE_ERROR`) and the thread-id shape (must be a UUID v7 / 8-4-4-4-12 hex; else exit 6 `INVALID_THREAD_ID`) before any Codex call. All `*-ms` flags require positive integers.

## steer

Send mid-turn guidance to an active Codex turn.

```
codex-bridge steer <thread-id> <turn-id> [prompt or file.md]
```

Cannot steer review or compaction turns (app-server rejects with -32600). Thread-id is pre-validated (UUID v7); malformed ids exit 6 `INVALID_THREAD_ID`.

## respond

Answer a question from Codex (triggered by [QUESTION] notification).

```
codex-bridge respond <request-id> --question-id <qid> --answer <answer>
codex-bridge respond <request-id> --json-payload '{"answers":{"q1":{"answers":["jwt"]}}}'
```

| Flag | Description |
|------|-------------|
| `--question-id <qid>` | Question ID from the notification (defaults to first) |
| `--answer <answer>` | Answer text (option label or custom text if isOther) |
| `--json-payload <json>` | Raw JSON response (escape hatch) |

## review

Run a standalone code review using Codex's built-in reviewer. **This runs a billed Codex turn** (not a local diff probe); expect 30–180 s and tokens proportional to the diff size.

```
codex-bridge review [--backend <name>] [--scope <auto|working-tree|branch>] [--base <ref>] [-m <model>] [--json]
```

| Flag | Description |
|------|-------------|
| `--backend <name>` | Select backend for the review. In this build only `codex` is implemented; other names exit 6 `BACKEND_INCAPABLE`. |
| `--scope auto` | Auto-detect: dirty tree → working-tree, clean → branch (default) |
| `--scope working-tree` | Review uncommitted changes |
| `--scope branch` | Review branch vs base |
| `--base <ref>` | Base branch for comparison (auto-detects main/master/trunk) |

`--scope working-tree` (and `--scope auto` when it resolves to working-tree) **short-circuits with exit 6 `REVIEW_EMPTY_DIFF`** when both `git diff --quiet` and `git diff --cached --quiet` succeed — no billed turn. `--scope branch` does not short-circuit.

Focus text is not accepted by `review`. Use `adversarial-review` for custom focus.

## adversarial-review

Run an adversarial review with structured JSON output.

```
codex-bridge adversarial-review [--backend <name>] [--scope <s>] [--base <ref>] [-m <model>] [--json] [focus text...]
```

Focus text directs the reviewer's attention (e.g., "focus on SQL injection risks").

## summary

Generate a readable markdown transcript from NDJSON session log.

```
codex-bridge summary <thread-id> [--tail <n>] [--json]
```

| Flag | Description |
|------|-------------|
| `--tail <n>` | Number of NDJSON lines to process (default: 200) |

## status

Check job status. The positional accepts either a job id (e.g. `task-mo2n0i8z-cbefzo`) or the thread UUID — the resolver tries id-exact, then thread-id-exact, then id-prefix.

```
codex-bridge status [job-id-or-thread-id] [--all] [--session <id>] [--since <iso-ts>] [--wait]
                    [--filter running|completed_success|completed_fail|completed_incomplete|cancelled|needs_attention]
                    [--watch [--interval <ms|5s>] [--watch-timeout-ms <ms>]]
                    [--prune-orphans | --cleanup]
                    [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]
```

| Flag | Description |
|------|-------------|
| `--all` | Show jobs from all Claude sessions instead of the current implicit Claude session |
| `--session <id>` | Filter list/watch status to one recorded `sessionId`. May be combined with `--all` to make the scope explicit. |
| `--since <iso-ts>` | Filter list/watch status to jobs whose created/started/updated/completed timestamp is at or after the supplied ISO timestamp. |
| `--filter <state>` | Return a subset for orchestrator scripts. Values: `running`, `completed_success`, `completed_fail`, `completed_incomplete`, `cancelled`, `needs_attention`. `completed_fail` is event-derived and includes jobs whose `.events` stream contains `[ERROR]` or `[PIPELINE:failed]`. |
| `--wait` | Poll until the single-job reaches a terminal state |
| `--watch` | Repeatedly render the multi-job table and exit when every tracked job reaches a terminal state (Ctrl-C-safe). Rejects a positional job-id; mutually exclusive with `--wait` / `--prune-orphans` / `--cleanup`. Use for N-job orchestration. Under `--json` emits one NDJSON snapshot per tick. |
| `--interval <ms>` | Tick cadence for `--watch` (default 10 000 = 10 s). Accepts plain ms or duration strings like `5s`. |
| `--watch-timeout-ms <ms>` | Overall deadline for `--watch` (default: none — runs until all tracked jobs are terminal or SIGINT). |
| `--prune-orphans` / `--cleanup` | Walk state-file jobs with `status:"running"` or `"queued"` and mark any whose PID no longer resolves as `status:"orphaned"`. Idempotent. Returns `{reaped, skipped, reapedCount, skippedCount}`. Mutually exclusive with `--wait`. |
| `--timeout-ms <ms>` | Max wait time with `--wait` (default 240000) |
| `--poll-interval-ms <ms>` | Poll cadence with `--wait` (default 2000) |

Without a job id, `status --json` includes `result.jobs` as an array every time (`[]` when no jobs match), `result.summary`, `result.needs_attention`, and `result.as_of`. Single-job JSON uses `result.job` instead and does not include `result.jobs`. `summary.running === 0` only means the wave is terminal; check `summary.completed_fail`, `summary.completed_incomplete`, and `summary.awaiting_attention` before advancing a fan-out wave.

Active job objects include a bounded `progress` digest derived from existing job logs and events:

```json
{
  "id": "task-...",
  "status": "running",
  "phase": "editing",
  "progress": {
    "elapsed_seconds": 312,
    "artifacts_written": 2,
    "target_artifacts": null,
    "shell_commands_run": 19,
    "last_action": "File changes completed.",
    "last_action_at_seconds": 308,
    "tokens_consumed_estimate": null,
    "events_since_last_status": 4
  }
}
```

### status --prune-orphans / --cleanup

Reaps state-file ghosts. For each job with `status:"running"` or `"queued"`:

- If the recorded `pid` is `null` or invalid → reap with `reason:"no-pid"`.
- If `process.kill(pid, 0)` throws `ESRCH` → reap with `reason:"dead-pid"`. The job transitions to `status:"orphaned"` and gets an `errorMessage: "Reaped by status --prune-orphans at <ts> (<reason>)"`.
- If `process.kill(pid, 0)` succeeds or throws `EPERM` (process exists, may belong to another user) → keep. Signal denial is conservative — we don't reap something we merely can't signal.

```json
{
  "workspaceRoot": "/path/to/project",
  "reaped": [{ "id": "task-…", "previousStatus": "running", "reason": "dead-pid", "pid": 12345 }],
  "skipped": [],
  "reapedCount": 1,
  "skippedCount": 0,
  "ts": "2026-04-19T14:32:11.000Z"
}
```

Use when `status` shows a pile of "running" jobs that aren't actually alive (e.g. after a session kill that didn't update state files). See `unexpected-bridge-observations/06-stop-gate-review-accumulates-orphaned-running-tasks.md` for the motivating incident.

## result

Get the full result of a completed job. Accepts either a job id or the thread UUID.

```
codex-bridge result [job-id-or-thread-id]
                    [--transcript [--final-only] [--format markdown|text|json]]
                    [--json]
```

In JSON mode, `result.adapterResult.summary` and `result.adapterResult.finalMessage` contain the complete stored final assistant message when available. `result.adapterResult.terminalTag` is derived from the job's `.events` file when that file exists. The worker process status is exposed separately as `result.adapterResult.workerExitCode`; if the two disagree, `result.adapterResult.consistent` is `false` and `discrepancyReason` explains the split. See [state-machine.md](state-machine.md) for the truth table.

Use `--transcript --final-only --format text` to print only Codex's final assistant answer. Without `--final-only`, `--transcript` prints captured assistant messages from the NDJSON replay log, falling back to the stored final message when no replay log is present.

## cancel

Cancel a running job. Attempts `turn/interrupt` before terminating the worker tree. Accepts either a job id or the thread UUID.

```
codex-bridge cancel [job-id-or-thread-id] [--json]
```

## wait

Block until one or more target job event files match a predicate. Uses `fs.watch` plus a 500 ms poll fallback; cheaper and more reliable than `status --wait` when you only need event-backed fan-in.

```
codex-bridge wait [--all | --any] [--jobs <ids>] <job-id-or-thread-id...>
                  [--predicate terminal|interrupt|error|both]
                  [--timeout-ms <ms>] [--json]
```

| Flag | Description |
|------|-------------|
| `--all` | Wait until every listed job matches. This is the default when multiple targets are passed. |
| `--any` | Return as soon as the first listed job matches. Requires at least two targets. |
| `--jobs <ids>` | Space- or comma-delimited target list; may be combined with positional ids. |
| `--predicate <name>` | Match `terminal` (default: `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, `[PLAN]`, `[CANCELLED]`), `interrupt` (`[PLAN]`, `[QUESTION]`), `error` (`[ERROR]`, `[INCOMPLETE]`), or `both` / `interrupt+terminal`. |
| `--timeout-ms <ms>` | Overall deadline (default 600000 = 10 min). Exit 7 `WAIT_TIMEOUT` on expiry. |
| `--json` | Emit the standard success envelope on stdout when the predicate matches. |

Single-target terminal waits keep the legacy payload shape:
```json
{
  "jobId": "task-...",
  "threadId": "019d...",
  "terminalTag": "DONE" | "ERROR" | "INCOMPLETE" | "PLAN" | "CANCELLED",
  "lastEventLine": "[DONE] 019d... completed in 4s | 1 files | +2 -0",
  "eventsPath": "/abs/path/to/events",
  "elapsedMs": 3214
}
```

`--any` returns top-level `jobId`, `threadId`, `state`, `terminalTag`, `interruptTag`, `lastEventLine`, and `eventsPath`, plus `winner.{jobId,threadId,state,terminalTag,interruptTag,lastEventLine,eventsPath}` and the target list. `--all` returns `{ summary, jobs }`, where `summary` includes `total`, `matched`, `pending`, `completed`, `failed`, `cancelled`, `questions`, and terminal/interrupt counts. On timeout, the JSON error envelope carries `error.details.summary`, matched `jobs`, and still-pending targets.

When the target thread never writes an events file (e.g. a cancelled-before-start job), `wait` polls every 500 ms for the file to appear and falls through to `WAIT_TIMEOUT` (exit 7) once `--timeout-ms` expires. For threads you suspect will never produce events, pass a smaller `--timeout-ms`; use `status --wait` when you need the deeper lifecycle view across all jobs.

## events

Stream the target's `.events` file to stdout, with optional tag filter and follow mode. Steers agents toward a line-delimited event stream without the need for a hand-rolled `tail -f` pipeline.

```
codex-bridge events <job-id-or-thread-id> [--follow] [--filter <tags> | --exclude <tags>] [--timeout-ms <ms>] [--json]
```

| Flag | Description |
|------|-------------|
| `--follow` | Keep watching for appended lines; self-terminates on any terminal tag (`[DONE]`, `[ERROR]`, `[INCOMPLETE]`, `[PLAN]`, `[CANCELLED]`) — even if already present in the initial dump. |
| `--filter <tags>` | **Inclusion** list. Only lines whose head tag is in the comma-separated list pass. `PIPELINE` matches `[PIPELINE:review]`, `[PIPELINE:fix:done]`, etc. Case-insensitive. Narrow views only — **not forward-compatible** (any new tag a future bridge version emits is silently dropped). |
| `--exclude <tags>` | **Exclusion** list (v1.4.0, default for Monitor). Every line passes *except* those whose head tag is in the list. Future tags pass through automatically — forward-compatible. Mutually exclusive with `--filter`. |
| `--timeout-ms <ms>` | Deadline for `--follow`; default 600 000 (10 min). For long turns, pass a larger value explicitly — e.g. `--timeout-ms 1800000` to match the 30-min turn budget. The `result.monitor.command` emitted on `task --json` launches already carries the 30-min form. |
| `--json` | Emits a trailing success envelope (see shape below) after streaming lines. |

`--filter` and `--exclude` are mutually exclusive; passing both exits `2 USAGE_ERROR` before any file read. Neither flag is required — without either, every line passes through.

Multi-line block handling: the tag regex `/^\[([^\]]+)\]/` extracts the head tag from a block's first line (`[CHECKPOINT] …`); subsequent indented continuation lines (no bracketed tag) inherit that block's inclusion decision. This ensures an included `[CHECKPOINT]` block ships whole (header + `assistant:`, `tools:`, `diff:` body), and an excluded `[HEARTBEAT]` block is fully elided (not just its header). Pre-1.4.0 continuation lines were dropped independently — a known bug the v1.4.0 predicate fixes.

Without `--follow`, the command dumps existing lines (filtered/excluded) and exits 0. Line stream is verbatim text; `--json` does not convert line format — consumers parse the `[TAG]` prefix themselves or pair with `summary` for structured output.

**Final-envelope shape with `--json --follow` (watcher ran and the stream closed):**

```json
{
  "ok": true,
  "result": {
    "jobId": "task-…",
    "threadId": "019d…",
    "eventsPath": "/abs/path/to/events",
    "followed": true,
    "filter": null,
    "exclude": "HEARTBEAT,CHECKPOINT",
    "timedOut": false,
    "terminalTag": "DONE",
    "terminalLine": "[DONE] 019d… completed in 4s | 1 files | +2 -0",
    "elapsedMs": 3214
  }
}
```

Exactly one of `filter` / `exclude` is non-null per invocation (matches the mutual-exclusion CLI rule). `terminalTag` is one of `DONE` / `ERROR` / `INCOMPLETE` / `PLAN` / `CANCELLED` on happy-path close, or `null` when the stream closed via `--timeout-ms`. `elapsedMs` measures follow duration only (not total job elapsed time). This envelope matches `wait`'s return shape so Monitor / orchestrators can switch on the same fields.

**Early-exit envelope (terminal tag already present in the initial dump, or `--follow` omitted):**

```json
{
  "ok": true,
  "result": {
    "jobId": "task-…",
    "threadId": "019d…",
    "eventsPath": "/abs/path/to/events",
    "followed": false,
    "filter": null,
    "exclude": "HEARTBEAT,CHECKPOINT"
  }
}
```

`result.followed` is the boolean coercion of the `--follow` flag (`Boolean(options.follow)`) — `true` when `--follow` was passed and a terminal tag was already in the initial dump; `false` when `--follow` was omitted entirely. The early-exit branch **omits** `timedOut`, `terminalTag`, `terminalLine`, and `elapsedMs` — the watcher never ran, so there is no follow-duration or terminal-tag capture. Orchestrators that switch on `result.terminalTag` must treat it as absent/`undefined` in this case and re-read the events file (or pair with `summary`) to determine which terminal closed the run.

**Recommended shape:** `--exclude HEARTBEAT,CHECKPOINT`. Every tag the bridge emits passes except the 60-s liveness pulse and verbose checkpoint body; `[CHECKPOINT_SUMMARY]` remains visible for live progress. Future tags reach the orchestrator without a code update. Use `--filter DONE,ERROR,INCOMPLETE,PLAN,CANCELLED` (terminal-only) for narrow sanity-check stream; avoid long inclusion lists — they're brittle across bridge versions.

## setup

Health check: Codex installed, authenticated, app-server available. With `--install-monitor-hook`, mirror the PostToolUse Monitor handoff hook into `~/.claude/settings.json`.

```
codex-bridge setup [--json] [--install-monitor-hook] [--enable-review-gate | --disable-review-gate]
```

## version

Bridge + Codex + Node version, schema version, capability list, active backend, adapter capability map, and cached update status. Use to pin agent behavior to a known build.

```
codex-bridge version [--backend <name>] [--check-update] [--json]
```

| Flag | Description |
|------|-------------|
| `--backend <name>` | Resolve the version capability envelope against this backend instead of env/config defaults. Unknown backends fail with `BACKEND_INCAPABLE`. |
| `--check-update` | Force a fresh GitHub round-trip for the update probe (bypasses the cached result used on plain `version`). |

`--json` includes `result.capabilities` (including `backend-adapter`), `result.active_backend`, and `result.adapter_capabilities`. Backend resolution honors `--backend`, `CODEX_BRIDGE_BACKEND`, cwd `config.yaml`, workspace-root `config.yaml`, then the skill/user config. Consumers should use the adapter capability booleans to decide whether backend-specific features such as auto-pipeline, review, or server-side questions are available.

## update

Check GitHub releases for a newer codex-bridge and print the install recipe. Does **not** self-modify the skill unless `--apply`/`--yes` is passed — plain `update` only prints the printed upgrade command.

```
codex-bridge update [--force] [--apply|--yes] [--json]
```

| Flag | Description |
|------|-------------|
| `--force` | Force a fresh GitHub round-trip instead of the cached update-check result. |
| `--apply` / `--yes` | Execute the printed install command synchronously after confirming an upgrade is available. |

Read-only sibling is `version --check-update`. Set `CODEX_BRIDGE_NO_UPDATE_CHECK=1` to suppress the silent per-launch update probe.

## config

Show effective merged config plus the files each value came from. Use when a config knob seems to have no effect.

```
codex-bridge config show [--json]
```

Only the `show` action is supported today; any other positional exits `2 USAGE_ERROR`. Precedence order (low → high): built-in defaults, `{skill-dir}/config.yaml`, `{workspace-root}/config.yaml`, `{cwd}/config.yaml`. The envelope exposes each layer's path and existence plus the effective merged config so you can tell which file actually owns a given knob.

## await-artifact

Block until `<path>` exists and is stable (size unchanged across consecutive polls), the target job reaches a terminal state, or timeout. Primitive for multi-job orchestration when success means "an artifact exists at a known path".

```
codex-bridge await-artifact <job-id> <path> [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]
```

| Flag | Description |
|------|-------------|
| `--timeout-ms <ms>` | Overall deadline (default 900000 = 15 min). Exit 7 on expiry OR on job-terminal-without-artifact. |
| `--poll-interval-ms <ms>` | Poll cadence (default 2000). |

Both positionals are required — omitting either exits `2 USAGE_ERROR`. Relative paths resolve against `--cwd`. Success payload shape: `{ exists, path, size, terminated, jobStatus, elapsedMs }`.

## auth-status

Thin auth report (no full dependency check). `setup` is the heavyweight equivalent.

```
codex-bridge auth-status [--json]
```

## help

Machine-readable command catalog + exit-code table + global-flag list.

```
codex-bridge help --json
```

## task-resume-candidate

Report the latest resumable task for this Claude session. Useful before issuing `task --resume`.

```
codex-bridge task-resume-candidate [--json]
```
