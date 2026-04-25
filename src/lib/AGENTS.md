# src/lib/AGENTS.md

Library modules that the CLI handlers in `src/codex-bridge.mjs` compose into the bridge behavior. This file is the deepest technical reference in the repo: per-module contracts, protocol invariants, and the "must-not-regress" list derived from the upstream Codex app-server spec and test suite.

> Root rules (build workflow, env vars, `workspaceRoot` vs `cwd`) live in `/AGENTS.md`. Don't restate them here.

## Module map (22 files)

| File | One-sentence role | Cluster |
|---|---|---|
| `app-server-protocol.d.ts` | JSDoc-consumable type shims for the upstream JSON-RPC contract. | Protocol |
| `app-server.mjs` | Low-level JSON-RPC client: spawn-or-connect, framing, request/notification dispatch. | Protocol |
| `codex.mjs` | High-level turn/review orchestration; state-machine capture of streaming notifications. | Protocol |
| `broker-endpoint.mjs` | Parse/create broker endpoint URIs (`unix:/path` or `pipe:name`). | Broker |
| `broker-lifecycle.mjs` | Spawn, wait-for-ready, and tear down the shared broker session. | Broker |
| `state.mjs` | Per-workspace job registry + config store (`state.json` + `jobs/*.json`). | State |
| `session-log.mjs` | Append-only writers for `.events`, `.ndjson`, `.diff`, `.plan.md`, `.review.json`; all event-format helpers; git-snapshot + diff helpers used by `[PARTIAL]`. | State |
| `pending-requests.mjs` | File-based IPC for `requestUserInput` across worker and `respond` CLI. | State |
| `tracked-jobs.mjs` | Job-record factories, progress reporter, `runTrackedJob` wrapper; `job.retries[]` history. | State |
| `job-control.mjs` | Read-side job queries: snapshots, enrichment, phase inference for `status`/`result`/`cancel`. | State |
| `config.mjs` | Load `skill/config.yaml`, `buildCollaborationMode`, `buildSandboxPolicy`, `COMPLETION_CHECK_SCHEMA`. | Config |
| `prompts.mjs` | `loadPromptTemplate` + `interpolateTemplate` for `{{UPPERCASE}}` placeholder substitution. | Config |
| `cli-errors.mjs` | Exit codes, `CliError`, `classifyError` (tier-1 `codexErrorInfo` + tier-2 string matchers), `classifyTurnErrorOrigin`, `buildErrorEnvelope`, `buildHandoffEnvelope`, `UPSTREAM_RETRY_POLICY`, `extractUpstreamRequestId`, `emitSuccess` / `emitError`. | Errors |
| `thread-id.mjs` | Thread-id shape validation + normalization (reject malformed UUIDs before the Codex call). | Errors |
| `update-check.mjs` | Anonymous GitHub Releases probe, 1 h cache, silent hot-path auto-apply via `npx skills add …`. | Lifecycle |
| `render.mjs` | Markdown renderers for every CLI output (review, task, status, cancel, setup). | Render |
| `fs.mjs` | `readJsonFile`/`writeJsonFile`, `isProbablyText`, `readStdinIfPiped`. | Utility |
| `process.mjs` | `runCommand`, `binaryAvailable`, `terminateProcessTree` (cross-platform). | Utility |
| `git.mjs` | Git repo validation, review target resolution, diff context collection. | Utility |
| `workspace.mjs` | Tiny wrapper: git repo root or cwd fallback. | Utility |
| `args.mjs` | Shell-aware CLI argument parser used by all handlers. | Utility |
| `auto-pipeline.mjs` | Silent post-execution pipeline: diff → review → fix → completion check. | Orchestration |

---

## Protocol cluster

These three modules are the ground truth for how `codex-bridge` talks to the Codex app-server. Everything they do is constrained by the upstream spec at `codex-rs/app-server/README.md` and enforced by tests at `codex-rs/app-server/tests/suite/v2/*`.

### `app-server.mjs`

**Exports**: `CodexAppServerClient` (with static `connect(cwd, options)`), `BROKER_ENDPOINT_ENV`, `BROKER_BUSY_RPC_CODE`.

**Transport**: dual. `CodexAppServerClient.connect(cwd, { disableBroker })` either:
1. Connects to an existing broker socket via `net.createConnection({ path })` when `CODEX_COMPANION_APP_SERVER_ENDPOINT` is set and the endpoint is alive.
2. Otherwise `spawn("codex", ["app-server"], { cwd, env })` and talks over stdio. On Windows, spawned with `shell: true` to survive cmd.exe wrapping.

**Framing**: newline-delimited JSON (NDJSON) on both transports. Line buffer is `this.lineBuffer`; lines are split on `\n` and JSON-parsed. Matches upstream wire format for stdio transport.

**Identity** (lines 22-38):
```js
DEFAULT_CLIENT_INFO = { title: "Codex Bridge", name: "codex_bridge", version: "1.0.0" };
DEFAULT_CAPABILITIES = {
  experimentalApi: true,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};
```

