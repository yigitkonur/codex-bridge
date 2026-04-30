# Architecture Research: codex-bridge

**Project:** codex-bridge  
**Domain:** Node 22+ ESM CLI, Codex adapter runtime, app-server broker, Claude plugin/skill bundle  
**Researched:** 2026-04-30  
**Overall confidence:** HIGH. Evidence comes from source, tests, package metadata, build config, hooks config, and CI workflow only. Repository Markdown was not used as evidence.

## Executive Summary

codex-bridge is currently a CLI-first orchestration system with a Codex-specific runtime below it and a partially introduced backend adapter registry beside it. The command dispatcher in `src/codex-bridge.mjs` owns user-facing lifecycle, config resolution, job records, session events, review/task orchestration, background workers, cancellation, results, and merge gates (`src/codex-bridge.mjs:547`, `src/codex-bridge.mjs:2435`, `src/codex-bridge.mjs:3580`, `src/codex-bridge.mjs:5591`). The Codex runtime still calls `src/adapters/codex/codex.mjs` directly for real app-server operations, while `src/adapters/index.mjs` validates and selects backend adapters for the emerging abstraction (`src/adapters/codex/index.mjs:8`, `src/adapters/codex/index.mjs:48`, `src/adapters/index.mjs:10`, `src/adapters/index.mjs:135`).

The system boundary to Codex is newline-delimited JSON over either a spawned `codex app-server` process or a shared local broker. Client requests are sent as `{ id, method, params }` without a `jsonrpc` field (`src/adapters/codex/protocol.mjs:161`, `src/adapters/codex/protocol.mjs:206`). `runAppServerTurn` starts or resumes a thread, builds turn params, attaches optional collaboration mode, sandbox policy, and output schema, then captures streamed notifications until a terminal turn state (`src/adapters/codex/codex.mjs:1232`, `src/adapters/codex/codex.mjs:1263`, `src/adapters/codex/codex.mjs:1295`, `src/adapters/codex/codex.mjs:1332`).

State is split deliberately. Workspace-scoped job state lives under a canonical workspace-root hash with locking and orphan reaping (`src/lib/state.mjs:41`, `src/lib/state.mjs:79`, `src/lib/state.mjs:150`). Session logs are append-only, best-effort `.ndjson` and `.events` files keyed by Codex thread id (`src/lib/session-log.mjs:14`, `src/lib/session-log.mjs:32`, `src/lib/session-log.mjs:47`). Artifact/verdict registry data is separate under `~/.codex-bridge/jobs` unless `CODEX_BRIDGE_REGISTRY` overrides it, and registry writes are intentionally louder than session logs (`src/lib/registry.mjs:51`, `src/lib/registry.mjs:95`, `src/lib/registry.mjs:173`, `src/lib/registry.mjs:196`).

Build and plugin surfaces are architectural outputs, not incidental packaging. `esbuild.config.mjs` builds both legacy `skill/` and canonical `plugin/` runtime bundles, copies authored static assets, and copies root commands/agents/hooks into the plugin layout with path rewrites (`esbuild.config.mjs:21`, `esbuild.config.mjs:36`, `esbuild.config.mjs:65`, `esbuild.config.mjs:77`, `esbuild.config.mjs:107`). CI rebuilds, runs tests, verifies generated bundle drift, and sanity-checks both shipping CLI entry points (`.github/workflows/build.yml:32`, `.github/workflows/build.yml:39`, `.github/workflows/build.yml:53`, `.github/workflows/build.yml:96`).

## Component Boundaries

