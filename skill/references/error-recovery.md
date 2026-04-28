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
- `UNKNOWN_SUBCOMMAND` — usage, exit 2. Typo at the subcommand slot. Human-readable error + suggestion go to stderr; pass `--json` to receive the structured envelope. Agents should fall back to `help --json` to enumerate valid subcommands.

## Error taxonomy — Codex-emitted vs bridge-synthesized

Two sources of typed errors flow into `error.code`:

### Codex-emitted (`codexErrorInfo`)

Variants Codex itself attaches to failed turns; mapped 1:1 in `CODEX_ERROR_INFO` (`src/lib/cli-errors.mjs`):

| `codexErrorInfo` | Class | `$?` |
|---|---|---|
| `Unauthorized` | auth | 4 |
| `ContextWindowExceeded` | validation | 6 |
| `BadRequest` | validation | 6 |
| `SandboxError` | conflict | 5 |
| `UsageLimitExceeded` | rate_limit | 7 |
| `HttpConnectionFailed` | network | 7 |
| `ResponseStreamConnectionFailed`, `ResponseStreamDisconnected` | network | 7 |
| `InternalServerError` | dependency_failed | 7 |
| `ResponseTooManyFailedAttempts` | internal | 1 |

`ActiveTurnNotSteerable`, `Other`, and any unrecognized variant fall through to the default classification (internal, exit 1).

### Bridge-synthesized (from message shape)

Codes the bridge attaches when a failure's `codexErrorInfo` is missing or too generic; each is matched by a string probe in `classifyError` (`src/lib/cli-errors.mjs`) and carries an explicit retryable flag:

| `error.code` | Class | `$?` | Retryable? | Trigger |
|---|---|---|---|---|
| `ClientTimeout` | timeout | 7 | yes | Idle watchdog expired (synthesized in `classifyError` for messages matching `/No events received for \d+s/`, see `src/lib/cli-errors.mjs:170-180`). Pipeline timeouts also surface here via the `origin:` line. Question-answer timeouts log `QUESTION_TIMEOUT` and reply to the pending server request with `result: { answers: {} }` (empty-answer success — `src/codex-bridge.mjs:2197`); the turn continues from there as if the user had returned no answers. **Note:** the per-turn budget rejection from `runAppServerTurn` (`Turn timed out after <ms>ms`, `src/lib/codex.mjs:1172`) currently falls through to the generic classifier — there is no dedicated `TurnTimeout` code on this branch. If `error.code` is missing for a per-turn-budget failure, check the `origin:` line in the `[ERROR]` block. |
| `ProcessDeath` | dependency_failed | 7 | yes | Codex app-server process exited before `turn/completed`. The classifier marks this retryable unconditionally — re-run after `setup` confirms Codex is reachable. |
| `UPSTREAM_STREAM_DISCONNECTED` | network | 7 | yes | Transport drop: websocket close / ECONNRESET / socket hang up. Auto-retried by the `upstream:transport` policy before surfacing |
| `PreviousResponseNotFound` | dependency_failed | 7 | yes, **by new task only** | Upstream 400 `previous_response_not_found` — the `previous_response_id` is dead. `send` on the same thread repeats the 400 forever |
| `UpstreamUnauthorized` | auth | 4 | no | Upstream 401 from Codex's auth layer or a proxy in front of it. Reauth the right layer; retry accomplishes nothing |
| `UpstreamInvalidRequest` | validation | 6 | yes (auto) | Upstream 400 `invalid_request_error` not covered by `PreviousResponseNotFound`. Auto-retried 3× with backoff before handoff |

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
| `QUESTION_TIMEOUT` ndjson entry (`question_answer_ms`, default 5 min). The bridge logs the timeout and replies to the upstream server request with `result: { answers: {} }` — an empty-answer success response, not a rejection (`src/codex-bridge.mjs:2197`). | Human/orchestrator didn't answer `requestUserInput` in time. | If the answer was slow rather than missing, re-run with `--question-timeout-ms 1800000` |

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

### response-chain-lost {#response-chain-lost}

Upstream 400 `previous_response_not_found` — the response chain bound to the `previous_response_id` was invalidated server-side (compaction, session expiry, or a proxy-layer eviction). Same-thread `send` will repeat the 400 forever against the dead resp_id; the only viable recovery is a fresh task seeded from committed state.

