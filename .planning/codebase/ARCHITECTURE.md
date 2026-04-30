---
last_mapped_commit: 16f4fd188f47160bdaddabb9813c6fe67e486d5d
mapped_date: 2026-04-30
evidence_boundary: Repository Markdown files were not read or used as evidence for this map.
---

<!-- refreshed: 2026-04-30 -->
# Architecture

**Analysis Date:** 2026-04-30

## System Overview

```text
+-------------------------------------------------------------+
|                    Distribution Surfaces                     |
| .claude-plugin/plugin.json | skill/ | plugin/ | hooks/       |
+----------------------------+---------+---------+-------------+
                             |
                             v
+-------------------------------------------------------------+
|                      CLI Orchestrator                        |
|                    src/codex-bridge.mjs                      |
| COMMANDS -> handlers -> SUBCOMMAND_DISPATCH -> main()        |
+----------------------------+--------------------------------+
                             |
                             v
+-------------------------------------------------------------+
| Runtime Options, Config, Adapter Selection, and Git Context  |
| src/lib/runtime-options.mjs | src/lib/config.mjs             |
| src/adapters/index.mjs     | src/lib/git.mjs                |
+----------------------------+--------------------------------+
                             |
                             v
+-------------------------------------------------------------+
|                       Codex Runtime                          |
| src/adapters/codex/codex.mjs                                 |
| src/adapters/codex/protocol.mjs                              |
| src/adapters/codex/pipeline.mjs                              |
+----------------------------+--------------------------------+
                             |
                             v
+-------------------------------------------------------------+
| Broker, State, Session Logs, Job Control, and User Responses |
| src/adapters/codex/broker.mjs | src/lib/broker-lifecycle.mjs |
| src/lib/state.mjs            | src/lib/session-log.mjs       |
| src/lib/tracked-jobs.mjs     | src/lib/job-control.mjs       |
| src/lib/pending-requests.mjs | src/lib/registry.mjs          |
+-------------------------------------------------------------+
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI command registry | Defines command metadata and user-facing subcommands. | `src/codex-bridge.mjs` |
| CLI dispatch | Parses argv, handles help/errors/update checks, and routes to handlers. | `src/codex-bridge.mjs` |
| Task orchestration | Builds bridge requests, config, sessions, checkpoints, pipeline hooks, and Codex turns. | `src/codex-bridge.mjs` |
| Review orchestration | Resolves git review targets and runs native or prompt-driven review flows. | `src/codex-bridge.mjs`, `src/lib/git.mjs` |
| Adapter registry | Validates adapter shape, selects a backend, and gates declared capabilities. | `src/adapters/index.mjs` |
| Codex adapter descriptor | Declares Codex capabilities; lifecycle methods are placeholders for the generic adapter contract. | `src/adapters/codex/index.mjs` |
| Codex runtime | Starts/resumes app-server threads, captures turns, interrupts turns, and parses structured output. | `src/adapters/codex/codex.mjs` |
| App-server protocol client | Sends newline-delimited JSON requests to direct or brokered app-server transports. | `src/adapters/codex/protocol.mjs` |
| Shared broker | Multiplexes one direct `codex app-server` process behind a local socket/pipe endpoint. | `src/adapters/codex/broker.mjs` |
| Auto pipeline | Runs review, fix, completion-check, and terminal reporting stages around a task. | `src/adapters/codex/pipeline.mjs` |
| Runtime defaults | Owns default mode/model/effort/timeouts/sandbox policy and collaboration builders. | `src/lib/runtime-options.mjs` |
| Config loader | Merges install, workspace, and cwd YAML config layers. | `src/lib/config.mjs` |
| Workspace state | Stores job index, stop-gate config, broker metadata, locks, and job files. | `src/lib/state.mjs` |
| Job lifecycle | Creates tracked job records, writes job logs, and resolves status/result/cancel targets. | `src/lib/tracked-jobs.mjs`, `src/lib/job-control.mjs` |
| Session logging | Writes `.ndjson`, `.events`, `.diff`, `.plan.md`, and review artifacts for a thread. | `src/lib/session-log.mjs` |
| Pending responses | Bridges Codex server requests to the `respond` command through session files. | `src/lib/pending-requests.mjs` |
| Git and worktrees | Captures review context, diffs, subagent worktrees, branch merges, and cleanup. | `src/lib/git.mjs` |
| Rendering | Produces human and JSON command envelopes. | `src/lib/render.mjs` |
| Update checks | Checks GitHub releases and supports detached installer auto-apply. | `src/lib/update-check.mjs` |
| Build layout | Bundles runtime entry points and copies static assets into `skill/` and `plugin/`. | `esbuild.config.mjs` |
| Hooks | Wires session lifecycle and stop-time review gate behavior. | `hooks/hooks.json`, `hooks/session-lifecycle-hook.mjs`, `hooks/stop-gate.mjs` |

## Pattern Overview

**Overall:** ESM CLI orchestrator with a Codex app-server runtime and disk-backed job/session state.

**Key Characteristics:**
- Use `src/codex-bridge.mjs` as the orchestration boundary for user commands and runtime policy.
- Use `src/adapters/index.mjs` for backend selection and capability checks; the only loadable backend is `codex`.
- Use `src/adapters/codex/codex.mjs` and `src/adapters/codex/protocol.mjs` for actual Codex app-server execution.
- Use a shared broker when available, but keep direct app-server fallback behavior inside `CodexAppServerClient.connect`.
- Use disk state and append-only session logs as the command surface for `status`, `result`, `wait`, `events`, `respond`, and hook flows.
- Generate installable `skill/` and `plugin/` runtime files from source through `esbuild.config.mjs`; do not hand-edit generated bundles.

## Layers

**Distribution Layer:**
- Purpose: Ship the same runtime through legacy skill and canonical plugin layouts.
- Location: `.claude-plugin/plugin.json`, `skill/`, `plugin/`, `hooks/`, `esbuild.config.mjs`.
- Contains: Plugin metadata, installable bundles, copied command/agent/hook surfaces, and default config.
- Depends on: `src/codex-bridge.mjs`, `src/adapters/codex/broker.mjs`, `src/prompts/`, `src/schemas/`, `src/templates/`, `commands/`, `agents/`, `hooks/`, `skill/config.yaml`.
- Used by: Claude Code plugin installs and CI workflow checks in `.github/workflows/build.yml`.

**CLI Layer:**
- Purpose: Parse commands, enforce command contracts, select runtime options, and render outputs.
- Location: `src/codex-bridge.mjs`.
- Contains: `COMMANDS`, handlers such as `handleTask`, `handleReviewCommand`, `handleStatus`, `handleResult`, `handleEvents`, and `SUBCOMMAND_DISPATCH`.
- Depends on: `src/lib/*`, `src/adapters/*`, Node built-ins, package metadata.
- Used by: Source-mode `npm run dev`, bundled `skill/scripts/codex-bridge.mjs`, bundled `plugin/scripts/codex-bridge.mjs`, and hooks.

**Runtime Options and Config Layer:**
- Purpose: Normalize user flags and config layers into collaboration mode, sandbox policy, model, effort, pipeline, and timeout settings.
- Location: `src/lib/runtime-options.mjs`, `src/lib/config.mjs`.
- Contains: `DEFAULT_CONFIG`, `buildCollaborationMode`, `buildSandboxPolicy`, config-source resolution, and YAML parsing.
- Depends on: `js-yaml`, `src/lib/workspace.mjs`.
- Used by: `runBridgeTask`, `handleConfigShow`, setup/version/status output, and pipeline setup.

**Adapter Layer:**
- Purpose: Provide a backend contract and backend selection policy.
- Location: `src/adapters/index.mjs`, `src/adapters/codex/index.mjs`.
- Contains: Required adapter fields/methods, backend loaders, route matching, capability gates, and Codex capability metadata.
- Depends on: `src/lib/config.mjs`, `src/lib/errors.mjs`.
- Used by: CLI handlers before runtime execution and user-facing capability/status commands.

**Codex Runtime Layer:**
- Purpose: Run Codex app-server threads and reviews, capture streaming state, and transform app-server output into bridge results.
- Location: `src/adapters/codex/codex.mjs`.
- Contains: `runAppServerTurn`, `runAppServerReview`, `interruptAppServerTurn`, availability checks, thread parameter construction, and turn capture.
- Depends on: `src/adapters/codex/protocol.mjs`, `src/lib/process.mjs`, `src/lib/errors.mjs`, `src/lib/session-log.mjs`.
- Used by: `task`, `send`, `review`, `adversarial-review`, `cancel`, auto-pipeline stages, and stop-gate hooks.

**Transport and Broker Layer:**
- Purpose: Speak the app-server JSON protocol directly or through a reusable local broker.
- Location: `src/adapters/codex/protocol.mjs`, `src/adapters/codex/broker.mjs`, `src/lib/broker-lifecycle.mjs`, `src/lib/broker-endpoint.mjs`.
- Contains: Direct process client, broker socket client, broker process lifecycle, endpoint parsing, streaming ownership, and server-request forwarding.
- Depends on: Node `child_process`, `net`, `fs`, `os`, and state broker metadata in `src/lib/state.mjs`.
- Used by: All Codex turn/review/interrupt operations.

**State and Job Layer:**
- Purpose: Persist job metadata, broker metadata, stop-gate config, and background job results by canonical workspace root.
- Location: `src/lib/state.mjs`, `src/lib/tracked-jobs.mjs`, `src/lib/job-control.mjs`, `src/lib/registry.mjs`.
- Contains: State root resolution, lock files, atomic JSON writes, job history, job logs, artifact registry, and status/result/cancel lookup helpers.
- Depends on: `src/lib/workspace.mjs`, `src/lib/process.mjs`, `src/lib/broker-lifecycle.mjs`.
- Used by: `task --background`, `task-worker`, `status`, `result`, `wait`, `cancel`, `merge`, hooks, and broker reuse.

**Session Log Layer:**
- Purpose: Preserve observable thread history and artifacts in append-only files.
- Location: `src/lib/session-log.mjs`, `src/lib/pending-requests.mjs`.
- Contains: `.events` formatting, `.ndjson` records, diff/review/plan artifacts, terminal-tag detection, pending question and response files.
- Depends on: Git commands and synchronous filesystem append operations.
- Used by: `events`, `wait`, `summary`, `respond`, pipeline, stop-gate, and result rendering.

**Git and Review Context Layer:**
- Purpose: Resolve branch/working-tree review targets, collect diff context, create isolated worktrees, merge approved work, and prune canceled work.
- Location: `src/lib/git.mjs`.
- Contains: Review target resolution, status/diff/log collection, worktree creation, fast-forward merge checks, and cleanup.
- Depends on: Git CLI and workspace root resolution.
- Used by: `review`, `adversarial-review`, `task --worktree-auto`, `merge`, and auto-pipeline review stages.

**Hook Layer:**
- Purpose: Attach bridge state to Claude sessions and run optional stop-time review gates.
- Location: `hooks/hooks.json`, `hooks/session-lifecycle-hook.mjs`, `hooks/stop-gate.mjs`, `hooks/stop-review-gate-hook.mjs`.
- Contains: Session env-file writes, orphan pruning, stop-gate status checks, and read-only review tasks.
- Depends on: Bundled `codex-bridge.mjs` path rewrites performed by `esbuild.config.mjs`.
- Used by: Plugin runtime declared in `plugin/.claude-plugin/plugin.json`.

## Data Flow

### Primary Foreground Task Path

1. `main()` parses argv and dispatches the command through `SUBCOMMAND_DISPATCH` (`src/codex-bridge.mjs:5679`, `src/codex-bridge.mjs:5591`).
2. `handleTask` validates task flags, resolves the adapter, builds a job request, and either queues background work or calls `runBridgeTask` (`src/codex-bridge.mjs:3580`, `src/codex-bridge.mjs:2435`).
3. `runBridgeTask` resolves workspace root, config, session directory, collaboration mode, sandbox policy, prompt footer, callbacks, checkpoint handling, and pipeline options (`src/codex-bridge.mjs:2435`).
4. The internal task executor calls `runAppServerTurn` with thread, prompt, model/effort, sandbox, collaboration, server-request handler, and streaming callbacks (`src/adapters/codex/codex.mjs:1232`).
5. `CodexAppServerClient.connect` chooses brokered or direct transport, initializes the app-server client, and sends app-server requests (`src/adapters/codex/protocol.mjs:530`).
6. `captureTurn` in the Codex runtime consumes notifications and final output, while CLI callbacks write session events and job progress (`src/adapters/codex/codex.mjs`, `src/lib/session-log.mjs:32`, `src/lib/session-log.mjs:47`).
7. `renderResult` and related render helpers emit a human or JSON envelope from `src/lib/render.mjs`.

### Background Task Path

1. `handleTask --background` stores a job request and creates a tracked job record (`src/codex-bridge.mjs:3580`, `src/lib/tracked-jobs.mjs:60`).
2. `task-worker` reloads the stored request and runs it through `runTrackedJob` (`src/codex-bridge.mjs:3809`, `src/lib/tracked-jobs.mjs:144`).
3. `runTrackedJob` writes running, terminal, error, rendered, and result details to job files and state index (`src/lib/tracked-jobs.mjs:144`, `src/lib/state.mjs:520`).
4. `status`, `result`, `wait`, and `events` resolve job/session state through `src/lib/job-control.mjs`, `src/lib/state.mjs`, and `src/lib/session-log.mjs`.

### Review and Auto-Pipeline Path

1. `handleReviewCommand` parses review flags, resolves a backend, resolves the git review target, collects review context, creates a job, and runs `executeReviewRun` (`src/codex-bridge.mjs:2344`, `src/lib/git.mjs:163`, `src/lib/git.mjs:397`).
2. Native Codex review uses `runAppServerReview`; adversarial review uses authored schema/prompt assets and structured output parsing in the Codex runtime (`src/adapters/codex/codex.mjs:1169`, `src/adapters/codex/codex.mjs`).
3. `runAutoPipeline` captures initial diff, may run review, may run fix, may run completion check, and writes `PIPELINE:*`, `DONE`, or `INCOMPLETE` events (`src/adapters/codex/pipeline.mjs:36`).
4. Pipeline stages rely on `captureGitDiff`, `writeReview`, `buildCollaborationMode`, and `buildSandboxPolicy` rather than duplicating those policies (`src/lib/session-log.mjs:150`, `src/lib/runtime-options.mjs:101`, `src/lib/runtime-options.mjs:129`).

### App-Server Protocol and Broker Flow

1. `buildThreadParams` sets app-server thread options including approval policy, sandbox, service name, and ephemeral behavior (`src/adapters/codex/codex.mjs:59`).
2. `CodexAppServerClient.connect` prefers an explicit broker endpoint, then an existing broker, then a managed broker, with direct fallback only for stale saved broker initialization failures (`src/adapters/codex/protocol.mjs:530`).
3. Direct mode spawns `codex app-server`; broker mode connects to a local endpoint stored by `ensureBrokerSession` (`src/adapters/codex/protocol.mjs:339`, `src/adapters/codex/protocol.mjs:457`, `src/lib/broker-lifecycle.mjs:171`).
4. Outbound app-server messages are newline-delimited JSON objects containing `id`, `method`, and `params`; the client does not add a `jsonrpc` field (`src/adapters/codex/protocol.mjs`).
5. The broker tracks one active streaming request among `turn/start`, `review/start`, and `thread/compact/start`, while allowing `turn/interrupt` during an active stream (`src/adapters/codex/broker.mjs:13`, `src/adapters/codex/broker.mjs:51`).
6. Broker endpoints are Unix sockets on non-Windows and named pipes on Windows (`src/lib/broker-endpoint.mjs:10`, `src/lib/broker-endpoint.mjs:19`).

### Session, Events, and User Response Flow

1. `initSession` creates a thread-specific `.ndjson` and `.events` pair under the configured session directory (`src/lib/session-log.mjs:8`, `src/lib/session-log.mjs:14`).
2. Runtime callbacks append structured NDJSON and formatted event blocks synchronously (`src/lib/session-log.mjs:32`, `src/lib/session-log.mjs:47`).
3. If Codex asks for user input, the bridge writes a pending request file through `writePendingRequest` (`src/lib/pending-requests.mjs:20`).
4. `respond` writes the answer file for the waiting worker and logs the response (`src/codex-bridge.mjs:5431`).
5. `events`, `wait`, and `summary` read session artifacts instead of contacting the app-server (`src/codex-bridge.mjs:4394`, `src/codex-bridge.mjs:4329`, `src/codex-bridge.mjs:5494`).

### Setup, Config, Update, and Hook Flow

1. `handleSetup` checks runtime readiness and stop-review-gate state; enabling the gate creates a project lock only when the official OpenAI Codex plugin is absent (`src/codex-bridge.mjs:1048`, `src/lib/state.mjs:433`).
2. `handleConfigShow` resolves effective config using defaults, install-root config, workspace-root config, and cwd config (`src/lib/config.mjs:107`).
3. `handleUpdate` calls the release checker and `maybeTriggerAutoApply` can detach an installer on normal hot-path commands (`src/codex-bridge.mjs:1252`, `src/lib/update-check.mjs:261`).
4. `hooks/session-lifecycle-hook.mjs` writes session and data-root env vars on SessionStart, while Stop hooks invoke bridge commands from the bundled runtime path (`hooks/session-lifecycle-hook.mjs:13`, `hooks/stop-gate.mjs:78`, `hooks/stop-review-gate-hook.mjs:16`).

**State Management:**
- Workspace state keys off the canonical workspace root and stores `state.json`, `state.lock`, `jobs/`, and broker metadata under the plugin data root (`src/lib/state.mjs`).
- Plugin data root precedence is `CODEX_BRIDGE_PLUGIN_DATA`, then `CLAUDE_PLUGIN_DATA`, then an OS temp fallback (`src/lib/state.mjs`).
- Session logs default to `~/.codex-bridge/sessions` unless config supplies another session directory (`src/lib/session-log.mjs:8`).
- Per-task artifact registry defaults to `~/.codex-bridge/jobs` unless `CODEX_BRIDGE_REGISTRY` is set (`src/lib/registry.mjs`).

## Key Abstractions

**Backend Adapter:**
- Purpose: Declare backend identity, capabilities, and lifecycle methods.
- Examples: `src/adapters/index.mjs`, `src/adapters/codex/index.mjs`.
- Pattern: Registry with shape validation and capability guards. Add new loadable backends by adding a loader in `src/adapters/index.mjs`.

**Bridge Request:**
- Purpose: Carry prompt, cwd, mode, config, timeouts, sandbox, callbacks, session, and job metadata into task execution.
- Examples: `src/codex-bridge.mjs`.
- Pattern: Build once in CLI handlers, then pass through `runBridgeTask` into Codex runtime calls.

**Codex App-Server Client:**
- Purpose: Hide direct process vs broker socket transport behind the same request/notification API.
- Examples: `src/adapters/codex/protocol.mjs`.
- Pattern: Initialize with `initialize` and `initialized`, then write newline-delimited JSON requests and resolve pending responses by id.

**Broker Stream Tracker:**
- Purpose: Preserve single-stream ownership until the active stream and related sub-threads complete.
- Examples: `src/adapters/codex/broker.mjs`, `test/broker-stream-release-ordering.test.mjs`.
- Pattern: Track active stream socket, known thread ids, early completions, disconnects, and cleanup before accepting another streaming request.

**Session Event Log:**
- Purpose: Provide durable command-visible progress without requiring a live Codex connection.
- Examples: `src/lib/session-log.mjs`, `test/events-json.test.mjs`.
- Pattern: Append formatted event blocks and structured NDJSON synchronously; consumers read or follow files.

**Tracked Job Record:**
- Purpose: Persist background job state, progress, result, rendered output, and logs.
- Examples: `src/lib/tracked-jobs.mjs`, `src/lib/job-control.mjs`, `src/lib/state.mjs`.
- Pattern: State index plus per-job file, with terminal history pruning and active-job retention.

**Review Target:**
- Purpose: Normalize dirty working tree, branch diff, and explicit review targets into a reviewable context.
- Examples: `src/lib/git.mjs`.
- Pattern: Resolve target first, collect bounded context second, then pass context to native or prompt-based review.

**Generated Surface:**
- Purpose: Keep installable runtime surfaces in sync with source.
- Examples: `esbuild.config.mjs`, `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs`.
- Pattern: Edit source or authored plugin inputs, run `npm run build`, and include generated diffs.

## Entry Points

**Source CLI:**
- Location: `src/codex-bridge.mjs`.
- Triggers: `npm run dev`, direct `node src/codex-bridge.mjs`, generated bundle execution.
- Responsibilities: Command dispatch, option validation, config resolution, adapter selection, job/session setup, runtime execution, and rendering.

**Bundled Skill CLI:**
- Location: `skill/scripts/codex-bridge.mjs`.
- Triggers: Legacy skill install layout.
- Responsibilities: Execute bundled CLI code emitted from `src/codex-bridge.mjs`.

**Bundled Plugin CLI:**
- Location: `plugin/scripts/codex-bridge.mjs`.
- Triggers: Plugin command and hook surfaces.
- Responsibilities: Execute bundled CLI code emitted from `src/codex-bridge.mjs`.

**Broker Process:**
- Location: `src/adapters/codex/broker.mjs`, `skill/app-server-broker.mjs`, `plugin/scripts/app-server-broker.mjs`.
- Triggers: Managed broker lifecycle from `src/lib/broker-lifecycle.mjs`.
- Responsibilities: Host one upstream Codex app-server process and broker local downstream clients.

**Hooks:**
- Location: `hooks/hooks.json`, `hooks/session-lifecycle-hook.mjs`, `hooks/stop-gate.mjs`, `hooks/stop-review-gate-hook.mjs`.
- Triggers: Claude Code SessionStart, SessionEnd, and Stop hook events.
- Responsibilities: Session environment propagation, orphan pruning, and optional read-only stop-gate review.

**Build:**
- Location: `esbuild.config.mjs`.
- Triggers: `npm run build`, CI workflow.
- Responsibilities: Bundle CLI/broker entry points and copy static assets into `skill/` and `plugin/`.

## Architectural Constraints

- **Runtime:** Use Node.js `>=22.0.0` and ESM modules. Package metadata lives in `package.json`.
- **Backend:** Only `codex` is loadable through `ADAPTER_LOADERS` in `src/adapters/index.mjs`.
- **Adapter shell:** Do not rely on `src/adapters/codex/index.mjs` lifecycle methods for execution; bridge command handlers call Codex runtime helpers directly.
- **Protocol:** App-server outbound requests are newline-delimited JSON objects with `id`, `method`, and `params`, without a `jsonrpc` field.
- **Client info:** Keep `DEFAULT_CLIENT_INFO.name` as `codex_bridge` unless the app-server contract and tests change (`src/adapters/codex/protocol.mjs:26`).
- **Plan mode:** `buildCollaborationMode` forces reasoning effort `xhigh` for plan mode regardless of configured execute effort (`src/lib/runtime-options.mjs:101`).
- **Config precedence:** Defaults merge below install-root `config.yaml`, workspace-root `config.yaml`, and cwd `config.yaml` (`src/lib/config.mjs:107`).
- **State root:** Use `CODEX_BRIDGE_PLUGIN_DATA`, then `CLAUDE_PLUGIN_DATA`, then temp fallback for workspace state (`src/lib/state.mjs`).
- **Session writes:** Keep session `.events` and `.ndjson` append-only and synchronous through `src/lib/session-log.mjs`.
- **Stop gate:** Stop review gate is project-scoped through `.codex-bridge-stop-review-gate.lock` and is suppressed when the official OpenAI Codex plugin is active.
- **Generated outputs:** Do not hand-edit generated runtime files under `skill/scripts/`, `skill/prompts/`, `skill/schemas/`, `skill/templates/`, `plugin/scripts/`, `plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`, `plugin/commands/`, `plugin/agents/`, `plugin/hooks/`, or `plugin/config.yaml`.
- **CI drift check:** `.github/workflows/build.yml` runs `npm run build`, `npm test`, and fails if committed generated paths drift from a fresh build.

## Anti-Patterns

### Editing Generated Runtime Files

**What happens:** A change is made directly under `skill/scripts/`, `plugin/scripts/`, generated prompt/schema/template copies, plugin command copies, plugin agent copies, plugin hook copies, or `plugin/config.yaml`.

**Why it's wrong:** `esbuild.config.mjs` overwrites those paths and CI checks generated drift.

**Do this instead:** Edit the source in `src/`, `commands/`, `agents/`, `hooks/`, `src/prompts/`, `src/schemas/`, `src/templates/`, or `skill/config.yaml`, then run `npm run build`.

### Bypassing Runtime Option Builders

**What happens:** A handler constructs model, effort, sandbox, or collaboration options manually.

**Why it's wrong:** Plan mode effort, sandbox fallback, prompt footer, and pipeline timeout behavior are centralized.

**Do this instead:** Use `buildCollaborationMode`, `buildSandboxPolicy`, and config helpers in `src/lib/runtime-options.mjs`.

### Treating `.events` as an Unstructured Log

**What happens:** A new command scans `.events` with ad hoc terminal checks or assumes all events are one-line strings.

**Why it's wrong:** Event blocks have formatted tags and terminal semantics implemented by `src/lib/session-log.mjs`.

**Do this instead:** Use the session-log helpers and preserve terminal tags consumed by `wait`, `events`, and pipeline flows.

### Adding Async Session Writers

**What happens:** New code writes competing asynchronous streams to the same `.events` or `.ndjson` files.

**Why it's wrong:** The current durability model is synchronous append through `logEvent` and `logNdjson`.

**Do this instead:** Route all session artifact writes through `src/lib/session-log.mjs`.

### Assuming Broker Concurrency Is Unbounded

**What happens:** A new app-server call starts while another streaming `turn/start` or `review/start` is active.

**Why it's wrong:** The broker is designed around one active streaming owner and rejects other requests with a broker busy code, except allowed interrupts.

**Do this instead:** Respect broker busy responses and use status/session surfaces to monitor active work.

## Error Handling

**Strategy:** Convert local validation failures and runtime failures into `CliError`-style command envelopes, while preserving raw session/job evidence on disk.

**Patterns:**
- Validate user flags and adapter capability before spawning Codex (`src/codex-bridge.mjs`, `src/adapters/index.mjs`).
- Map app-server availability, protocol, idle-timeout, turn-timeout, and pipeline failures into structured command errors (`src/adapters/codex/codex.mjs`, `src/lib/cli-errors.mjs`).
- Write recoverable progress and terminal state to `.events`, `.ndjson`, job files, and registry files (`src/lib/session-log.mjs`, `src/lib/tracked-jobs.mjs`, `src/lib/registry.mjs`).
- On unexpected CLI crashes, write a crash log under the bridge data area before rethrow/rendering (`src/codex-bridge.mjs`).
- Use best-effort cleanup for broker sessions, worktrees, process trees, stale locks, stale job files, and orphaned jobs (`src/lib/broker-lifecycle.mjs`, `src/lib/git.mjs`, `src/lib/process.mjs`, `src/lib/state.mjs`).

## Cross-Cutting Concerns

**Logging:**
- Use `src/lib/session-log.mjs` for per-thread `.events` and `.ndjson`.
- Use `src/lib/tracked-jobs.mjs` for per-job logs and terminal result files.
- Use `src/lib/registry.mjs` for task-scoped registry artifacts.

**Validation:**
- Use command flag validation in `src/codex-bridge.mjs`.
- Use adapter shape and capability validation in `src/adapters/index.mjs`.
- Use schema-backed structured review output through `src/schemas/review-output.schema.json` and Codex output parsing.
- Use tests under `test/*.test.mjs` for adapter routing, protocol, broker lifecycle, session logging, state, events, pipeline, plugin surfaces, and CLI behavior.

**Authentication:**
- The bridge delegates real auth to the Codex CLI and app-server runtime.
- `getCodexAvailability` checks the Codex binary and app-server support before runtime use (`src/adapters/codex/codex.mjs:1127`).
- Official OpenAI Codex plugin detection is isolated in `src/lib/official-plugin.mjs` and affects stop-gate setup.

**Configuration:**
- Keep defaults in `src/lib/runtime-options.mjs`.
- Keep YAML loading and source precedence in `src/lib/config.mjs`.
- Keep shipped default config in `skill/config.yaml`, then regenerate `plugin/config.yaml`.

**Process Control:**
- Use `src/lib/process.mjs` for binary checks, spawned commands, and process tree termination.
- Use `src/lib/broker-lifecycle.mjs` for broker process startup, health checks, saved broker session metadata, and teardown.

## Test Anchors

| Area | Tests |
|------|-------|
| Adapter contract and routing | `test/adapter-registry.test.mjs`, `test/adapter-routing.test.mjs` |
| App-server client protocol | `test/app-server-client.test.mjs`, `test/app-server-client-helpers.test.mjs` |
| Broker startup and stream release | `test/broker-lifecycle.test.mjs`, `test/broker-stream-release-ordering.test.mjs` |
| Session logs and event JSON | `test/session-log.test.mjs`, `test/events-json.test.mjs` |
| State and job control | `test/state.test.mjs`, `test/job-control.test.mjs`, `test/status-watch.test.mjs` |
| Task and review command behavior | `test/task-command.test.mjs`, `test/review-command.test.mjs`, `test/turn-request.test.mjs` |
| Pipeline behavior | `test/pipeline-command.test.mjs`, `test/auto-pipeline.test.mjs` |
| Build and plugin surfaces | `test/plugin-surfaces.test.mjs`, `.github/workflows/build.yml` |

---

*Architecture analysis: 2026-04-30*