| Component | Responsibility | Evidence | Phase-planning implication |
|---|---|---|---|
| CLI dispatcher | Parse subcommands, normalize cwd/workspace, trigger update checks, route to handlers, render envelopes, and manage foreground/background lifecycle. | `src/codex-bridge.mjs:547`, `src/codex-bridge.mjs:815`, `src/codex-bridge.mjs:2174`, `src/codex-bridge.mjs:5591` | New user-visible behavior usually starts here, but runtime protocol changes must land below before CLI flags advertise them. |
| Runtime config | Merge hard-coded defaults, install-root config, workspace config, and cwd config; build collaboration mode and sandbox policy. | `src/lib/config.mjs:56`, `src/lib/config.mjs:74`, `src/lib/runtime-options.mjs:1`, `src/lib/runtime-options.mjs:101`, `src/lib/runtime-options.mjs:129` | Config-key phases must update defaults, merge/render behavior, generated config, and tests before command handlers depend on the key. |
| Adapter registry | Validate adapter shape, resolve backend precedence, expose capability gates, and reject unsupported backends as validation errors. | `src/adapters/index.mjs:10`, `src/adapters/index.mjs:44`, `src/adapters/index.mjs:92`, `src/adapters/index.mjs:135`, `test/adapter-registry.test.mjs:139` | Multi-backend phases must not route live commands to an adapter until `dispatch`, `streamEvents`, `getResult`, and `cancel` are real. |
| Codex runtime | Check Codex availability, start/resume threads, send turn/review requests, capture files/commands/plans/reasoning, and translate app-server states into bridge results. | `src/adapters/codex/codex.mjs:58`, `src/adapters/codex/codex.mjs:641`, `src/adapters/codex/codex.mjs:1169`, `src/adapters/codex/codex.mjs:1232` | Runtime behavior phases should be tested at the app-server capture layer, then wired through CLI results/events. |
| Protocol client | Own JSONL request/response mechanics, pending request maps, server request handling, direct process transport, broker transport, and broker fallback. | `src/adapters/codex/protocol.mjs:19`, `src/adapters/codex/protocol.mjs:98`, `src/adapters/codex/protocol.mjs:161`, `src/adapters/codex/protocol.mjs:530`, `test/app-server-client.test.mjs:53` | Protocol changes are high blast radius; preserve request shape, pending cleanup, explicit broker behavior, and saved-broker fallback tests. |
| Broker process | Share one upstream Codex app-server across downstream clients, route notifications/server requests, reject unsafe concurrent turns, allow interrupts during streams, and clean up sockets/pid files. | `src/adapters/codex/broker.mjs:13`, `src/adapters/codex/broker.mjs:276`, `src/adapters/codex/broker.mjs:352`, `src/adapters/codex/broker.mjs:483`, `src/lib/broker-lifecycle.mjs:171` | Broker phases must treat stream ownership and early completion ordering as core correctness, not performance details. |
| Auto-pipeline | After a task turn, capture diff, run native review, auto-fix parseable findings, optionally run completion check, and emit terminal pipeline events. | `src/adapters/codex/pipeline.mjs:36`, `src/adapters/codex/pipeline.mjs:97`, `src/adapters/codex/pipeline.mjs:111`, `src/adapters/codex/pipeline.mjs:184`, `src/adapters/codex/pipeline.mjs:293`, `test/auto-pipeline-turn-watchdog.test.mjs:410` | Pipeline phases depend on task-session stability and must preserve time-budget clamping, failure classification, touched-file reporting, and terminal events. |
| Job/session persistence | Persist queued/running/completed jobs, progress logs, session event streams, pending questions, and failure envelopes. | `src/lib/state.mjs:66`, `src/lib/state.mjs:173`, `src/lib/session-log.mjs:14`, `src/lib/pending-requests.mjs:20`, `src/codex-bridge.mjs:2254` | Background/status/result/wait features must write durable job records before spawning workers and must be resumable after process death. |
| Git/worktree/merge | Resolve review targets, capture diffs, create isolated subagent worktrees, prune on cancel, and fast-forward reviewed branches only after SHA verification. | `src/lib/git.mjs:527`, `src/lib/git.mjs:624`, `src/lib/git.mjs:711`, `src/codex-bridge.mjs:5037` | Worktree and merge phases depend on job registry/verdict data and must keep dirty-tree, SHA drift, and ff-only checks in front of destructive cleanup. |
| Hooks | SessionStart exports bridge session env, SessionEnd prunes orphan jobs, Stop optionally runs a read-only Codex review gate with explicit timeout margins. | `hooks/hooks.json:4`, `hooks/session-lifecycle-hook.mjs:41`, `hooks/session-lifecycle-hook.mjs:46`, `hooks/stop-gate.mjs:372`, `hooks/stop-gate.mjs:465` | Hook phases must be treated as production entry points and verified in generated `plugin/hooks/`, including timeout and fail-open behavior. |
| Build/CI surfaces | Bundle source CLI/broker twice, copy generated surfaces, rewrite plugin runtime paths, and fail CI when committed bundles drift. | `package.json:6`, `esbuild.config.mjs:77`, `.github/workflows/build.yml:39`, `.github/workflows/build.yml:53` | Any source, hook, command, agent, prompt, schema, template, or config surface phase must run build and include generated output. |

