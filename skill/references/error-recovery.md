# Error Recovery

Codex-bridge maps every failure to a semantic exit code and a structured error envelope so an agent can branch on `$?` before parsing stdout.

## Environment gotchas

- **Claude Code + Xcode `build.db` I/O errors.** When running `xcodebuild` from inside a Claude Code session on macOS, the sandbox around DerivedData intermittently returns `disk I/O error` on the build database. The workaround is to put DerivedData **outside** the workspace: `xcodebuild -derivedDataPath /tmp/<project>-dd …`. Never use the default workspace-side `DerivedData/` from inside Claude Code. Not a codex-bridge issue; hits every macOS user of the skill eventually.
- **XcodeGen / protoc / prisma / other generator outputs are not deterministic across re-runs.** If your verification step re-runs the generator and then compares diffs, you'll see phantom "pipeline rewrote my files" warnings that are actually just generator ordering noise. See orchestration-flows.md → "Post-[DONE] checklist" item 4.

## Exit Code → Action

| `$?` | Class | Retry? | Agent action |
|---|---|---|---|
| 2 | `usage` | No | Fix the command (unknown flag, missing positional, unknown subcommand). |
| 3 | `not_found` | No | The job/thread/resource doesn't exist. Re-check the id. |
| 4 | `auth` | No | Run `codex login`, then retry. |
| 5 | `conflict` | No | State mismatch (already running, mutually exclusive flags). Inspect `status`. |
| 6 | `validation` | No | Bad input (unsupported effort, empty prompt, context too large). Fix input. |
| 7 | `rate_limit` / `timeout` / `network` / `dependency_failed` | **Depends** | `rate_limit` / `timeout` / `network`: retry with backoff. `dependency_failed`: inspect `error.code` and `error.retryable` — some variants (e.g. `CODEX_UNAVAILABLE`, `GIT_NOT_INSTALLED`) are not retryable. |
| 1 | `internal` | Maybe | Crash / uncategorized. Escalate. |

### CLI-boundary codes introduced in the current build

- `INVALID_THREAD_ID` — validation, exit 6. `send`/`steer` rejected a non-UUID thread id. Suggestion points at the canonical UUID v7 shape (`019d9a86-1c8a-7f41-8032-6c76bbe730a1`); no `thr_` prefix.
- `WAIT_TIMEOUT` — timeout, exit 7. `wait` exceeded `--timeout-ms` with no terminal tag. `retryable: true` — agents may re-dispatch after checking `status <id>`.
- `REVIEW_EMPTY_DIFF` — validation, exit 6. `review --scope working-tree` (or `--scope auto` resolving there) against a clean tree and index. No billed Codex turn is spent; make a change and retry.
- `UNKNOWN_SUBCOMMAND` — usage, exit 2. Typo at the subcommand slot. The envelope is emitted even without `--json`; agents should fall back to `help --json` to enumerate valid subcommands.

## Codex `codexErrorInfo` → Exit Code

Task or review Codex turns may fail with a typed error from Codex itself. The bridge translates:

| `codexErrorInfo` | Class | `$?` |
|---|---|---|
| `Unauthorized` | auth | 4 |
| `ContextWindowExceeded` | validation | 6 |
| `BadRequest` | validation | 6 |
| `SandboxError` | conflict | 5 |
| `UsageLimitExceeded` | rate_limit | 7 |
| `HttpConnectionFailed` | network | 7 |
| `ResponseStreamConnectionFailed`, `ResponseStreamDisconnected` | network | 7 |
| `ClientTimeout` (transport went silent) | timeout | 7 |
| `ProcessDeath` (Codex app-server exited) | dependency_failed | 7 |
| `InternalServerError` | dependency_failed | 7 |
| `ResponseTooManyFailedAttempts` | internal | 1 |
| `ActiveTurnNotSteerable`, `Other` (fall-through) | internal | 1 |

## Error Types and What to Do

### ContextWindowExceeded
The conversation exceeded the model's context limit.
- **Do:** Start a new task with a shorter prompt, or fork the thread.
- **Do not:** Retry with the same prompt.

### UsageLimitExceeded
OpenAI rate limit or quota hit.
- **Do:** Wait and retry. Check `account rate-limits` for reset timing.

### HttpConnectionFailed / ResponseStreamDisconnected
Network issue between Codex and OpenAI.
- **Do:** Retry once. If persistent, check network connectivity.

### ResponseTooManyFailedAttempts
App-server exhausted its own retries — classified as `internal` / exit 1 because retrying would hit the same wall.
- **Do:** Read the result log for details. Do not retry the same prompt; try a different approach or a fresh thread.

### Unauthorized
Authentication failed.
- **Do:** Run `setup` command. Re-authenticate with `codex login`.

### ClientTimeout {#clienttimeout}

A client-side timeout fired. The canonical `origin:` vocabulary actually emitted by the bridge (v1.4.1):

