# src/AGENTS.md

Source for the Node 22+ ESM CLI that Claude invokes through the skill. Root rules live in `/AGENTS.md`; this file covers the top-level `src/` folder and the handler layer in `codex-bridge.mjs` + the standalone broker in `app-server-broker.mjs`. Per-module details for `src/lib/` live in `src/lib/AGENTS.md`.

## Files at this level

| File | Role |
|---|---|
| `codex-bridge.mjs` | Main CLI entry. Parses `process.argv`, dispatches to per-subcommand handlers, runs the **bridge layer** (`runBridgeTask`). Gets bundled into `skill/scripts/codex-bridge.mjs` by `esbuild.config.mjs`. |
| `app-server-broker.mjs` | Standalone socket multiplexer. Not imported; spawned separately by `src/lib/broker-lifecycle.mjs` (`spawn(process.execPath, [scriptPath, "serve", ...])`). |
| `lib/` | Library modules. See `src/lib/AGENTS.md`. |
| `prompts/`, `schemas/`, `templates/` | Authored assets copied into `skill/` by esbuild. |

`src/codex-bridge.mjs` is currently ~1560 lines and growing; keep new logic in `src/lib/*.mjs` and have the handler just orchestrate.

## `codex-bridge.mjs` layout

Three zones, in reading order:

1. **Constants + config lookup (lines ~97-170)**: resolves `ROOT_DIR`, loads developer-instruction templates with `loadDeveloperInstructions(mode)`, caches bridge config via `getBridgeConfig()`.
2. **Per-subcommand handlers (lines ~280-1420)**: each `handle<Name>` parses its args, builds a job record, and calls into `src/lib`. Key handlers: `handleSetup`, `handleTask`, `handleTaskWorker`, `handleSend`, `handleSteer`, `handleRespond`, `handleReview`, `handleReviewCommand("adversarial-review")`, `handleSummary`, `handleStatus`, `handleResult`, `handleCancel`, `handleTaskResumeCandidate`.
3. **Bridge orchestration (`runBridgeTask`, lines ~807-967)**: the integration layer. Merges command request with `config.yaml`, picks plan vs. default mode, registers an `onServerRequest` handler for `requestUserInput`, runs the turn via `executeTaskRun`, then emits `[PLAN]` or invokes `runAutoPipeline`.

### Conventions every handler follows

- Parse args through `parseCommandInput(argv, { valueOptions, booleanOptions, aliasMap })` — a wrapper over `src/lib/args.mjs` that adds the `-C` → `cwd` alias and handles single-string arg forms. Never call `parseArgs` directly from a handler.
- Resolve directory via `resolveCommandCwd(options)` (for Codex spawn env + git) and `resolveCommandWorkspace(options)` (for state, jobs). `cwd` and `workspaceRoot` are **not interchangeable** — see root `AGENTS.md` rule 3.
- Build a job record with `createCompanionJob({ prefix, kind, ... })` so `status`/`result`/`cancel` subcommands can find it later.
- Route output through `outputCommandResult(payload, rendered, options.json)` so `--json` is always honored.
- Never `console.log` raw — use `outputResult` / `outputCommandResult` / `process.stdout.write` consistently.

### Adding a new subcommand

1. Add the handler `async function handle<Name>(argv)` in the handler zone.
2. Register it in the `switch` inside `main()` (bottom of the file).
3. Extend `printUsage()`.
4. Add scenarios in `test-gherkin/07-cli-commands.feature`.
5. Update `skill/references/command-reference.md`.

### Modes, sandbox, and developer instructions

From `src/lib/config.mjs`:

| Mode | `sandboxPolicy` | `reasoning_effort` | Developer instructions file |
|---|---|---|---|
| `plan` | `{ type: "readOnly" }` | `xhigh` (forced) | `src/templates/plan-enforcement.md` |
| `default` (execute) | `{ type: "workspaceWrite" }` | `config.effort` (default `high`) | `src/templates/execute-instructions.md` |

