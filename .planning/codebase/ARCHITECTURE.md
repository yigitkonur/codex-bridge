---
last_mapped_commit: 6b3a78a98eb5396798d0ed2ee3d8f7451f204652
---
<!-- refreshed: 2026-05-02 -->
# Architecture

**Analysis Date:** 2026-05-02

## System Overview

```text
+-------------------------------------------------------------------+
| Claude Code Surfaces                                               |
| `.claude-plugin/`, `plugin/commands/`, `plugin/agents/`, `hooks/`  |
+----------------------+----------------------+---------------------+
                       |                      |
                       v                      v
+-------------------------------------------------------------------+
| Generated Runtime Entrypoints                                      |
| `plugin/scripts/codex-bridge.mjs`, `skill/scripts/codex-bridge.mjs`|
| `plugin/scripts/app-server-broker.mjs`, `skill/app-server-broker.mjs` |
+-------------------------------------------------------------------+
                       |
                       v
+-------------------------------------------------------------------+
| Authored CLI Orchestrator                                          |
| `src/codex-bridge.mjs`                                             |
| command registry, handlers, task/review lifecycle, Stop gate setup |
+----------------------+----------------------+---------------------+
                       |                      |
                       v                      v
+----------------------------------+  +-----------------------------+
| Adapter Boundary                 |  | Shared Runtime Libraries     |
| `src/adapters/index.mjs`         |  | `src/lib/*.mjs`              |
| `src/adapters/codex/index.mjs`   |  | config, state, git, render,  |
+----------------------------------+  | session logs, job control    |
                       |             +-----------------------------+
                       v                      |
+-------------------------------------------------------------------+
| Codex App-Server Runtime                                           |
| `src/adapters/codex/codex.mjs`, `src/adapters/codex/protocol.mjs`  |
| `src/adapters/codex/broker.mjs`, `src/lib/broker-lifecycle.mjs`    |
+-------------------------------------------------------------------+
                       |
                       v
+-------------------------------------------------------------------+
| External Process / Workspace Artifacts                             |
| Codex CLI app-server, Git worktrees, `.events`, `.ndjson`, state   |
| roots from `CODEX_BRIDGE_PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, temp  |
+-------------------------------------------------------------------+
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI command registry | Defines the public subcommand surface, help metadata, and dispatch names. | `src/codex-bridge.mjs` |
| CLI handlers | Parse command flags, resolve cwd/workspace roots, and coordinate task, review, setup, status, result, wait, cancel, send, steer, respond, merge, verdict, update, and config flows. | `src/codex-bridge.mjs` |
| Task lifecycle | Builds bridge requests, opens sessions, injects plan/default instructions, handles heartbeats, checkpoints, retry state, Stop-gate review, and auto-pipeline transitions. | `src/codex-bridge.mjs` |
| Adapter registry | Selects a runtime backend from command flags, environment, task metadata, user config, and default config. | `src/adapters/index.mjs` |
| Codex adapter facade | Exposes dispatch, resume, steer, respond, cancel, result, and event streaming operations for the CLI. | `src/adapters/codex/index.mjs` |
| Codex turn capture | Translates Codex app-server notifications into task results, plans, diffs, reasoning summaries, command executions, and review output. | `src/adapters/codex/codex.mjs` |
| App-server protocol client | Sends newline-delimited JSON request objects, tracks pending calls, handles server-originated requests, and connects through a broker or direct app-server process. | `src/adapters/codex/protocol.mjs` |
| Shared broker process | Serializes app-server access across clients, rejects incompatible concurrent calls, permits interrupts while a turn stream is active, and cleans endpoint state. | `src/adapters/codex/broker.mjs` |
| Broker lifecycle | Starts, reuses, tears down, and persists managed broker sessions for a workspace. | `src/lib/broker-lifecycle.mjs` |
| Runtime config | Loads YAML config layers and converts mode, effort, sandbox, and pipeline settings into Codex request options. | `src/lib/config.mjs`, `src/lib/runtime-options.mjs` |
| Workspace state | Stores workspace-scoped job index, broker state, review-gate flags, stop-gate metadata, and job request payloads with lock-protected atomic writes. | `src/lib/state.mjs` |
| Job execution records | Wraps detached jobs, writes job JSON/log files, and mirrors status into the workspace state index. | `src/lib/tracked-jobs.mjs`, `src/lib/job-control.mjs` |
| Session artifacts | Appends event and NDJSON streams, writes plans/diffs/reviews, formats terminal tags, and exposes followable event tails. | `src/lib/session-log.mjs` |
| Pending questions | Persists one pending app-server question per thread and lets the separate `respond` command return answers through disk files. | `src/lib/pending-requests.mjs` |
| Git context and isolation | Resolves review targets, collects working-tree or branch diffs, creates task worktrees, prunes worktrees, and ff-merges approved branches. | `src/lib/git.mjs` |
| Task registry | Stores per-task artifacts, structured briefs, events, verdicts, and metadata under the user registry root. | `src/lib/registry.mjs`, `src/lib/brief.mjs` |
| Rendering and validation | Formats setup/status/result/review output and validates structured review result shape. | `src/lib/render.mjs` |
| Error envelopes | Normalizes CLI failures into machine-readable classes, exit codes, retryability, and human suggestions. | `src/lib/cli-errors.mjs` |
| Build pipeline | Bundles source into skill and plugin runtime layouts and copies static assets into generated destinations. | `esbuild.config.mjs` |
| Tests and CI | Verify adapter contracts, protocol behavior, state locking, hooks, plugin surfaces, generated drift, and static CLI contracts. | `test/*.test.mjs`, `.github/workflows/build.yml` |

## Pattern Overview

**Overall:** Source-first ESM CLI orchestrator with an adapter boundary, Codex app-server transport, generated distribution layouts, and append-only observable job/session artifacts.

**Key Characteristics:**
- Use `src/codex-bridge.mjs` as the only authored public CLI orchestrator. Add command metadata to `COMMANDS`, add the handler, and wire `SUBCOMMAND_DISPATCH` together.
- Keep runtime backend calls behind `src/adapters/index.mjs` and `src/adapters/codex/index.mjs`. The implemented backend is Codex; future-backend notes live in `.planning/codebase/ADAPTERS.md` until a concrete adapter is added.
- Treat `src/` as source of truth and `skill/` plus `plugin/` runtime copies as build outputs where `esbuild.config.mjs` marks them generated.
- Keep long-running work observable through synchronous `.events` and `.ndjson` session streams from `src/lib/session-log.mjs`.
- Keep workspace-scoped coordination in `src/lib/state.mjs`; keep per-task artifact registry data in `src/lib/registry.mjs`.
- Isolate write-mode delegated work through Git worktrees or a controlled branch-only fallback from `src/lib/git.mjs`.
- Route Claude plugin commands and agents through the packaged script under `plugin/scripts/codex-bridge.mjs`; root `commands/` and `agents/` directories are not present in this checkout.

## Layers

**Claude Plugin and Skill Surface:**
- Purpose: Provides installable slash commands, agents, hooks, plugin metadata, skill metadata, and default config.
- Location: `.claude-plugin/`, `plugin/`, `skill/`, `hooks/`
- Contains: Plugin manifests, command markdown, agent markdown, hook scripts/config, generated runtime bundles, generated prompts/schemas/templates, and legacy skill assets.
- Depends on: Generated scripts from `esbuild.config.mjs` and the Node runtime.
- Used by: Claude Code plugin/skill users invoking `/codex-bridge:*` commands and lifecycle hooks.

**CLI Orchestration Layer:**
- Purpose: Owns command parsing, foreground/background routing, session setup, task/review flow control, Stop-gate setup, update checks, and machine-readable envelopes.
- Location: `src/codex-bridge.mjs`
- Contains: `COMMANDS`, `SUBCOMMAND_DISPATCH`, command handlers, task/review execution functions, worker entrypoints, event/status/result/wait/cancel operations, and lifecycle signal handling.
- Depends on: `src/lib/*.mjs`, `src/adapters/index.mjs`, `src/adapters/codex/*.mjs`, `src/prompts/`, `src/schemas/`, and `src/templates/`.
- Used by: `npm run dev`, generated `skill/scripts/codex-bridge.mjs`, generated `plugin/scripts/codex-bridge.mjs`, plugin commands, plugin agents, and hooks.

**Adapter Boundary Layer:**
- Purpose: Selects and validates runtime adapters and guards capability use.
- Location: `src/adapters/index.mjs`, `src/adapters/index.d.ts`
- Contains: Adapter loading, backend selection precedence, capability validation, and runtime config integration.
- Depends on: `src/lib/config.mjs` and adapter implementation modules.
- Used by: CLI task/review/setup/auth/result/send/steer/respond flows in `src/codex-bridge.mjs`.

**Codex Runtime Layer:**
- Purpose: Implements the Codex backend by translating bridge requests into Codex app-server turns, reviews, interruptions, server-request responses, and result capture.
- Location: `src/adapters/codex/`
- Contains: Adapter facade in `src/adapters/codex/index.mjs`, turn capture in `src/adapters/codex/codex.mjs`, protocol client in `src/adapters/codex/protocol.mjs`, broker process in `src/adapters/codex/broker.mjs`, pipeline defaults in `src/adapters/codex/pipeline.mjs`, and protocol types in `src/adapters/codex/protocol.d.ts`.
- Depends on: Codex CLI `codex app-server`, `src/lib/broker-lifecycle.mjs`, runtime options, session logging, and JSON schema assets.
- Used by: Task, review, send, steer, respond, cancel, setup, and auth-status commands.

**Shared Runtime Libraries:**
- Purpose: Encapsulate config, errors, process execution, Git, workspace resolution, state, jobs, rendering, pending requests, update checks, prompt loading, and filesystem helpers.
- Location: `src/lib/`
- Contains: Single-purpose ESM modules used by the CLI and adapter layers.
- Depends on: Node built-ins, `js-yaml`, Git, Codex CLI checks, and configured filesystem roots.
- Used by: `src/codex-bridge.mjs`, `src/adapters/codex/*.mjs`, hooks, and tests.

**Artifact and State Layer:**
- Purpose: Makes task execution inspectable and resumable across processes.
- Location: `src/lib/state.mjs`, `src/lib/session-log.mjs`, `src/lib/tracked-jobs.mjs`, `src/lib/job-control.mjs`, `src/lib/registry.mjs`, `src/lib/pending-requests.mjs`
- Contains: `state.json`, `state.lock`, `jobs/*.json`, job logs, session `.events`, `.ndjson`, `.plan.md`, `.diff`, `.review.json`, pending question files, response files, and task registry artifacts.
- Depends on: Workspace root canonicalization from `src/lib/workspace.mjs` and state root environment variables.
- Used by: Background workers, status/result/wait/events/cancel commands, `respond`, Stop hooks, and review/merge/verdict flows.

**Authored Prompt/Schema/Template Layer:**
- Purpose: Holds source assets consumed by task and review flows.
- Location: `src/prompts/`, `src/schemas/`, `src/templates/`
- Contains: Adversarial review prompt, structured review schema, execute instructions, and plan enforcement instructions.
- Depends on: Build copying rules in `esbuild.config.mjs`.
- Used by: Review execution in `src/codex-bridge.mjs`, generated `skill/` assets, generated `plugin/` assets, and strict prompt/schema tests.

**Build and CI Layer:**
- Purpose: Produces installable plugin/skill layouts and verifies generated artifacts.
- Location: `esbuild.config.mjs`, `package.json`, `.github/workflows/build.yml`, `.github/workflows/release.yml`
- Contains: Dual esbuild targets, static asset copy lists, plugin hook/command/agent copy rules, Node 22 test workflow, generated drift checks, release packaging.
- Depends on: Node 22, npm, `esbuild`, `js-yaml`.
- Used by: Local verification and GitHub Actions.

## Data Flow

### Primary Task Path

1. CLI startup enters `main` and dispatches through `SUBCOMMAND_DISPATCH` (`src/codex-bridge.mjs:5738`, `src/codex-bridge.mjs:5650`).
2. `handleTask` parses mode, model, effort, sandbox, prompt, background, brief, and worktree options (`src/codex-bridge.mjs:3603`).
3. Write-mode auto-isolation calls `createSubagentWorktree` and persists registry metadata when `--worktree-auto` is used (`src/codex-bridge.mjs:3723`, `src/lib/git.mjs:527`, `src/lib/registry.mjs:95`).
4. Foreground tasks run through `runForegroundCommand`; background tasks create a job request and spawn `task-worker` through `enqueueBackgroundTask` (`src/codex-bridge.mjs:2195`, `src/codex-bridge.mjs:2275`).
5. `runBridgeTask` resolves config, workspace root, adapter, session directory, prompt decorators, timeouts, heartbeat state, and terminal-event handlers (`src/codex-bridge.mjs:2456`).
6. The bridge request includes collaboration mode, sandbox policy, user prompt, cwd, metadata, server-request handler, and lifecycle callbacks (`src/codex-bridge.mjs:2570`).
7. `executeTaskRun` resolves the active adapter and calls `adapter.dispatch` (`src/codex-bridge.mjs:1828`, `src/codex-bridge.mjs:1877`).
8. The Codex adapter facade calls `runAppServerTurn` (`src/adapters/codex/index.mjs:99`, `src/adapters/codex/codex.mjs:1232`).
9. `runAppServerTurn` opens a brokered or direct `CodexAppServerClient`, initializes/resumes a thread, sends `turn/start`, and captures app-server events (`src/adapters/codex/protocol.mjs:530`, `src/adapters/codex/codex.mjs:1295`, `src/adapters/codex/codex.mjs:1332`).
10. `captureTurn` maps app-server notifications and output items into progress, plans, final messages, command executions, and file changes (`src/adapters/codex/codex.mjs:641`).
11. Session and job files are written by event callbacks and tracked-job wrappers (`src/lib/session-log.mjs:32`, `src/lib/session-log.mjs:47`, `src/lib/tracked-jobs.mjs:144`).
12. `runBridgeTask` emits terminal `DONE`, `ERROR`, `PARTIAL`, `HANDOFF`, or `INCOMPLETE` events and may run an auto-review pipeline before returning (`src/codex-bridge.mjs:3244`, `src/codex-bridge.mjs:3451`, `src/lib/session-log.mjs:327`).

### Review Path

1. `review` and `adversarial-review` dispatch through `handleReviewCommand` and `handleReview` (`src/codex-bridge.mjs:2365`, `src/codex-bridge.mjs:2444`).
2. `executeReviewRun` resolves Git repository state, default or explicit target, runtime adapter, and review mode (`src/codex-bridge.mjs:1573`, `src/lib/git.mjs:163`).
3. Native reviews call `runAppServerReview` with a branch or working-tree prompt (`src/codex-bridge.mjs:1655`, `src/adapters/codex/codex.mjs:1169`).
4. Adversarial reviews collect inline or self-collect Git context, load `src/prompts/adversarial-review.md`, load `src/schemas/review-output.schema.json`, and call `runAppServerTurn` with structured output (`src/codex-bridge.mjs:1675`, `src/lib/git.mjs:397`, `src/lib/adversarial-review-prompt.mjs`, `src/adapters/codex/codex.mjs:1232`).
5. Review artifacts are written as `.review.json` plus session events and optional task-registry verdicts (`src/lib/session-log.mjs:78`, `src/lib/registry.mjs:168`, `src/lib/registry.mjs:173`).

### Background Monitor Path

1. Background task/review commands store a job request in the workspace state directory and launch a detached Node worker (`src/codex-bridge.mjs:2275`, `src/lib/state.mjs:520`).
2. `task-worker` reloads the stored request and runs the same `runBridgeTask` path inside `runTrackedJob` (`src/codex-bridge.mjs:3839`, `src/lib/tracked-jobs.mjs:144`).
3. `status`, `result`, `wait`, `events`, and `cancel` resolve jobs through `src/lib/job-control.mjs` and workspace state (`src/codex-bridge.mjs:3904`, `src/codex-bridge.mjs:4261`, `src/codex-bridge.mjs:4367`, `src/codex-bridge.mjs:4432`, `src/codex-bridge.mjs:4730`).
4. `events --follow` tails `.events` files and filters terminal or noisy tags (`src/codex-bridge.mjs:4432`, `src/lib/session-log.mjs:710`, `src/lib/session-log.mjs:722`).

### Interactive Question Path

1. Codex app-server sends `item/tool/requestUserInput` to the client (`src/adapters/codex/protocol.mjs:241`).
2. `createBridgeServerRequestHandler` writes a pending question file, logs a `QUESTION` event, and waits for a matching response file (`src/codex-bridge.mjs:350`, `src/lib/pending-requests.mjs:20`, `src/lib/pending-requests.mjs:88`).
3. The `respond` command locates the pending request by thread or request id and writes `{threadId}.response.json` (`src/codex-bridge.mjs:5486`, `src/lib/pending-requests.mjs:35`, `src/lib/pending-requests.mjs:62`).
4. The worker consumes the response file and resolves the upstream server request over its own app-server connection (`src/lib/pending-requests.mjs:68`, `src/adapters/codex/protocol.mjs:302`).

### Stop Review Gate Path

1. `setup --enable-review-gate` creates project-local lock state for the hook when the official OpenAI Codex plugin is not present (`src/codex-bridge.mjs:1048`, `src/codex-bridge.mjs:856`).
2. Claude Stop hooks are registered by `hooks/hooks.json` and generated into `plugin/hooks/hooks.json`.
3. `hooks/stop-gate.mjs` reads hook input, validates the lock and setup readiness, extracts the latest assistant transcript, writes a temporary prompt, and invokes a read-only no-pipeline `task` review command.
4. The hook interprets `ALLOW:` or `BLOCK:` from the reviewer output and returns a Claude hook JSON decision (`hooks/stop-gate.mjs`).

**State Management:**
- Config precedence is `DEFAULT_CONFIG` < install-root `config.yaml` < workspace-root `config.yaml` < cwd `config.yaml` (`src/lib/config.mjs:56`, `src/lib/runtime-options.mjs:1`).
- Workspace state root uses `CODEX_BRIDGE_PLUGIN_DATA`, then `CLAUDE_PLUGIN_DATA`, then `os.tmpdir()/codex-companion`; each workspace gets a slug plus hash directory (`src/lib/state.mjs:10`, `src/lib/state.mjs:41`).
- Workspace state uses `state.lock`, atomic JSON writes, stale-lock handling, and corrupt-state recovery (`src/lib/state.mjs:79`, `src/lib/state.mjs:173`, `src/lib/state.mjs:247`).
- Session logs use append-only synchronous `.ndjson` and `.events` writes (`src/lib/session-log.mjs:14`, `src/lib/session-log.mjs:32`, `src/lib/session-log.mjs:47`).
- Task registry artifacts default to `~/.codex-bridge/jobs/<task_id>` and can be redirected with `CODEX_BRIDGE_REGISTRY` for tests (`src/lib/registry.mjs:51`).
- Pending request IPC uses `{threadId}.pending.json` and `{threadId}.response.json` in the session directory (`src/lib/pending-requests.mjs:15`).

## Key Abstractions

**Command Definition:**
- Purpose: Public CLI contract for help, JSON help, plugin command coverage, and dispatch.
- Examples: `COMMANDS` and `SUBCOMMAND_DISPATCH` in `src/codex-bridge.mjs`.
- Pattern: Add metadata, add handler, then wire dispatch in the same file.

**Bridge Request:**
- Purpose: Normalizes task/review inputs before an adapter sees them.
- Examples: `buildTaskRequest`, `runBridgeTask`, `executeTaskRun` in `src/codex-bridge.mjs`.
- Pattern: Pass mode, cwd, prompt, collaboration, sandbox, metadata, hooks, and timeout policy as one request object.

**Runtime Adapter:**
- Purpose: Keeps backend selection and backend-specific execution separate from CLI command handlers.
- Examples: `src/adapters/index.mjs`, `src/adapters/codex/index.mjs`.
- Pattern: Adapter modules expose capabilities and methods; callers ask the registry to resolve a runtime adapter before execution.

**Codex App-Server Client:**
- Purpose: Provides the JSONL request/response/notification transport to Codex.
- Examples: `AppServerClientBase`, `SpawnedCodexAppServerClient`, `BrokerCodexAppServerClient`, `CodexAppServerClient.connect` in `src/adapters/codex/protocol.mjs`.
- Pattern: Prefer brokered sessions when available, then fall back to direct `codex app-server` when broker setup is unavailable.

**Managed Broker:**
- Purpose: Keeps a shared app-server process alive per workspace and serializes concurrent clients.
- Examples: `src/adapters/codex/broker.mjs`, `src/lib/broker-lifecycle.mjs`, `src/lib/broker-endpoint.mjs`.
- Pattern: Start through lifecycle helpers, persist endpoint/pid/log state, and reject concurrent streaming turns except interrupt operations.

**Session Event Stream:**
- Purpose: Makes long-running work monitorable by CLI commands and Claude command hints.
- Examples: `.events`, `.ndjson`, `.plan.md`, `.diff`, `.review.json` from `src/lib/session-log.mjs`.
- Pattern: Append events synchronously and use terminal tags as the durable completion contract.

**Workspace Job Index:**
- Purpose: Lets detached workers and foreground commands share job state safely.
- Examples: `loadState`, `updateState`, `upsertJob`, `writeJobFile`, `readJobFile` in `src/lib/state.mjs`.
- Pattern: Store canonical workspace data under a workspace-specific state directory with a lock and atomic rewrites.

**Git Review Target:**
- Purpose: Converts user review intent into working-tree or branch review context.
- Examples: `resolveReviewTarget`, `collectReviewContext`, `collectWorkingTreeContext`, `collectBranchContext` in `src/lib/git.mjs`.
- Pattern: Default to dirty working-tree diffs; otherwise compare current branch against detected default branch unless the user passes a base.

**Task Worktree:**
- Purpose: Isolates write-mode work from the user's checkout.
- Examples: `createSubagentWorktree`, `pruneWorktreeOnCancel`, `mergeSubagentBranch`, `listSubagentWorktrees` in `src/lib/git.mjs`.
- Pattern: Create `subagent/<backend>/<task_id>` branches under `../.codex-bridge-worktrees/<task_id>` and only use branch-only fallback when safe.

**Structured Brief:**
- Purpose: Supplies machine-checkable delegated task context.
- Examples: `loadBrief`, `renderBriefMarkdown`, `VALID_BACKENDS` in `src/lib/brief.mjs`.
- Pattern: Validate without AJV, hash raw input, reject unknown fields, and attach rendered brief text to the task prompt.

## Entry Points

**Package CLI:**
- Location: `src/codex-bridge.mjs`
- Triggers: `npm run dev`, generated skill/plugin scripts, plugin commands, agents, hooks, and CI sanity checks.
- Responsibilities: Dispatch all bridge subcommands, load config, resolve adapters, coordinate jobs, and emit JSON/human output.

**Generated Plugin Runtime:**
- Location: `plugin/scripts/codex-bridge.mjs`
- Triggers: `plugin/commands/*.md`, `plugin/agents/*.md`, `plugin/hooks/*.mjs`
- Responsibilities: Packaged runtime entrypoint produced by `npm run build`; do not hand-edit.

**Generated Skill Runtime:**
- Location: `skill/scripts/codex-bridge.mjs`
- Triggers: Legacy skill usage and release package.
- Responsibilities: Installable skill runtime produced by `npm run build`; do not hand-edit.

**App-Server Broker:**
- Location: `src/adapters/codex/broker.mjs`
- Triggers: Spawned by `ensureBrokerSession` through generated broker scripts.
- Responsibilities: Own one upstream Codex app-server connection and multiplex local clients over a socket/pipe endpoint.

**Claude Plugin Commands:**
- Location: `plugin/commands/*.md`
- Triggers: Claude Code slash commands under the plugin.
- Responsibilities: Forward user arguments to the generated CLI or delegate through `codex-bridge-runner` / `codex-bridge-reviewer`.

**Claude Plugin Agents:**
- Location: `plugin/agents/codex-bridge-runner.md`, `plugin/agents/codex-bridge-reviewer.md`
- Triggers: Plugin command front matter and explicit agent invocations.
- Responsibilities: Run bridge tasks/reviews through the packaged script and return monitor or verdict output.

**Claude Hooks:**
- Location: `hooks/hooks.json`, `hooks/session-lifecycle-hook.mjs`, `hooks/stop-gate.mjs`
- Triggers: Claude `SessionStart`, `SessionEnd`, and `Stop` hook events.
- Responsibilities: Inject bridge environment variables, prune orphan jobs, and run Stop-gate review checks.

**Build:**
- Location: `esbuild.config.mjs`
- Triggers: `npm run build` and `.github/workflows/build.yml`.
- Responsibilities: Bundle source entrypoints and copy source assets, plugin commands, plugin agents, hooks, and config into installable layouts.

**Tests:**
- Location: `test/*.test.mjs`
- Triggers: `npm test` and `.github/workflows/build.yml`.
- Responsibilities: Verify CLI contracts, adapter behavior, broker behavior, state/job handling, hook behavior, generated surfaces, and prompt/schema contracts.

## Architectural Constraints

- **Runtime:** Use Node.js `>=22.0.0` and ESM modules only (`package.json`).
- **Threading:** Main CLI work is single-process/single-event-loop; background execution uses detached Node worker processes; app-server sharing uses a detached broker process (`src/codex-bridge.mjs`, `src/lib/tracked-jobs.mjs`, `src/adapters/codex/broker.mjs`).
- **Transport:** Outbound app-server messages are newline-delimited JSON objects with `id`, `method`, and `params`; do not add a `jsonrpc` field (`src/adapters/codex/protocol.mjs`).
- **Client identity:** Keep `DEFAULT_CLIENT_INFO.name` as `codex_bridge` unless the app-server contract and tests change together (`src/adapters/codex/protocol.mjs`).
- **Backend support:** The active implementation is the Codex adapter. Do not claim support for `aider`, `claude-cli`, `gemini`, or `ollama` until `src/adapters/index.mjs`, tests, setup/auth behavior, command help, and public docs add a real backend together.
- **Plan mode effort:** Plan mode always injects `reasoning.effort = "xhigh"` through `buildCollaborationMode` (`src/lib/runtime-options.mjs:101`).
- **Config precedence:** Preserve the config layer order implemented by `loadConfigLayers` (`src/lib/config.mjs:56`).
- **Global state:** Use workspace-scoped state helpers instead of module-level mutable job state; managed broker, job index, and gate settings live under the resolved state directory (`src/lib/state.mjs`).
- **Session writes:** Append `.events` and `.ndjson` synchronously through `src/lib/session-log.mjs`; do not introduce a competing writer for the same files.
- **Generated outputs:** Do not hand-edit generated runtime files under `skill/scripts/`, `skill/app-server-broker.mjs`, `skill/prompts/`, `skill/schemas/`, `skill/templates/`, `plugin/scripts/`, `plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`, or `plugin/config.yaml`.
- **Plugin commands and agents:** In this checkout, `plugin/commands/` and `plugin/agents/` are the packaged command/agent surfaces. If root `commands/` or `agents/` directories are restored, `esbuild.config.mjs` copies them into `plugin/` and those restored roots become the edit targets.
- **Stop gate:** The Stop review gate is project-scoped and lock-driven; hook decisions must check both lock/setup readiness and workspace state before blocking (`src/codex-bridge.mjs`, `hooks/stop-gate.mjs`).
- **Circular imports:** No circular dependency chain was detected in the static source import pass. Keep adapter-facing imports one-directional: CLI -> adapter registry -> adapter implementation -> shared libs.

## Anti-Patterns

### Editing Generated Runtime Files

**What happens:** A change is made directly in `plugin/scripts/codex-bridge.mjs`, `skill/scripts/codex-bridge.mjs`, `plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`, or `plugin/config.yaml`.
**Why it's wrong:** `npm run build` overwrites these paths from `src/`, `skill/config.yaml`, and configured static assets.
**Do this instead:** Edit `src/codex-bridge.mjs`, `src/adapters/codex/**`, `src/lib/**`, `src/prompts/**`, `src/schemas/**`, `src/templates/**`, `hooks/**`, `plugin/commands/**`, `plugin/agents/**`, or `skill/config.yaml` as appropriate, then run `npm run build`.

### Bypassing `runBridgeTask`

**What happens:** A new task-like command calls `runAppServerTurn` directly and skips session events, question handling, job state, heartbeat, stop-gate review, or auto-pipeline behavior.
**Why it's wrong:** Users lose monitorability, terminal tags, cancellation/result integration, and consistent error envelopes.
**Do this instead:** Route task execution through `runBridgeTask` and `executeTaskRun` in `src/codex-bridge.mjs`; add adapter-specific behavior inside `src/adapters/codex/*.mjs` only when the backend contract changes.

### Adding Command Metadata Without Dispatch

**What happens:** A command appears in help or plugin markdown but has no handler in `SUBCOMMAND_DISPATCH`, or a handler exists without matching metadata and tests.
**Why it's wrong:** JSON help, plugin surface tests, and runtime behavior diverge.
**Do this instead:** Update `COMMANDS`, add the handler, wire `SUBCOMMAND_DISPATCH`, update `plugin/commands/<command>.md` when user-facing, and add/adjust `test/*.test.mjs`.

### Sharing State Outside State Helpers

**What happens:** A background worker writes ad hoc JSON files outside `src/lib/state.mjs`, `src/lib/tracked-jobs.mjs`, `src/lib/session-log.mjs`, or `src/lib/registry.mjs`.
**Why it's wrong:** Status, result, wait, cancel, and orphan pruning cannot see the state consistently.
**Do this instead:** Use `writeJobFile`, `updateState`, `runTrackedJob`, `logEvent`, `logNdjson`, and registry helpers from `src/lib/`.

### Treating Packaged Extra Hooks As Active

**What happens:** Code assumes every file in `plugin/hooks/` is registered.
**Why it's wrong:** Active hook execution is determined by `hooks/hooks.json` and generated `plugin/hooks/hooks.json`; several packaged hook scripts are present but not registered in the active manifest.
**Do this instead:** Update `hooks/hooks.json` and tests when changing active hook behavior.

## Error Handling

**Strategy:** Normalize user-facing and machine-readable errors through `CliError`, error classes, JSON envelopes, terminal session events, and tracked-job failure records.

**Patterns:**
- Throw `CliError` for validation, dependency, configuration, not-found, timeout, conflict, and cancelable precondition failures (`src/lib/cli-errors.mjs`).
- Let `main` catch unhandled errors and emit the normalized envelope with appropriate exit code (`src/codex-bridge.mjs:5738`).
- For background workers, persist failures through `runTrackedJob` and job detail files (`src/lib/tracked-jobs.mjs:144`).
- For long task sessions, emit terminal `ERROR`, `INCOMPLETE`, `PARTIAL`, or `HANDOFF` events instead of relying only on process exit (`src/lib/session-log.mjs`).
- For app-server turn timeouts and interrupts, use adapter capture logic and protocol cancellation rather than killing the process immediately (`src/adapters/codex/codex.mjs`, `src/adapters/codex/protocol.mjs`).

## Cross-Cutting Concerns

**Logging:** Use `src/lib/session-log.mjs` for session streams, `src/lib/tracked-jobs.mjs` for job log/status mirrors, and `src/lib/registry.mjs` for per-task event artifacts.

**Validation:** Use `src/lib/args.mjs` for CLI argument parsing helpers, `src/lib/brief.mjs` for structured brief validation, `src/lib/render.mjs` plus `src/schemas/review-output.schema.json` for review output shape, and tests under `test/*.test.mjs` for surface contracts.

**Authentication:** Codex auth is external to this package and checked through Codex CLI commands in setup/auth-status flows (`src/codex-bridge.mjs`, `src/adapters/codex/codex.mjs`). Official OpenAI Codex plugin presence is detected through `src/lib/official-plugin.mjs` and can suppress the local Stop review gate.

**Process Safety:** Use `src/lib/process.mjs` wrappers for child processes, `src/lib/git.mjs` safe argument arrays for Git, `src/lib/state.mjs` locking for shared state, and `src/lib/broker-lifecycle.mjs` teardown paths for stale broker sessions.

**Build Drift:** Use `npm run build` after changes to source/assets/hook/command/agent/config inputs and rely on `.github/workflows/build.yml` to fail if generated paths drift.

---

*Architecture analysis: 2026-05-02*