## Command Lifecycle

1. A CLI invocation enters `main`, parses a strict subcommand, resolves cwd/workspace, and dispatches through `SUBCOMMAND_DISPATCH` (`src/codex-bridge.mjs:5591`, `src/codex-bridge.mjs:5679`).
2. `task` resolves config and adapter, creates a companion job, optionally creates a worktree, then runs foreground or enqueues background work (`src/codex-bridge.mjs:1975`, `src/codex-bridge.mjs:2015`, `src/codex-bridge.mjs:3580`, `src/codex-bridge.mjs:3809`).
3. `runBridgeTask` constructs the effective prompt, collaboration mode, sandbox, session, heartbeat/checkpoint behavior, server-request handler, and Codex turn options (`src/codex-bridge.mjs:2435`, `src/codex-bridge.mjs:2549`, `src/codex-bridge.mjs:2590`, `src/codex-bridge.mjs:2758`).
4. `executeTaskRun` calls `runAppServerTurn`; `runAppServerTurn` starts or resumes a Codex thread and sends `turn/start`; `captureTurn` owns terminal-state detection, idle timeout, turn timeout, interrupt, and notification routing (`src/codex-bridge.mjs:1828`, `src/adapters/codex/codex.mjs:1232`, `src/adapters/codex/codex.mjs:1295`, `src/adapters/codex/codex.mjs:641`).
5. On terminal task state, the bridge emits plan, incomplete, done, partial, handoff, or error events; when enabled, auto-pipeline runs review/fix/check before final done/incomplete output (`src/codex-bridge.mjs:3398`, `src/codex-bridge.mjs:3419`, `src/adapters/codex/pipeline.mjs:404`, `src/adapters/codex/pipeline.mjs:440`).
6. `status`, `events`, `wait`, `result`, `cancel`, `send`, `respond`, and `summary` are read/control planes over the same job/session/thread files, not separate execution systems (`src/codex-bridge.mjs:3874`, `src/codex-bridge.mjs:4231`, `src/codex-bridge.mjs:4329`, `src/codex-bridge.mjs:4394`, `src/codex-bridge.mjs:4692`, `src/codex-bridge.mjs:5169`, `src/codex-bridge.mjs:5431`, `src/codex-bridge.mjs:5494`).

## Data Flow

### Task Turn

User command -> CLI parser -> config layers -> adapter resolution -> job record -> session files -> Codex app-server client -> Codex thread/turn -> streamed notifications -> capture state -> session `.ndjson`/`.events` -> optional auto-pipeline -> job result/envelope.

Critical constraints:

- Job records are persisted before a detached worker is spawned (`src/codex-bridge.mjs:2254`, `test/bridge-static.test.mjs:134`).
- Turn capture must keep pending app-server requests clean when completion wins the race (`src/adapters/codex/codex.mjs:799`, `test/app-server-abort.test.mjs:93`).
- Idle timeout must not fire while a `requestUserInput` server request is pending (`src/adapters/codex/codex.mjs:660`, `test/codex-capture.test.mjs:77`).
- A turn timeout should interrupt the upstream turn when a turn id is known (`src/adapters/codex/codex.mjs:707`, `test/codex-capture.test.mjs:105`).

### Human Question Flow

Codex server request -> bridge server-request handler -> `{threadId}.pending.json` -> `respond` command writes `{threadId}.response.json` -> worker polls and resolves on the same app-server client connection. The pending store supports one active pending request per thread and discards stale response ids (`src/lib/pending-requests.mjs:7`, `src/lib/pending-requests.mjs:20`, `src/lib/pending-requests.mjs:62`, `src/lib/pending-requests.mjs:88`, `test/app-server-client.test.mjs:76`).

### Broker Flow