`runBridgeTask` (line ~820) selects `isPlanMode = config.mode === "plan" && !request.resumeLast`. A resumed task never re-enters plan mode. Plan-mode turn timeout is 5 min; default is 10 min; idle timeout is 120 s for both.

### How questions flow through `runBridgeTask`

Codex can emit `item/tool/requestUserInput` — a server-to-client **request** (not a notification) with a JSON-RPC id. `runBridgeTask` registers `onServerRequest` (line ~852) which:

1. Persists the pending request via `writePendingRequest(sessionDir, threadId, entry)` to `{threadId}.pending.json` (see `src/lib/pending-requests.mjs`).
2. Writes `[QUESTION]` to `.events`.
3. Polls `waitForResponse(sessionDir, threadId, 300_000)` for the response file written by the `respond` CLI.
4. When the response arrives, delivers it on the **same** RPC connection via `message._client?.sendMessage?.({ id: message.id, result: response.payload })`.
5. On timeout, delivers `{ answers: {} }` so the server doesn't hang.

This worker/respond split is necessary because `respond` is a separate CLI invocation; the worker process holds the open RPC connection.

**Codex may also ask questions in plain assistant text instead of using the tool.** In that case, no `[QUESTION]` notification is emitted; use `send <thread-id> "<answer>"`. The skill doc (`skill/SKILL.md`) calls this out — keep both paths working.

## `app-server-broker.mjs`

A standalone JSON-RPC multiplexer that accepts multiple client sockets, forwards their requests to a **single** `CodexAppServerClient` connected in direct mode (`disableBroker: true`), and enforces "one active turn" semantics across clients.

Critical behaviors:

- **Streaming methods** (`turn/start`, `review/start`, `thread/compact/start`, line 12) take exclusive ownership of the notification fan-out until `turn/completed` for the matching `threadId`. Other sockets attempting non-interrupt requests get `BROKER_BUSY_RPC_CODE` (`-32001`, the Codex convention for "busy, retry later").
- **`turn/interrupt` is an exception** (lines 170-195) — it's allowed while another socket's stream is active, so clients can cancel somebody else's in-flight turn.
- **`initialize`** returns `{ userAgent: "codex-companion-broker" }` (line 149) — the broker does its own handshake with the upstream server on startup.
- **`broker/shutdown`** cleanly closes sockets, calls `appClient.close()`, removes the unix socket file and PID file, then `process.exit(0)`.
- Framing is **newline-delimited JSON** on a unix socket (or Windows named pipe via `parseBrokerEndpoint`). Bad JSON → `-32700 Parse error`.
- Notifications from the upstream server are fanned out through `routeNotification` to whichever socket owns the current request or stream. If neither, the notification is dropped — this matches "dropped" semantics in the upstream reference client's bounded-channel design.

### Invariants for editing `app-server-broker.mjs`

- `STREAMING_METHODS` is the single source of truth for which methods take exclusive ownership. If the upstream spec adds a new streaming method (`compaction/start` variants, etc.), add it here and to the Gherkin spec.
- Never remove the `allowInterruptDuringActiveStream` carve-out — it's the only way to cancel a hung turn from a sibling client.
- `activeStreamThreadIds` is a `Set`, not a single id, because `review/start` with `delivery: "detached"` introduces a new `reviewThreadId` (see `src/lib/AGENTS.md` for the upstream test invariant).
- The broker is spawned detached with its own log/PID files (see `src/lib/broker-lifecycle.mjs`). `shutdown()` must remove both; orphan files cause "broker already running" false positives on next spawn.

## Unverified / known gaps

- The broker has no retry logic for upstream `-32001` from the Codex app-server itself — it relays the error unchanged. If the upstream introduces server-side backoff we should handle it here, not in each client.
- There is no per-request timeout at the broker layer. A slow Codex turn can hold exclusive ownership indefinitely; sibling clients get `busy` responses forever until the streaming caller times out themselves. Document-only issue for now.