- **Do not** `send` on the same thread. It will fail the same way on every retry.
- **Audit what survived** before relaunching: `git log --oneline <launch-iso>..HEAD` — the bridge also emits a `[PARTIAL]` block listing commit shas that landed during the failed turn (v1.5.0+), and the JSON envelope carries the same under `error.partial.commits`.
- **Relaunch as a fresh task:**
  ```bash
  node <bridge> task --json --mode default --prompt-file <rebased-prompt>
  ```
  The rebased prompt should seed Codex with "last good commit is `<sha>`, here's what's left to do" so it does not re-do the work already committed.
- **Bridge retry policy:** `strategy: new-thread`, `maxAttempts: 1` — the bridge does not auto-spin a new thread (that would require an automated prompt rebase, which is unsafe). It goes straight to `[HANDOFF] reason=upstream-retry-exhausted`.

### upstream-auth-401 {#upstream-auth-401}

Upstream 401 Unauthorized, either from Codex's auth layer or a proxy in front of it (e.g. a Railway gateway with proxy-auth misconfigured). The error message carries the raw "`unexpected status 401 Unauthorized: …`" text. Auth is deterministic; retrying with the same credentials changes nothing.

- **Reauth the right layer:**
  - If the message mentions "Proxy authentication must be configured", reauth the proxy (talk to whoever owns the gateway).
  - Otherwise: `codex login` (or `codex login --device-auth`).
- **Do not** retry the same thread. The bridge's retry policy is `strategy: none` — the `[ERROR]` block is preceded by `[HANDOFF] reason=upstream-auth-requires-reauth` immediately.
- **Use the `upstream_request_id`** (v1.5.0+) field surfaced in the `[ERROR]` / `[HANDOFF]` block when escalating to a proxy owner — it's the correlation handle.

### upstream-invalid-request {#upstream-invalid-request}

Upstream 400 `invalid_request_error` not covered by the more specific `response-chain-lost` matcher. Some proxy-layer 400s are transient — a budget reset, a short-lived config flap — so the bridge retries on the same thread with backoff before surfacing the error.

- **Automatic retry:** `strategy: same-thread`, `maxAttempts: 3`, `backoffMs: [2000, 5000, 12000]` — you'll see `[RETRYING]` blocks before the final `[ERROR]`.
- **On retry exhaustion:** the `[HANDOFF]` block names `reason=upstream-retry-exhausted`. Inspect `error.message` for the specific validation reason; rebuild the prompt to satisfy it; relaunch as a fresh task.

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

## Upstream retry policy (v1.5.0)

Before surfacing an `upstream:*` failure, the bridge runs a per-origin retry loop from `UPSTREAM_RETRY_POLICY` (`src/lib/cli-errors.mjs`):

| Origin | Strategy | Max attempts | Backoff (ms) |
|---|---|---|---|
| `upstream:transport` | same-thread | 3 | `[2000, 5000, 12000]` |
| `upstream:compact-proxy` | same-thread | 2 | `[10000, 30000]` |
| `upstream:invalid-request` | same-thread | 3 | `[2000, 5000, 12000]` |
| `upstream:response-chain-lost` | new-thread | 1 | (requires prompt rebase; bridge goes straight to `[HANDOFF]`) |
| `upstream:auth` | none | 0 | `[]` (skipped; `[HANDOFF]` preceded by `reason=upstream-auth-requires-reauth`) |

During retry, each attempt emits a non-terminal `[RETRYING] attempt n/max | origin=… | backoff=…ms` block so `events --follow` readers can tell a slow turn apart from a stalled one. On exhaustion (or for `strategy: none`), a `[HANDOFF]` block lands immediately before the terminal `[ERROR]`.

## Envelope shapes

Every `--json` success and every CLI-boundary failure returns a uniform envelope (`src/lib/cli-errors.mjs` → `emitSuccess`, `buildErrorEnvelope`):

**Success** (schema_version 1.0):

```json
{
  "ok": true,
  "schema_version": "1.0",
  "command": "task",
  "result": { /* per-subcommand shape */ },
  "meta": { "duration_ms": 3214 }
}
```