CLI/runtime asks `CodexAppServerClient.connect`; absent explicit or saved broker endpoint, it creates a managed broker session; the broker starts one direct upstream app-server and accepts downstream JSONL clients (`src/adapters/codex/protocol.mjs:530`, `src/lib/broker-lifecycle.mjs:171`, `src/adapters/codex/broker.mjs:296`, `src/adapters/codex/broker.mjs:403`). The broker rejects concurrent non-interrupt requests while a stream is active, forwards server requests to the owning downstream socket, and releases stream ownership only after tracked threads complete (`src/adapters/codex/broker.mjs:352`, `src/adapters/codex/broker.mjs:370`, `src/adapters/codex/broker.mjs:483`, `src/adapters/codex/broker.mjs:507`).

### Review And Merge Flow

`review`/`adversarial-review` resolve a Git target, verify there is reviewable content, run a read-only review thread, write review artifacts, and emit terminal review events (`src/codex-bridge.mjs:1573`, `src/adapters/codex/codex.mjs:1169`, `test/bridge-static.test.mjs:151`). `verdict`, `verdicts`, and `merge` use registry verdict data plus Git SHA checks; merge refuses dirty state, stale reviewed SHA, non-ff history, and dirty task worktrees (`src/lib/registry.mjs:173`, `src/lib/git.mjs:747`, `src/lib/git.mjs:778`, `src/lib/git.mjs:807`, `src/codex-bridge.mjs:4898`, `src/codex-bridge.mjs:5037`).

### Generated Surface Flow

Source CLI/broker/assets/hooks/commands/agents -> `npm run build` -> `skill/` and `plugin/` shipping layouts -> CI drift check -> release packaging. The build rewrites plugin-local runtime paths and copies hooks/commands/agents into `plugin/`; CI checks that generated paths exist and that plugin surfaces call `plugin/scripts/codex-bridge.mjs`, not the legacy skill path (`esbuild.config.mjs:65`, `esbuild.config.mjs:107`, `.github/workflows/build.yml:39`, `.github/workflows/build.yml:53`, `.github/workflows/build.yml:80`).

## Build Order And Phase Dependencies

1. **Protocol and capture invariants first.** Anything that changes app-server method names, request envelopes, server requests, notification routing, timeout behavior, or broker fallback must land before CLI behavior depends on it. Tests to extend live in `test/app-server-client.test.mjs`, `test/app-server-abort.test.mjs`, `test/codex-capture.test.mjs`, and broker ordering tests.
2. **Adapter abstraction before multi-backend routing.** The registry already resolves backends and validates capabilities, but the Codex adapter lifecycle methods are placeholders. Future non-Codex backend phases should implement and test lifecycle methods before exposing routing through command handlers (`src/adapters/codex/index.mjs:48`, `test/adapter-registry.test.mjs:139`).
3. **Config before lifecycle.** New runtime knobs must be added to `DEFAULT_CONFIG`, loaded through `loadConfigLayers`, surfaced in CLI render/config output, copied into generated config if user-facing, and tested before task/review/send handlers consume them (`src/lib/runtime-options.mjs:1`, `src/lib/config.mjs:56`).
4. **State/session before background UX.** Background jobs, `status`, `wait`, `events`, `result`, cancellation, and orphan pruning depend on durable job files and session event files. Add state migrations and stale-process behavior before adding higher-level UX around it (`src/lib/state.mjs:173`, `src/codex-bridge.mjs:2254`, `src/codex-bridge.mjs:3874`).
5. **Task lifecycle before auto-pipeline.** Auto-pipeline assumes a valid thread id, session, diff capture, review ability, and stable terminal events. Pipeline feature phases should be downstream of task/session work, and should preserve stage timeout clamping and incomplete/error distinctions (`src/adapters/codex/pipeline.mjs:61`, `src/adapters/codex/pipeline.mjs:275`, `test/auto-pipeline-turn-watchdog.test.mjs:75`).
6. **Worktree and registry before merge automation.** Merge requires task ids, registry verdicts, branch metadata, expected reviewed branch SHA, and clean worktrees. Do not build merge shortcuts before verdict and worktree correctness is proven (`src/lib/git.mjs:527`, `src/lib/registry.mjs:173`, `src/lib/git.mjs:711`).
7. **Hooks after CLI contracts.** Hooks call the bundled CLI and depend on stable `setup`, `status`, and `task` JSON behavior. Stop-gate phases must keep read-only task invocation, timeout layering, and fail-open diagnostics intact (`hooks/stop-gate.mjs:414`, `hooks/stop-gate.mjs:465`, `hooks/stop-gate.mjs:533`).
8. **Generated surfaces last.** After source/hook/config/asset changes, run `npm run build`, inspect generated `skill/` and `plugin/` diffs, then run `npm test`. CI enforces this exact ordering (`package.json:6`, `.github/workflows/build.yml:32`, `.github/workflows/build.yml:35`, `.github/workflows/build.yml:39`).