**Load-bearing details**:
- `DEFAULT_CLIENT_INFO.name = "codex_bridge"` is echoed by the upstream server as the HTTP `originator` header on every `/v1/responses` call (upstream test: `initialize.rs::turn_start_sends_originator_header`). ASCII only; no CR/LF/colons.
- Delta opt-outs reduce chatter; `item/completed` is still the authoritative event for every item (upstream invariant: deltas are advisory).
- `experimentalApi: true` is required for `item/tool/requestUserInput`, `item/plan/delta`, `collaborationMode/list`, and other experimental methods we use.

**ID allocation**: monotonic `this.nextId++` (line 88). Never reused across requests. Pending map is `Map<id, {resolve, reject}>`.

**Notification handler**: `setNotificationHandler(fn)` — single handler, called with each parsed notification. Callers in `codex.mjs` demultiplex by `method`.

**Server-request handling**: `onServerRequest` callback receives `{ id, method, params, _client }`. The caller must either call `_client.sendMessage({ id, result })` or `_client.sendMessage({ id, error })`. If neither happens, the upstream server's pending-requests map leaks. Our `runBridgeTask` wires this to the disk-IPC protocol in `pending-requests.mjs`.

**Close semantics**: `close()` sends shutdown (if broker), closes the socket, 50 ms grace, then `terminateProcessTree` the spawned child. Rust reference client uses 5 s; we're tighter because we control both ends and don't need to drain WS close frames.

### `codex.mjs` — the turn captor

**Exports**: `runAppServerTurn`, `runAppServerReview`, `withAppServer`, `interruptAppServerTurn`, `findLatestTaskThread`, `getCodexAuthStatus`, `getCodexAvailability`, `getSessionRuntimeStatus`, `parseStructuredOutput`, `readOutputSchema`, `buildPersistentTaskThreadName`, `DEFAULT_CONTINUE_PROMPT`.

**The turn state machine** (`captureTurn`, lines ~380-620): this is the heart of the module. It subscribes to the notification stream from `app-server.mjs`, demultiplexes by thread/turn id, and resolves a single `TurnCaptureState` when the turn is "done".

**TurnCaptureState fields that matter** (typedef at lines 9-35):
- `threadIds: Set<string>` — every thread seen during the turn (root + subagents). A notification for an unregistered thread is buffered until its `threadId` is known.
- `rootThreadId` — the originally-requested thread; this is what handlers resume from.
- `turnId` — the id of the root turn. Echoed verbatim by the server; we don't allocate it.
- `pendingCollaborations: Set<string>` — collaboration tool calls (subagent spawns) tracked by `item.id`.
- `activeSubagentTurns: Set<string>` — non-root threads currently running; turn is not "done" until this drains.
- `finalAnswerSeen: boolean` — set when an `item/completed` with `type: "agentMessage"` arrives on the root thread.
- `completionTimer` — 250 ms grace timer that fires when `finalAnswerSeen && activeSubagentTurns.size === 0`. Resolves the turn after drain.

**Why the 250 ms grace**: the upstream server sometimes emits the root `agentMessage` completion before the trailing `turn/completed` for a recently finished subagent. Without the grace period, we'd close the stream too early and miss a final `item/fileChange` update. Do not remove or shorten this without verifying against `codex-rs/app-server/tests/suite/v2/turn_start.rs`.

**Idle timeout**: `setInterval` every `Math.min(5000, idleTimeoutMs)` ms checks that events are still arriving. Default 5 min (`config.idle_timeout_ms = 300_000`). Expiring calls `onIdleTimeout` and fails the turn with `ClientTimeout`. Matches our need to cut hung turns; upstream has no equivalent — we add it because network stalls are user-visible.

**Turn timeout**: caller-supplied `turnTimeoutMs` — default 30 min for both plan (`turn_plan_ms`) and default (`turn_default_ms`). Pre-v1.3.0 these were 5 min / 10 min and routinely killed legitimate long turns mid-task; both were raised to 30 min and made configurable in `DEFAULT_CONFIG`. Pipeline has its own budgets (`pipeline_total_ms` default 15 min total, `pipeline_stage_ms` default 5 min per stage). Enforced via `Promise.race` with a reject.

**Interrupt**: `interruptAppServerTurn(cwd, { threadId, turnId })` calls `turn/interrupt` on a fresh broker connection (**not** reusing the streaming one, which is busy). Response is `{}` — the turn isn't actually done until a `turn/completed` arrives with `status: "interrupted"`. The caller must still drain the active capture; we don't short-circuit.

**Upstream test invariants enforced by `captureTurn`**:
1. `serverRequest/resolved` must arrive **before** `turn/completed` for any outstanding server request. We record resolutions in the state machine and use them to clear `pendingCollaborations`.
2. `item/completed` is authoritative; deltas are not. `finalAnswerSeen` is only set on `item/completed`, never on an `agentMessage/delta`.
3. Detached review introduces a new `reviewThreadId` via `thread/started`. We register it in `threadIds` on the fly and do not confuse it with `thread/status/changed`.
4. Plan item id is `"{turn.id}-plan"`. We don't mint this; we read it from `item.id` and trust the server.

### `app-server-protocol.d.ts`

JSDoc-only. Re-exports narrowed types from the upstream-generated bindings. Omits `persistExtendedHistory` (lines 45-46) because that's an internal server concern.