**Failure** (same schema_version; `error.class` maps 1:1 to exit code):

```json
{
  "ok": false,
  "schema_version": "1.0",
  "command": "task",
  "error": {
    "class": "timeout",
    "code": "ClientTimeout",
    "message": "No events received for 300s",
    "retryable": true,
    "retry_after": 0,
    "suggestion": "Re-run with `--idle-timeout-ms 900000`."
  }
}
```

Notes: `retryAfter` inside the code is serialized as `retry_after` (snake_case) at the JSON boundary — agents switching on the field name must read `retry_after`. `error.class` is one of `usage | not_found | auth | conflict | validation | rate_limit | timeout | network | dependency_failed | internal | partial_success`; the exit-code table at the top of this doc lists the mapping.

### `[HANDOFF]` envelope

When the upstream-retry loop gives up (or the origin has `strategy: none`), the bridge emits a `[HANDOFF]` block ahead of `[ERROR]` and attaches a handoff payload to the error envelope under `error.handoff` (`buildHandoffEnvelope` in `src/lib/cli-errors.mjs`):

```json
{
  "ok": false,
  "error": {
    "class": "dependency_failed",
    "code": "PreviousResponseNotFound",
    "handoff": {
      "schema_version": "1.0",
      "reason": "upstream-retry-exhausted",   // or upstream-auth-requires-reauth / upstream-no-retry-policy
      "origin": "upstream:response-chain-lost",
      "errorCode": "PreviousResponseNotFound",
      "errorMessage": "…",
      "upstream_request_id": "e42f5508-…",
      "session": { "jobId": "task-abc", "threadId": "019d…", "sessionId": "019d…" },
      "artifacts": { "eventsPath": "…", "workerErrPath": "…", "diffPath": "…", "planPath": "…", "reviewPath": "…" },
      "partial": { "commits": ["abc","def"], "currentHeadSha": "…", "lastOkHeadSha": "…", "dirtyFiles": [], "launchedAtIso": "…" },
      "prompt": { "original": "…", "promptFilePath": "…", "resumeSuggestion": "…" },
      "retries": [{ "attemptIso": "…", "origin": "…", "errorCode": "…", "backoffMs": 2000, "outcome": "failed" }]
    }
  }
}
```

`upstream_request_id` is present only when the upstream error message contained a `request id: <hex>` correlation handle (extracted loosely by `extractUpstreamRequestId` — regex `/request id:\s*([0-9a-f-]{8,})/i`, not UUID-strict). If missing, escalate to a proxy owner with the `threadId` and the full error message instead.

## Decision Tree

v1.5.0 surfaces richer origin/partial/handoff fields; branch on `origin:` first, then `error.code`.

```
[ERROR] received
  │
  ├── [PARTIAL] precedes?            → real work survived; inspect commits=[…] before deciding
  ├── [HANDOFF] precedes?            → read error.handoff in the JSON envelope; follow orchestration-flows.md#recovering-from-upstream-state-loss
  │
  ├── origin: upstream:response-chain-lost → new task from last commit; see #response-chain-lost
  ├── origin: upstream:auth                → reauth (codex/proxy); see #upstream-auth-401
  ├── origin: upstream:invalid-request     → bridge auto-retried; rebuild prompt & relaunch; see #upstream-invalid-request
  ├── origin: upstream:transport           → same-thread retry (already attempted by bridge); see #upstream-transport-drop
  ├── origin: upstream:compact-proxy       → narrow prompt; see #compact-proxy-502
  ├── origin: idle                         → raise --idle-timeout-ms; see #idle-timeout
  ├── origin: pipeline:<stage>             → raise --pipeline-stage-timeout-ms (or --no-pipeline)
                                              (* emitted by auto-pipeline.mjs, not classifyTurnErrorOrigin)
  ├── origin: bridge                       → bridge safety net tripped; see #unhandledexit
                                              (* emitted by both the stall detector and the
                                                 finally-backstop in codex-bridge.mjs (NOT by
                                                 classifyTurnErrorOrigin); distinguish sub-cases by
                                                 error.code: `StallDetected` (barren-checkpoint
                                                 threshold) vs `UnhandledExit` (turn exited past
                                                 every instrumented branch — file an issue))
  │
  ├── origin: turn + error.code (Codex-emitted variant):
  │     ├── ContextWindowExceeded     → new task, shorter prompt; see #context-window-exceeded
  │     ├── Unauthorized              → setup, re-auth; see #unauthorized
  │     ├── UsageLimitExceeded        → wait, retry
  │     └── SandboxError              → sync envelope carries phase: workspace-dirty; see #sandbox-denial
  │
  ├── error.code (bridge-synthesized, regardless of origin):
  │     ├── ClientTimeout             → QUESTION_TIMEOUT / raise --turn-default-ms / --idle-timeout-ms (branches by origin:)
  │     └── ProcessDeath              → verify codex install, rerun `setup`
  │
  └── genuinely unclassified (last leaf) → read result log, capture repro, file issue
```