## Patterns To Follow

### Pattern: Thin CLI, Durable State, Runtime Service Boundary

Keep user commands thin enough to resolve config, build durable job/session records, and call runtime functions. The CLI should not parse Codex stream details directly; `captureTurn` and protocol/broker code own transport semantics (`src/codex-bridge.mjs:1828`, `src/adapters/codex/codex.mjs:641`, `src/adapters/codex/protocol.mjs:98`).

### Pattern: Terminal Events Are Contracts

`events` and `wait` depend on terminal headers such as `[DONE]`, `[ERROR]`, and `[INCOMPLETE]`, with tests guarding anchored matching (`test/bridge-static.test.mjs:40`). New lifecycle paths must emit exactly one terminal state or deliberately mark terminal emission before returning.

### Pattern: Explicit Capability Gates

Backend support is declared through boolean `supports_*` capabilities, and optional lifecycle support requires both a true capability and a handler method (`src/adapters/index.mjs:81`, `src/adapters/index.mjs:201`, `test/adapter-registry.test.mjs:123`). Add capabilities conservatively; false is safer than true without implementation.

### Pattern: Build-Time Drift Detection

Treat generated bundle paths as committed API. CI fails if fresh build output differs or if plugin surfaces point back to the legacy skill runtime path (`.github/workflows/build.yml:39`, `.github/workflows/build.yml:80`).

## Anti-Patterns To Avoid

### Anti-Pattern: Routing Around Capture State

Do not add direct app-server calls in command handlers that bypass `runAppServerTurn`, `runAppServerReview`, or `captureTurn`. That would lose notification buffering, idle/turn timeouts, interrupt behavior, file-change capture, server request activity tracking, and terminal-state normalization.

### Anti-Pattern: Treating Broker Busy As Generic Failure

The broker intentionally rejects concurrent non-interrupt requests while a stream is active (`src/adapters/codex/broker.mjs:483`). Callers should preserve existing fallback/retry semantics in `withAppServer` and avoid parallel turns through one broker unless broker ownership rules are changed and tested (`src/adapters/codex/codex.mjs:860`).

### Anti-Pattern: Hand-Editing Generated Runtime Files

Source and generated surfaces diverge easily because two shipping layouts exist. Edit authored source/config/hooks/commands/agents/assets, then build. Do not patch generated runtime bundles directly (`esbuild.config.mjs:77`, `.github/workflows/build.yml:45`).

### Anti-Pattern: Merging Without Review SHA Binding

`mergeSubagentBranch` explicitly verifies the branch head matches the approved verdict's reviewed SHA before fast-forwarding (`src/lib/git.mjs:757`, `src/lib/git.mjs:778`). Any shortcut that approves by branch name alone reopens stale-review and branch-drift risks.

## Scalability And Concurrency Considerations

| Concern | Current shape | Future pressure | Planning guidance |
|---|---|---|---|
| App-server concurrency | One broker upstream, one active stream/request except interrupt carve-out. | Multiple background jobs may collide on the same broker. | Either keep per-worker direct clients for parallelism or design broker queueing explicitly. |
| Session logs | Synchronous append, best-effort, per thread id. | Long sessions produce large `.events`/`.ndjson` files. | Add rotation/indexing only after preserving append-only monitor compatibility. |
| State file | Workspace-hash scoped state file with lock and max job history. | Many concurrent workers can contend on state lock. | Keep lock hold times short; test stale-lock and orphan-reap behavior before expanding state writes. |
| Registry | Per-task directories with atomic JSON writes for meta/verdict and append-only events. | Cross-process event appends can interleave for large payloads. | Keep registry events small or add locking before relying on them for high-volume telemetry. |
| Generated bundles | Committed generated outputs for two layouts. | More surfaces increase drift risk. | Add new generated assets to build config and CI required-output checks in the same phase. |
| Hooks | Stop hook can block up to the configured ceiling but has internal margins and fail-open crash behavior. | More hooks increase shutdown/session-start blast radius. | Keep hook code dependency-light, timeout-bounded, and diagnosable through stderr/error files. |