**Regenerate via**: `codex app-server generate-ts --experimental --out <dir>` in a scratch directory, then diff against this file. Anything the upstream added that we don't use can stay omitted; anything we use must be present.

---

## Protocol invariants our code must preserve

Derived from `codex-rs/app-server/README.md`, `codex-rs/app-server-protocol/src/protocol/common.rs`, `codex-rs/app-server/src/error_code.rs`, and the `codex-rs/app-server/tests/suite/v2/*` test fixtures.

### Handshake

1. **`initialize` is the first request on every connection.** Wait for the response before sending anything else. A second `initialize` returns `"Already initialized"`; anything before it returns `"Not initialized"`.
2. **Send the `initialized` notification after the `initialize` response.** Our client does this automatically in `AppServerClientBase`.
3. **`ClientInfo.name` is an HTTP header value.** ASCII, no CR/LF/colons. Upstream test `initialize.rs::initialize_rejects_invalid_client_name` returns `-32600` with the exact message `"Invalid clientInfo.name: '<name>'. Must be a valid HTTP header value."`
4. **`optOutNotificationMethods` is exact-match on method strings.** No wildcards; unknowns are accepted and silently ignored.

### Wire format

5. **Omit `"jsonrpc":"2.0"`.** Explicit in the upstream README. Parsers that require it will break.
6. **NDJSON on stdio.** Newline-delimited, one JSON object per line. Our `lineBuffer` approach is correct.
7. **`thread.name: null` must be present in `thread/start` params**, not omitted. Upstream test asserts strict serialization.

### Turn ordering

8. **`item/started` → zero or more deltas → `item/completed`** for every item. Never treat a delta as terminal state.
9. **`turn/started` → item events → `turn/completed`** for every turn. `turn/completed.status ∈ { completed, failed, interrupted }`.
10. **`serverRequest/resolved` MUST precede `turn/completed`** when a server request was outstanding. Tested in `request_user_input.rs` and `request_permissions.rs`. Our state machine upholds this by not resolving `captureTurn` until all pending collaborations clear.
11. **Turn-level `outputSchema` is per-turn.** Unset on the next turn removes `text.format` from the upstream Responses body. Don't cache at thread level.

### Interrupt and steer

12. **`turn/interrupt` is async.** The `{}` response means "request accepted"; wait for `turn/completed` with `status: "interrupted"` before reconciling state.
13. **Interrupt implicitly resolves pending approvals.** `serverRequest/resolved` fires for each outstanding approval with the original `request_id` before the interrupted `turn/completed`.
14. **`turn/steer` needs an active, steerable turn.** Review turns and manual-compact turns reject with `-32600` and emit analytics `rejection_reason: "no_active_turn"`. Steer returns `{turn_id}` equal to the active turn id; it does NOT create a new turn.
15. **`turn/steer` rejects turn-level overrides.** Only `input` is accepted.

### Review

16. **`delivery: "inline"` reuses the current thread** (`review_thread_id == thread_id`). **`delivery: "detached"` creates a new thread** introduced by `thread/started` (never preceded by `thread/status/changed` for that id). Our state machine registers the new id in `threadIds` on arrival.
17. **Review findings ship inside `ThreadItem::ExitedReviewMode.review`** as plain text, not a separate message field.

### Error codes (`error_code.rs`)

| Code | Constant | Meaning | Retry? |
|---|---|---|---|
| `-32600` | `INVALID_REQUEST_ERROR_CODE` | Malformed request, steer on inactive turn, invalid client name. | No |
| `-32602` | `INVALID_PARAMS_ERROR_CODE` | Bad params. Oversized input carries `data.{input_error_code, max_chars, actual_chars}`. | No |
| `-32603` | `INTERNAL_ERROR_CODE` | Server-side bug. | No |
| `-32001` | `OVERLOADED_ERROR_CODE` (`BROKER_BUSY_RPC_CODE`) | Busy / queue full. **Retry with exponential backoff + jitter.** | Yes |
| `"input_too_large"` | `INPUT_TOO_LARGE_ERROR_CODE` | String constant, not numeric. Surfaces in `data.input_error_code`. | No |

`codexErrorInfo` on `turn/completed.turn.error` — variants: `ContextWindowExceeded`, `UsageLimitExceeded`, `HttpConnectionFailed`, `ResponseStreamConnectionFailed`, `ResponseStreamDisconnected`, `ResponseTooManyFailedAttempts`, `ActiveTurnNotSteerable { turnKind }`, `BadRequest`, `Unauthorized`, `SandboxError`, `InternalServerError`, `Other`. Our renderer inspects these; new variants should be added to `render.mjs` too.

### Sandbox policy (upstream camelCase)

| Our JS | Upstream type name | When emitted |
|---|---|---|
| `{ type: "readOnly" }` | `SandboxPolicy::ReadOnly` | plan-mode fallback when `config.sandbox_policy` is unset or set to an unknown value; `sandbox_policy: "read-only"` |
| `{ type: "workspaceWrite" }` | `SandboxPolicy::WorkspaceWrite { writableRoots, networkAccess }` | default-mode + `--write`; `sandbox_policy: "workspace-write"` |
| `{ type: "dangerFullAccess" }` | `SandboxPolicy::DangerFullAccess` | `sandbox_policy: "danger-full-access"` (the shipped default). See `config.mjs::buildSandboxPolicy`. |
| n/a | `SandboxPolicy::ExternalSandbox { networkAccess }` | never emitted |