## Timeout Values

Every budget is configurable. Resolution order for each: CLI flag → `config.yaml` key → built-in default. Malformed values throw usage (exit 2) rather than silent fallback.

| Phase | Default | Config key | CLI flag |
|-------|---------|------------|----------|
| Plan turn | 30 min (1 800 000 ms, raised from 5 min in 1.3.0) | `turn_plan_ms` | `--turn-plan-ms` |
| Execution turn | 30 min (1 800 000 ms, raised from 10 min in 1.3.0) | `turn_default_ms` | `--turn-default-ms` |
| Question unanswered (replies with empty-answer success — see `src/codex-bridge.mjs:2197`) | 5 min | `question_answer_ms` | `--question-timeout-ms` |
| Auto-pipeline per-stage (review / fix / check) | 5 min | `pipeline_stage_ms` | `--pipeline-stage-timeout-ms` |
| Auto-pipeline total | 15 min | `pipeline_total_ms` | `--pipeline-total-timeout-ms` |
| No-event idle (per-turn) | 5 min (300 000 ms) | `idle_timeout_ms` | `--idle-timeout-ms` |

A timeout fires a timeout-class error to the events file as `[ERROR] {threadId} failed | ClientTimeout` for idle/pipeline timers or `TurnTimeout` for the per-turn budget. The rendered message uses seconds/minutes (`Xs` under 60 s, `Xm` for whole minutes, `XmYYs` for mixed — e.g. `auto-review exceeded 5m`, `auto-fix exceeded 7m30s`). The underlying `TimeoutError` instance preserves the raw `timeoutMs` integer as a field — machine consumers should read `.timeoutMs` rather than parse the string. Every `[ERROR]` block also carries an `origin:` line (`turn` or `pipeline:<stage>`); pipeline-origin timeouts may coexist with a success envelope whose `phase: "incomplete"`.

## `UnhandledExit` — the finally-backstop marker (1.3.0)

If an events file ends with `[ERROR] … | UnhandledExit` plus `origin: bridge`, the bridge's top-level `finally` block synthesized it after noticing the turn exited without any explicit branch emitting a terminal tag. That's an **observability bug, not a task bug** — some error path (new or pre-existing) escaped the instrumented branches. Callers should:

1. **Not retry the same prompt** under the assumption the task failed — the task state is whatever it was; the `[ERROR]` marker is synthesized, not causal.
2. **File an issue** with the jobId, the full events file, and (if present) the contents of `~/.codex-bridge/crashes/`.
3. **Separately act on the underlying task state** (run `result <jobId>` and inspect the diff — Codex may have completed most of the work before the bridge exit happened).

The marker's whole point is that it's *itself* the bug report: silence is impossible, so every failure path is diagnosable.

## `[HEARTBEAT]` — liveness pulse (1.3.0, non-terminal)

Non-terminal tag emitted every ~60 s during any running turn. Each block carries elapsed time, current phase, last item type, pid, turn-budget remaining, and a ready-to-paste re-attach command. Monitor's default filter **excludes** `HEARTBEAT` to keep pure-liveness pulses out of LLM context — agents that specifically want liveness opt in by dropping the default exclude. If `[HEARTBEAT]` lines stop arriving for more than ~90 s (raw tail on the `.events` file, since Monitor doesn't surface them), the bridge wrapper process is not alive — check `kill -0 <pid>` on the heartbeat's pid, or `pgrep -f codex-bridge`. A stale heartbeat pid with no process is the fastest way to confirm a silent crash.