## Architecture Constraints For Future Phases

- Preserve Node 22+ ESM assumptions and package scripts as the executable truth (`package.json:5`, `package.json:6`, `package.json:13`).
- Preserve app-server request envelopes without a `jsonrpc` field unless protocol code, broker code, and tests change together (`src/adapters/codex/protocol.mjs:161`, `src/adapters/codex/protocol.mjs:206`).
- Keep `DEFAULT_CLIENT_INFO.name` stable as `codex_bridge` unless upstream app-server compatibility and tests are updated (`src/adapters/codex/protocol.mjs:25`).
- Keep plan mode reasoning forced to `xhigh`; execute effort can be configured (`src/lib/runtime-options.mjs:101`).
- Unknown sandbox overrides must not widen permissions; default mode gets workspace write and all other modes default read-only unless explicitly overridden (`src/lib/runtime-options.mjs:129`).
- Keep state anchored to canonical workspace root while command execution cwd can differ (`src/lib/state.mjs:41`, `src/codex-bridge.mjs:2034`).
- Keep Stop review gate activation project-scoped through `.codex-bridge-stop-review-gate.lock`, with setup owning lock creation/disable semantics and official-plugin suppression checks (`src/codex-bridge.mjs:859`, `src/codex-bridge.mjs:1048`, `hooks/stop-gate.mjs:145`, `hooks/stop-gate.mjs:414`).
- Treat `hooks/hooks.json` and copied `plugin/hooks/` as entry-point config, not documentation (`hooks/hooks.json:26`, `esbuild.config.mjs:120`).
- After source/runtime/hook/surface changes, build and test; CI is built around `npm run build`, `npm test`, generated drift checks, and bundle sanity probes (`.github/workflows/build.yml:32`, `.github/workflows/build.yml:35`, `.github/workflows/build.yml:39`, `.github/workflows/build.yml:96`).

## Research Flags For Roadmap

- **Adapter completion:** HIGH priority before any roadmap phase that promises non-Codex backends or backend-neutral command execution. Current adapter methods throw `NOT_IMPLEMENTED`.
- **Broker concurrency:** HIGH priority if multiple background Codex jobs should share one broker. Current design is a single active stream/request with a narrow interrupt exception.
- **Generated surface expansion:** MEDIUM priority for plugin command/agent/hook work. The build copies and rewrites root surfaces; CI checks generated drift, so phases must budget build-output review time.
- **Hook lifecycle:** MEDIUM priority for session UX. Stop hook timeout and fail-open behavior are deliberate; changing them needs focused tests.
- **Registry locking:** MEDIUM priority if registry events become high-volume or multi-writer critical. Current meta/verdict writes are atomic, but event append locking is not implemented.
- **Legacy skill retirement:** MEDIUM priority. Build still emits both layouts, and broker path resolution supports source, plugin, and legacy skill layouts.

## Sources

- `package.json`
- `esbuild.config.mjs`
- `.github/workflows/build.yml`
- `.github/workflows/release.yml`
- `hooks/hooks.json`
- `hooks/session-lifecycle-hook.mjs`
- `hooks/stop-gate.mjs`
- `src/codex-bridge.mjs`
- `src/adapters/index.mjs`
- `src/adapters/codex/index.mjs`
- `src/adapters/codex/protocol.mjs`
- `src/adapters/codex/codex.mjs`
- `src/adapters/codex/broker.mjs`
- `src/adapters/codex/pipeline.mjs`
- `src/lib/config.mjs`
- `src/lib/runtime-options.mjs`
- `src/lib/state.mjs`
- `src/lib/session-log.mjs`
- `src/lib/pending-requests.mjs`
- `src/lib/broker-lifecycle.mjs`
- `src/lib/git.mjs`
- `src/lib/registry.mjs`
- Relevant tests under `test/` for adapter registry/routing, app-server client/capture/abort, broker lifecycle/ordering, state/session/job-control, auto-pipeline, Git worktrees, registry, plugin surfaces, and static bridge invariants.