`dangerFullAccess` is the **shipped default** as of v1.2.0. Earlier revisions of this doc said "we do not use dangerFullAccess"; that was true until the default was flipped to unblock `.git/` writes (the user's direct instruction, and the fix for the reported `osascript` / `display dialog` derailment when Codex hit sandbox errors mid-turn). Users opt into `workspace-write` or `read-only` via `config.yaml` for stricter profiles. We still do not emit `externalSandbox`; adding it would require UX for the elevated trust prompt — upstream silently persists `trust_level="trusted"` in `~/.codex/config.toml` when a workspace is trusted via elevated sandbox (tested in `thread_start.rs::thread_start_with_elevated_sandbox_*`).

### Notifications in the `ServerNotification` enum (from `protocol/common.rs`)

Thread-scoped: `thread/started`, `thread/status/changed`, `thread/archived`, `thread/unarchived`, `thread/closed`, `thread/name/updated`, `thread/tokenUsage/updated`, `thread/compacted`.

Turn-scoped: `turn/started`, `turn/completed`, `turn/diff/updated`, `turn/plan/updated`.

Item lifecycle (always on): `item/started`, `item/completed`.

Item-specific streaming (opt-outable): `item/agentMessage/delta`, `item/plan/delta`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress`, `rawResponseItem/completed`.

Ancillary: `error`, `serverRequest/resolved`, `model/rerouted`, `hook/started`, `hook/completed`, `deprecationNotice`, `configWarning`.

Unstable (shape may change): `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`. Do **not** persist these in our own schemas.

### Server-initiated requests (`ServerRequest` enum)

| Method | Params | How we handle it |
|---|---|---|
| `item/tool/requestUserInput` | `{ threadId, turnId, itemId, questions }` (experimental) | `pending-requests.mjs` disk-IPC → `respond` CLI writes answer. |
| `command/exec/requestApproval` | `{ threadId, turnId, itemId, command, ... }` | Currently not explicitly supported in UI; relies on Codex's own approval policy. |
| `file/change/requestApproval` | `{ threadId, turnId, itemId, changes, ... }` | Same. |
| `permissions/requestApproval` | `{ threadId, turnId, itemId, reason, permissions }` | Same. |
| `chatgpt/auth/tokensRefresh` | n/a | Upstream auto-rejects in in-process clients with `-32000`; our stdio client shouldn't see it. |

If we ever need to auto-reject, use `-32601 Method not found` or `-32001 Busy`, matching the reference client's behavior.

---

## Broker cluster

### `broker-endpoint.mjs`

Pure string parsing. `createBrokerEndpoint(sessionDir)` returns `"unix:/path"` on POSIX or `"pipe:name"` on Windows. `parseBrokerEndpoint(endpoint)` returns `{ kind: "unix" | "pipe", path }`. Pipe names are sanitized to `[A-Za-z0-9._-]`.

### `broker-lifecycle.mjs`

`ensureBrokerSession(cwd)` is the idempotent entry point every client takes:
1. Read `broker.json` from the state dir.
2. If an endpoint exists and responds within 150 ms, reuse it.
3. Otherwise tear down any stale session, create a fresh temp dir, spawn `node src/app-server-broker.mjs serve --endpoint <new>`, poll for readiness up to a timeout, write a new `broker.json`.
4. Return `{ endpoint, pidFile, logFile }`.

**Spawn is detached + unref'd** (`detached: true`, `unref()`) so Node's CLI process can exit while the broker keeps running. Log goes to a file descriptor (`stdio: ['ignore', logFd, logFd]`) — never to our stdout.

**Teardown is best-effort**. Missing files and stale PIDs are silently ignored. Never make teardown throw.

**Ready poll**: 50 ms interval. `[unverified]` why 50 ms specifically — matches a perceived "felt-fast" threshold; changing it trades startup latency against wasted syscalls.

---

## State cluster

### `state.mjs`

**State root**: `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/` where `<slug>` is the workspace basename and `<hash>` is the first 16 hex chars of `sha256(realpath(workspaceRoot))`. The `realpathSync.native` call is load-bearing — it stabilizes the hash across symlinked checkouts so two worktrees of the same repo share state.

Fallback root: `os.tmpdir()/codex-companion/` when `CLAUDE_PLUGIN_DATA` isn't set.

**Files**:
- `state.json` — canonical. `{ version: 1, config: {...}, jobs: [{id, status, ...}, ...] }`.
- `jobs/{jobId}.json` — detailed per-job payload (request, logFile path, threadId, turnId, phase, progress, errors).

**Invariants**:
- `MAX_JOBS = 50`. Oldest job files are deleted when pruned from `state.jobs`. Never bypass `saveState`.
- Job index (`state.json`) and detail files (`jobs/*.json`) are **dual-written** by `tracked-jobs.mjs`. Writes happen in the order `writeJobFile` → `upsertJob` so that the fast index never references a missing detail file.

### `session-log.mjs`

**Session artifacts per thread** in `$session_dir` (default `~/.codex-bridge/sessions`):

| File | Purpose | Writer |
|---|---|---|
| `{threadId}.ndjson` | Full structured log (`{ts, tag, method, threadId, data}` per line). | `logNdjson` via `appendFileSync`. |
| `{threadId}.events` | Human-readable tagged log. Full tag vocabulary below. | `logEvent` via `appendFileSync`. |
| `{threadId}.diff` | `git diff HEAD` snapshot. | `captureGitDiff` — one shot, 10 s timeout. |
| `{threadId}.plan.md` | Full plan text when plan mode produces one. | `writePlan`. |
| `{threadId}.review.json` | Adversarial review JSON when pipeline review runs. | `writeReview`. |

**Full `[*]` tag vocabulary (as of v1.5.0):**

| Tag | Terminal? | Emitted by |
|---|---|---|
| `[PLAN]` | no (non-terminal; precedes user approval) | `formatPlanEvent` |
| `[DONE]` | **yes** | `formatDoneEvent` |
| `[INCOMPLETE]` | **yes** | `formatIncompleteEvent` |
| `[ERROR]` | **yes** | `formatErrorEvent` (may include optional `upstream_request_id:` line) |
| `[QUESTION]` | no | `formatQuestionEvent` |
| `[CONFIRMED]` | no | `formatConfirmedEvent` |
| `[PIPELINE:<stage>]` / `[PIPELINE:<stage>:done]` / `[PIPELINE:done\|failed]` | no (stage); terminal for the pipeline grouping | `formatPipelineEvent` |
| `[HEARTBEAT]` (v1.3) | no | `formatHeartbeatEvent` — every 60 s |
| `[CHECKPOINT]` (v1.3) | no | `formatCheckpointEvent` — every 5 min with tool-call list |
| `[WARNING]` (v1.2) | no | `formatWarningEvent` — circuit breaker on repeated command-family failures |
| `[DIRECTIVES]` | no | `formatDirectivesEvent` — `skip_meta_skills` preamble echo |
| `[PARTIAL]` (v1.5) | no — precedes `[ERROR]` on error paths with commits-landed | `formatPartialEvent` |
| `[RETRYING]` (v1.5) | no | `formatRetryingEvent` |
| `[HANDOFF]` (v1.5) | no — precedes terminal `[ERROR]` when `UPSTREAM_RETRY_POLICY` budget exhausts | `formatHandoffEvent` |

The terminal-tag regex lives at `TERMINAL_TAG_REGEX = /^\[(DONE|ERROR|INCOMPLETE)\]/m`. Monitor self-terminates only on those three; `[HANDOFF]` pairs with `[ERROR]` rather than replacing it.

`DEFAULT_MONITOR_EXCLUDE = ["HEARTBEAT"]` is the v1.4.0 default (exclusion-based; future tags pass through). See `skill/references/monitor-patterns.md` and `skill/references/notification-format.md` for the full wire format.

**Append-only rule**: `appendFileSync` is the only writer. Never add async writers to `.events` or `.ndjson` — lines will interleave.

**Format helpers** — `formatDoneEvent`, `formatErrorEvent` (accepts optional `upstreamRequestId`), `formatIncompleteEvent`, `formatQuestionEvent`, `formatPlanEvent`, `formatConfirmedEvent`, `formatPipelineEvent`, `formatHeartbeatEvent`, `formatCheckpointEvent`, `formatWarningEvent`, `formatDirectivesEvent`, `formatPartialEvent`, `formatRetryingEvent`, `formatHandoffEvent`, `formatPhaseEvent`, `formatReviewEvent`. Each returns a formatted string block. Changing any format requires syncing `skill/references/notification-format.md` AND the scenarios under `gherkin-tests-v2/06-artifacts/` plus any `05-ambiguities/` entry that asserts on dual-channel event+envelope behavior. Note: `formatPhaseEvent` and `formatReviewEvent` are defined but have no call sites — the `[PHASE]` and `[REVIEW]` tags never emit in the live build; see `gherkin-tests-v2/06-artifacts/03-review-json-is-phantom-file.md`.

**Git-snapshot helpers (v1.5.0)** — `captureGitSnapshot(cwd)` returns `{headSha, porcelain, isoTimestamp}` via `spawnSync` with 10 s timeouts; `diffGitSnapshot(cwd, snapshot)` returns `{commits, currentHeadSha, lastOkHeadSha, dirtyFiles, launchedAtIso}`. `runBridgeTask` takes a snapshot at entry and diffs on any terminal error path — the diff feeds `formatPartialEvent` and the `handoff.partial` field.

### `pending-requests.mjs`

Disk-IPC. One `{threadId}.pending.json` file at a time per thread; `writeResponseFile` creates `{threadId}.response.json`; `waitForResponse` polls at 500 ms intervals with a 5-minute default timeout. The worker process holding the RPC connection is the sole writer of `.pending.json`; the `respond` CLI is the sole writer of `.response.json`. Consumed-on-read: the response file is deleted after being read.

### `tracked-jobs.mjs`

`runTrackedJob(job, runner, { logFile })` wraps a runner with:
- queued → running → (completed | failed) transitions.
- Progress updater (`createJobProgressUpdater`) that de-duplicates `{phase, threadId, turnId}` changes so we don't thrash state.json.
- Dual-write to `jobs/{id}.json` and `state.jobs`.
- Error capture (caught exceptions set `errorMessage` and status `failed`).

`createProgressReporter({ stderr, logFile, onEvent })` is the object passed as `onProgress` into `runAppServerTurn`. Anything it receives gets mirrored to the job log file, the state update, and optionally stderr for interactive use.

`SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID"` is attached to every new job record. `job-control.mjs` filters by it so `/codex:status` only shows the current Claude session's jobs.

### `job-control.mjs`

Read-side. `buildStatusSnapshot(cwd, { all })` returns the sorted, enriched job list; `buildSingleJobSnapshot(cwd, reference)` resolves a job by id or the keyword `latest`. Enrichment adds `kindLabel`, `progressPreview` (tail of log), `elapsed`, `duration`. `inferLegacyJobPhase` parses log lines for keywords (`"starting codex"`, `"running command:"`) to back-fill `phase` when the job wasn't tagged explicitly.

`resolveCancelableJob` refuses jobs already in a terminal state (`completed|failed|cancelled`) — cancel is idempotent only in the sense that a completed job stays completed.

---

## Config / template cluster

### `config.mjs`

`DEFAULT_CONFIG` (see `src/lib/config.mjs` for the fully commented source of truth). Summary of keys:

- Runtime: `mode: "plan"`, `model: "gpt-5.4"`, `effort: "xhigh"`.
- Pipeline: `auto_review: true`, `post_task_prompt: <multi-line completion-check prompt>`.
- Questions: `allow_questions: true`, `question_answer_ms: 300_000`.
- Sandbox + directives (v1.2.0): `sandbox_policy: "danger-full-access"`, `skip_meta_skills: true`, `command_failure_circuit_breaker: true`.
- Timeouts (v1.2.4 / v1.2.5 / v1.3.0): `idle_timeout_ms: 300_000`, `turn_plan_ms: 1_800_000`, `turn_default_ms: 1_800_000`, `pipeline_stage_ms: 300_000`, `pipeline_total_ms: 900_000`.
- Paths + prompt: `session_dir: "~/.codex-bridge/sessions"`, `prompt_footer: <requestUserInput directive>`.

**Plan mode forces effort `xhigh`** in `buildCollaborationMode("plan", ...)`. **Sandbox is independent of mode** — `buildSandboxPolicy(mode, config)` checks `config.sandbox_policy` first and returns the override-derived type (`danger-full-access` → `dangerFullAccess`, `workspace-write` → `workspaceWrite`, `read-only` → `readOnly`) regardless of mode. Only when `config.sandbox_policy` is unset (or set to an unknown value) does the function fall back to mode-derived defaults: plan → `readOnly`, default → `workspaceWrite`. With the shipped `sandbox_policy: "danger-full-access"` ship default, every turn (plan or default) gets `dangerFullAccess`; plan mode is a *reasoning* constraint, not a sandbox one. Earlier revisions of this doc claimed plan turns were read-only "by contract" — that was true under the pre-1.2.0 default of `workspace-write`, but the ship default flip in 1.2.0 inverted the situation.

`COMPLETION_CHECK_SCHEMA` requires `{complete, missing_items, summary}`. Used by `auto-pipeline.mjs` as the `outputSchema` of the final completion turn.

### `prompts.mjs`

`interpolateTemplate(template, vars)` replaces `{{UPPERCASE_KEY}}` with `vars[KEY]` or empty string. No escaping, no validation that all placeholders are provided — missing keys silently become `""`. When adding a new placeholder to a prompt, grep for every `interpolateTemplate` call to ensure callers pass the new key.

---

## Render cluster

### `render.mjs`

Pure formatting. Review findings are sorted `critical → high → medium → low`. Review JSON is validated against the expected shape (see `src/schemas/AGENTS.md`); parse errors render a fallback error section with the raw output included.

`renderSetupReport`, `renderStatusReport`, `renderCancelReport`, `renderJobStatusReport`, `renderTaskResult`, `renderStoredJobResult`, `renderReviewResult`, `renderNativeReviewResult` — each returns a complete markdown string. Handlers pick json vs. rendered via `outputCommandResult(payload, rendered, options.json)`.

Updating an event tag's displayed form (e.g., adding a field to `[DONE]`) requires changes to the format helper in `session-log.mjs`, the Gherkin scenarios, and the reference docs — not just this file.

---

## Utility cluster

### `fs.mjs`

`readStdinIfPiped()` only reads when `!process.stdin.isTTY`. This avoids blocking on interactive terminals. `isProbablyText` scans the first 4096 bytes for null bytes.

### `process.mjs`

`runCommand(cmd, args, opts)` never throws; `runCommandChecked` throws on non-zero exit. `terminateProcessTree(pid)` uses `taskkill /T /F` on Windows, `kill(-pid, SIGTERM)` (process group) on POSIX; both fall through to `process.kill(pid)` if the group approach fails. `ESRCH` is always tolerated.

### `git.mjs`

`collectReviewContext(cwd, target)` sizes git output and downgrades to summary-only if the inline diff exceeds `maxInlineDiffBytes`. Default branch detection tries `main`, `master`, `trunk` in that order. Untracked files are inlined when `isProbablyText && size < 24 KB`.

Every git spawn has a 10 s timeout. Long operations return empty stdout; callers treat as "no content" rather than failing.

### `workspace.mjs`

One-liner: returns the git repo root if inside a repo, otherwise cwd. Used for state hashing so that CLI invocations from subdirectories of a repo all map to the same state dir.

### `args.mjs`

Shell-aware token splitter (`splitRawArgumentString`) handles single/double quotes and backslash escapes. `parseArgs(argv, spec)` supports `valueOptions`, `booleanOptions`, `aliasMap`, and `--` stop-parsing. No dependency on a third-party argparser.

---

## Orchestration cluster

### `auto-pipeline.mjs`

Runs silently after execute-mode turns. Stages:
1. **diff** — `captureGitDiff`.
2. **review** (if `config.auto_review`) — `runAppServerReview({ target: { type: "uncommittedChanges" } })`. On fixable findings, proceeds to fix.
3. **fix** (if structured findings present) — new turn with a synthesized prompt from the findings. Uses `execute-instructions.md`. Never applied to native-reviewer output (which is plain text, no findings structure).
4. **check** (if `config.post_task_prompt`) — final turn with `COMPLETION_CHECK_SCHEMA` as output schema. Produces `{complete, missing_items, summary}` → maps to `[DONE]` or `[INCOMPLETE]`.

Timeouts: `PIPELINE_TIMEOUT_MS_DEFAULT = 15 min` total, `STAGE_TIMEOUT_MS_DEFAULT = 5 min` per stage — both overridable per-invocation via `pipeline_total_ms` / `pipeline_stage_ms` in config or `--pipeline-*-ms` flags on `task`. Enforced via `withTimeout(promise, ms, stageLabel)`. Timeouts throw `PipelineTimeoutError(completedStages)`; the caller logs an `[ERROR]` with a list of what completed before the stall. Pipeline-stage errors do **not** enter the `UPSTREAM_RETRY_POLICY` loop (only turn-level upstream errors do).

`withTimeout` is exported because `runBridgeTask` uses it for the plan-mode/default-mode turn itself.

---

## Errors cluster

### `cli-errors.mjs`

Central classification + envelope builder. Three responsibilities:

1. **`classifyError(err)`** — two tiers in strict order:
   - **Tier 1** — `codexErrorInfo` enum match (upstream variants listed in the Error Codes section above).
   - **Tier 2** — string matchers for raw upstream HTTP errors that arrive without `codexErrorInfo` (added v1.5.0). Order is load-bearing: `previous_response_not_found` MUST match before `invalid_request_error` (both look like 400s; the chain-lost case needs a new-thread strategy, not a retry):
     - `/previous_response_not_found|previous_response_id/i` → `PreviousResponseNotFound` (`dependency_failed`, exit 7, retryable via new-thread).
     - `/\b401\b.*Unauthorized|Proxy authentication must be configured/i` → `UpstreamUnauthorized` (`auth`, exit 4, non-retryable).
     - `/invalid_request_error/i` → `UpstreamInvalidRequest` (`validation`, exit 6, retryable same-thread).
   - Fallback → generic `internal` (exit 1).

2. **`classifyTurnErrorOrigin(error)`** — returns the `origin:` string attached to `[ERROR]` blocks and action-block `see:` anchors. Recognized origins: `idle`, `turn`, `bridge:*`, `pipeline:*`, `upstream:transport`, `upstream:compact-proxy`, `upstream:invalid-request`, `upstream:response-chain-lost`, `upstream:auth`. The `upstream:response-chain-lost` matcher must sit **above** the generic `turn` fallback and **above** `upstream:invalid-request` for the same shadowing reason as tier-2 classify.

3. **Envelope builders**:
   - `buildErrorEnvelope(classified, { command, partial, handoff })` — the `ok:false` JSON envelope. Parses `upstream_request_id` out of the message via `extractUpstreamRequestId` and attaches it as `error.upstream_request_id`. Threads `partial` and `handoff` through when present.
   - `buildHandoffEnvelope({ classified, reason, session, artifacts, partial, prompt, retries, upstreamRequestId })` — the v1.5.0 handoff shape (`schema_version: "1.0"`). Emitted alongside `[HANDOFF]` when `UPSTREAM_RETRY_POLICY` exhausts or when the policy is `none` (e.g. auth). Carries everything another agent needs: session/thread ids, full artifact paths (`.events`, `.worker.err`, `.diff`, `.plan.md`, `.review.json`), the original prompt, the partial-commit snapshot, the retry history.

**`UPSTREAM_RETRY_POLICY`** (v1.5.0, frozen). Keyed by origin:

| Origin | Strategy | Attempts | Backoff (ms) |
|---|---|---|---|
| `upstream:transport` | `same-thread` | 3 | 2000, 5000, 12000 |
| `upstream:compact-proxy` | `same-thread` | 2 | 10000, 30000 |
| `upstream:invalid-request` | `same-thread` | 3 | 2000, 5000, 12000 |
| `upstream:response-chain-lost` | `new-thread` | 1 | 0 |
| `upstream:auth` | `none` | 0 | — |

`runBridgeTask` in `src/codex-bridge.mjs` wraps `executeTaskRun` in a while-loop: on any `upstream:*` origin it looks up the policy, emits `[RETRYING] attempt n/m | origin=… | backoff=…ms`, sleeps, then re-invokes for `same-thread`. `new-thread` + `none` break out immediately and fall through to the handoff emission. Retries append to `job.retries[]` in `tracked-jobs.mjs`. The policy table is hard-coded — **no `config.yaml` knobs this cycle**; revisit only if a real user reports the defaults are wrong.

### `thread-id.mjs`

Thread-id shape validation. Before any `send` / `steer` / `events` / `wait` call that takes a thread id, the handler calls `validateThreadId(value, source)` to reject obviously-malformed inputs (wrong length, non-hex chars) with a `usage` error (exit 2) before spending a broker request. Also the source of the `019d…` prefix convention used in progress messages.

### `update-check.mjs`

Anonymous GitHub Releases probe with a 1 h on-disk cache. Public-repo only (v1.2.8 stripped the gh-CLI fallback + token reading). Used for:

1. `version --check-update` / `update` subcommands — surfaces `{latest_version, has_update, checked_at_age_ms}` in the envelope.
2. **Silent hot-path auto-apply** (v1.2.9) — `maybeTriggerAutoApply` on every non-`--json` non-`update` invocation spawns `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y` detached, fire-and-forget, with stdout/stderr routed to `~/.codex-bridge/auto-update.log`. Rate-limited to once per hour per workspace via the same cache. Opt-out: `CODEX_BRIDGE_NO_UPDATE_CHECK=1`.

---

## Invariants for anyone editing `src/lib/`

1. **Never rename `DEFAULT_CLIENT_INFO.name`.** It's the upstream `originator` header.
2. **Never change the wire framing from NDJSON.** Both ends expect newline-delimited JSON on stdio.
3. **Never add async writers to `.events` or `.ndjson`.** Append ordering is our only consistency guarantee.
4. **Never bypass `saveState`.** Job list pruning deletes orphaned detail files — manual writes will leak disk.
5. **Never cache `outputSchema` at thread level.** It's per-turn upstream.
6. **Never treat `turn/interrupt`'s `{}` as "turn done".** Wait for `turn/completed { status: "interrupted" }`.
7. **Never emit a client-originated `turn/completed`.** Only the upstream server does; the bridge reads it.
8. **Never persist `item/autoApprovalReview/*` fields** — upstream marks them unstable.
9. **Never call `saveJobFile` without also calling `upsertJob`** (or vice versa). Dual-write is the contract.
10. **Never delete `session-log`'s `appendFileSync` fallbacks**: logging failures are swallowed on purpose so they don't kill the running task.
11. **Never change `realpathSync.native` to `realpathSync`** in `state.mjs`. The `.native` variant is stable across edge cases on macOS APFS.
12. **Never drop `-32001` handling.** Retry with backoff; don't surface it as a user error.
13. **Never set `experimentalApi: false`** without first removing every experimental method call (`collaborationMode/list`, `item/tool/requestUserInput`, `item/plan/delta`).
14. **Never steer a review turn or a manual-compact turn.** Upstream rejects with `-32600`; we should pre-empt.
15. **Never terminate a spawned Codex process with `SIGKILL` before the 50 ms grace.** On POSIX, give it a SIGTERM first so upstream can flush its own state.

---

## Where this cluster diverges from the upstream Rust reference client

The reference client (`codex-rs/app-server-client`) is an `enum { InProcess, Remote }` over `tokio_tungstenite`. Our JS client targets stdio only (plus our own unix-socket broker). Differences that agents should know:

| Aspect | Rust reference | Our JS |
|---|---|---|
| Transport abstraction | Enum sum type; no trait | Single class, transport chosen at connect time |
| JSON serialization in-process | Skipped (typed channels) | N/A — we don't embed the server |
| Event queue | Bounded `mpsc`, surfaces `Lagged { skipped }` | Unbounded — **drift risk**, document |
| Per-request timeout | None built-in | We layer turn/idle timeouts at the captor |
| Retry on `-32001` | None built-in; caller implements | Same; callers (auto-pipeline) don't currently retry |
| Shutdown timeout | 5 s | 50 ms (we own the process) |
| Connect timeout | 10 s | Broker: 50 ms poll × N; direct spawn: immediate |
| Initialize timeout | 10 s | None explicit |
| Server-request auto-reject on queue full | `-32001` | Not implemented — we rely on unbounded buffering |

If upstream publishes the client as a crate and we start consuming it via a shim, the translation table above becomes the porting spec.

## Unknowns

- The numeric value of `DEFAULT_IN_PROCESS_CHANNEL_CAPACITY` in the Rust crate (re-exported but not defined there). Doesn't affect us while we're stdio-only.
- Full `thread/resume` replay semantics when reconnecting mid-turn — upstream README is silent; test coverage in `thread_resume.rs` is the best source, and even that was summarized (not fully verbatim) during discovery.
- Whether `item/reasoning/*` deltas have a guaranteed order vs. the matching `item/completed`. Our state machine doesn't rely on an order, so this is tolerated.