| Origin (from `[ERROR]` line) | What timed out | First-response action |
|---|---|---|
| `origin: idle` | No-event idle watchdog (`idle_timeout_ms` / `--idle-timeout-ms`, default 300 s). See [#idle-timeout](#idle-timeout). | Re-run with `--idle-timeout-ms 900000` if the task is reasoning-heavy; otherwise suspect real stall → `cancel <id>` |
| `origin: turn` + message mentions "turn exceeded" | Per-turn ceiling (`turn_plan_ms` / `turn_default_ms`). | Re-run with a larger `--turn-default-ms` (e.g. `1800000` for large scaffolds) |
| `origin: pipeline:<lastCompleted>` + `failing_stage: review` / `fix` / `check` | Per-stage pipeline timeout (`pipeline_stage_ms`, default 5 min). See [#pipeline-stage-timeout](#pipeline-stage-timeout). | Re-run with larger `--pipeline-stage-timeout-ms`, or `--no-pipeline` if you want to own completion checking |
| `origin: pipeline:<lastCompleted>` + `failing_stage: pipeline-total` | Total pipeline budget (`pipeline_total_ms`, default 15 min). | Re-run with larger `--pipeline-total-timeout-ms`, or `--no-pipeline` |
| `QUESTION_TIMEOUT` ndjson entry (`question_answer_ms`, default 5 min). Note: this does **not** emit its own `[ERROR]` event today — the bridge auto-answers `{answers:{}}` and the turn continues. | Human/orchestrator didn't answer `requestUserInput` in time. | If the answer was slow rather than missing, re-run with `--question-timeout-ms 1800000` |

Before v1.4.1, every timeout branch collapsed to `origin: turn` with recovery tables that string-matched on the message. The vocabulary above is the emitted truth — reader code can branch on the `origin:` / `failing_stage:` fields directly.

### idle-timeout {#idle-timeout}

Idle watchdog fired — no events arrived from Codex for the configured idle window. Upstream may be genuinely silent mid-turn (some tool executions don't emit intermediate notifications), so the first move is to raise the budget before assuming a stall.

- **Re-run:** `task --idle-timeout-ms 900000 --turn-default-ms 3600000 "<same prompt>"`.
- **If it recurs at the same elapsed time every run:** upstream is genuinely stuck; `cancel <id>` and shape the prompt differently.
- **If workspace has partial work:** inspect with `result <jobId>` and `diff` artifact before re-running; the idle watchdog does not roll back anything.

### compact-proxy-502 {#compact-proxy-502}

The remote compact endpoint (`/backend-api/codex/responses/compact`) returned 502 "Proxy request budget exhausted" mid-turn. Typical trigger: a reading-heavy prompt forced mid-turn context compaction and the proxy ran out of budget. The workspace is unchanged; the turn is dead.

- **Narrow required-reads** in the prompt — fewer files, fewer `Read` calls in the instruction.
- **Split the task** into two smaller turns so the first doesn't force compaction.
- **Resume:** `send <threadId> "<shorter follow-up>"` continues in the same thread.
- The full error-text heuristic: `"Error running remote compact task"` / `"Proxy request budget exhausted"` / the compact URL — any one alone is sufficient to classify.

### upstream-transport-drop {#upstream-transport-drop}

The upstream WS/stream disconnected before `turn/completed` — WebSocket closed without a close frame, `ECONNRESET`, `ETIMEDOUT`, or similar. Workspace is unchanged; prior reasoning is lost but safe to retry.

- **Retry:** `send <threadId> "<same prompt>"` — the same thread is fine, the turn just never closed cleanly.
- **If recurring across retries:** likely a network / proxy issue between your host and OpenAI. Check `curl` to the upstream from the same host before blaming the bridge.

### pipeline-stage-timeout {#pipeline-stage-timeout}

An auto-pipeline sub-stage (review / fix / check) exceeded its per-stage budget. The main turn may already have succeeded — the pipeline runs **after** Codex reports the turn complete. `origin: pipeline:<lastCompleted>` names the last stage that finished; `failing_stage: <actualStage>` (v1.4.1+) names the one that actually stalled.

- **Inspect:** `result <jobId>` — the main task's diff and `[DONE]` may already be in place.
- **Rerun review only:** `review --scope working-tree` skips the full task and just re-runs the reviewer.
- **If review is always slow:** raise `--pipeline-stage-timeout-ms 600000` or disable with `--no-pipeline`.

### unauthorized {#unauthorized}

See the [Unauthorized](#unauthorized) section below. First move: `codex login`, then retry.

### context-window-exceeded {#context-window-exceeded}

Conversation exceeded the model's context window. Do **not** retry the same turn — the window is full. Start a new `task` with a shorter prompt; fork the thread if you need continuity.

### sandbox-denial {#sandbox-denial}

Codex's execute turn produced a diff but the sandbox blocked the commit (e.g. `workspace-write` refuses `.git/` writes). The sync envelope typically lands as `ok:true result.phase: "workspace-dirty"` rather than an `[ERROR]` — the diff is intact. Commit on Codex's behalf, or switch `config.sandbox_policy: "danger-full-access"` (the shipped default post-1.2.0).

### bridge-unhandled-exit {#bridge-unhandled-exit}

The bridge's finally-backstop fired — some error path escaped every instrumented branch. Treat as a bridge bug report. See the "UnhandledExit" section below for the full triage.

### ProcessDeath
Codex app-server process exited unexpectedly.
- **Do:** Check if Codex is installed. Run `setup` to verify.

## Decision Tree

```
[ERROR] received
  │
  ├── ContextWindowExceeded → new task, shorter prompt
  ├── Unauthorized → setup, re-auth
  ├── UsageLimitExceeded → wait, retry
  ├── ClientTimeout → branch by origin: line
  │     ├── origin: turn (idle)        → raise --idle-timeout-ms
  │     ├── origin: turn (turn-budget) → raise --turn-default-ms
  │     ├── origin: pipeline:<stage>   → raise --pipeline-stage-timeout-ms (or --no-pipeline)
  │     └── QUESTION_TIMEOUT (ndjson)  → raise --question-timeout-ms
  ├── ProcessDeath → verify installation, restart
  └── Other → read result log, assess
```

## Timeout Values

Every budget is configurable. Resolution order for each: CLI flag → `config.yaml` key → built-in default. Malformed values throw usage (exit 2) rather than silent fallback.

| Phase | Default | Config key | CLI flag |
|-------|---------|------------|----------|
| Plan turn | 15 min (900 000 ms, raised from 5 min in 1.3.0) | `turn_plan_ms` | `--turn-plan-ms` |
| Execution turn | 30 min (1 800 000 ms, raised from 10 min in 1.3.0) | `turn_default_ms` | `--turn-default-ms` |
| Question unanswered (auto-answers with `{answers: {}}`) | 5 min | `question_answer_ms` | `--question-timeout-ms` |
| Auto-pipeline per-stage (review / fix / check) | 5 min | `pipeline_stage_ms` | `--pipeline-stage-timeout-ms` |
| Auto-pipeline total | 15 min | `pipeline_total_ms` | `--pipeline-total-timeout-ms` |
| No-event idle (per-turn) | 5 min (300 000 ms) | `idle_timeout_ms` | `--idle-timeout-ms` |

A timeout fires a `ClientTimeout` error to the events file as `[ERROR] {threadId} failed | ClientTimeout`. The rendered message uses seconds/minutes (`Xs` under 60 s, `Xm` for whole minutes, `XmYYs` for mixed — e.g. `auto-review exceeded 5m`, `auto-fix exceeded 7m30s`). The underlying `TimeoutError` instance preserves the raw `timeoutMs` integer as a field — machine consumers should read `.timeoutMs` rather than parse the string. Every `[ERROR]` block also carries an `origin:` line (`turn` or `pipeline:<stage>`); pipeline-origin timeouts may coexist with a success envelope whose `phase: "incomplete"`.

## `UnhandledExit` — the finally-backstop marker (1.3.0)

If an events file ends with `[ERROR] … | UnhandledExit` plus `origin: bridge`, the bridge's top-level `finally` block synthesized it after noticing the turn exited without any explicit branch emitting a terminal tag. That's an **observability bug, not a task bug** — some error path (new or pre-existing) escaped the instrumented branches. Callers should:

1. **Not retry the same prompt** under the assumption the task failed — the task state is whatever it was; the `[ERROR]` marker is synthesized, not causal.
2. **File an issue** with the jobId, the full events file, and (if present) the contents of `~/.codex-bridge/crashes/`.
3. **Separately act on the underlying task state** (run `result <jobId>` and inspect the diff — Codex may have completed most of the work before the bridge exit happened).

The marker's whole point is that it's *itself* the bug report: silence is impossible, so every failure path is diagnosable.

## `[HEARTBEAT]` — liveness pulse (1.3.0, non-terminal)

Non-terminal tag emitted every ~60 s during any running turn. Each block carries elapsed time, current phase, last item type, pid, turn-budget remaining, and a ready-to-paste re-attach command. Monitor's default filter **excludes** `HEARTBEAT` to keep pure-liveness pulses out of LLM context — agents that specifically want liveness opt in by dropping the default exclude. If `[HEARTBEAT]` lines stop arriving for more than ~90 s (raw tail on the `.events` file, since Monitor doesn't surface them), the bridge wrapper process is not alive — check `kill -0 <pid>` on the heartbeat's pid, or `pgrep -f codex-bridge`. A stale heartbeat pid with no process is the fastest way to confirm a silent crash.
