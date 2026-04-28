# src/lib/AGENTS.md

This folder contains the reusable modules that `src/codex-bridge.mjs` composes
into CLI behavior. Keep rules here tied to the current module code and tests.

## Module Map

| File | Responsibility |
|---|---|
| `app-server.mjs` | JSONL app-server client, direct Codex spawn, broker transport, server requests |
| `app-server-protocol.d.ts` | JSDoc TypeScript surface for app-server shapes |
| `args.mjs` | Strict CLI argument parser and raw string tokenizer |
| `auto-pipeline.mjs` | Post-task diff, review, fix, completion-check pipeline |
| `broker-endpoint.mjs` | Unix socket / Windows pipe endpoint formatting and parsing |
| `broker-lifecycle.mjs` | Shared broker session spawn, readiness, persistence, teardown |
| `cli-errors.mjs` | Exit-code taxonomy, Codex error normalization, retry/handoff envelopes |
| `codex.mjs` | Codex app-server turn/review/auth runtime wrapper and notification capture |
| `config.mjs` | Default config, config layering, collaboration mode, sandbox policy |
| `fs.mjs` | Small filesystem helpers and stdin/text sniffing |
| `git.mjs` | Review target resolution and review-context collection |
| `job-control.mjs` | Job lookup/enrichment/status/result/cancel resolution |
| `official-plugin.mjs` | Official OpenAI Codex Claude plugin detection |
| `pending-requests.mjs` | Disk IPC for `requestUserInput` and `respond` |
| `process.mjs` | Process execution, availability checks, process-tree termination |
| `prompts.mjs` | Prompt template load/interpolation |
| `render.mjs` | Human-readable CLI rendering |
| `session-log.mjs` | Session artifacts, event blocks, terminal tag constants |
| `state.mjs` | Workspace-scoped persistent state and job files |
| `thread-id.mjs` | UUID thread-id validation |
| `tracked-jobs.mjs` | Job record creation, progress logs, tracked job execution |
| `update-check.mjs` | Anonymous GitHub release check and apply-rate cache |
| `workspace.mjs` | Git-root-or-cwd workspace resolution |

## Protocol And Transport

`app-server.mjs` is the wire client. Preserve these facts:

- Messages are newline-delimited JSON objects. Requests use `{ id, method,
  params }`; notifications use `{ method, params }`; responses use `{ id,
  result }` or `{ id, error }`.
- Do not add a `jsonrpc` property.
- `DEFAULT_CLIENT_INFO` is `{ title: "Codex Bridge", name: "codex_bridge",
  version: "1.0.0" }`.
- `DEFAULT_CAPABILITIES.experimentalApi` is `true`.
- Streaming deltas listed in `optOutNotificationMethods` are deliberately
  suppressed.
- Direct transport spawns `codex app-server`.
- Broker transport connects to `CODEX_COMPANION_APP_SERVER_ENDPOINT` or a saved
  broker session.
- If the broker is busy or unavailable in selected cases, `withAppServer` falls
  back to a direct client.
- Server requests without a handler are rejected with `-32601`; tests pin that
  they are not auto-answered.

The `.d.ts` method map includes every app-server method live code sends:
`initialize`, thread start/resume/name/list, `review/start`, turn
start/steer/interrupt, `account/read`, and `config/read`. Keep this map in sync
before tightening type checking.

## Codex Runtime

`codex.mjs` owns app-server interactions above the transport:

- `runAppServerTurn` starts or resumes a thread, builds text input, attaches
  collaboration mode, sandbox policy, effort, output schema, and optional server
  request handling, then waits for `turn/completed`.
- `runAppServerReview` starts an ephemeral review thread and calls
  `review/start`.
- `captureTurn` tracks root and collaboration-thread notifications, final
  assistant output, plans, review text, reasoning summaries, touched files,
  command executions, idle timeouts, turn timeouts, and process death.
- Completion is based on `turn/completed`; final answer text alone is not a
  terminal signal.
- Pre-response `turn/started` may establish the turn id before the `turn/start`
  response resolves so buffered `turn/completed` can complete the capture.
- Pending server-request handlers suppress idle timeout while waiting for a
  response; do not replace this with one-shot activity marking.
- Turn timeout attempts `turn/interrupt` when a turn id is known, then waits
  for terminal `turn/completed` before resolving unless the interrupt grace
  timer expires.
- Auth status uses `account/read` plus `config/read`.
- Availability checks require both `codex --version` and
  `codex app-server --help`.

Do not resolve a turn early while subagent/collaboration notifications are still
active. Do not drop `onServerRequest`, `onTurnStart`, or `onItemCompleted`
plumbing from task paths; session logs and questions depend on them.

## Config

`config.mjs` is the source of truth for bridge defaults:

- `mode: "plan"`
- `model: "gpt-5.4"`
- `effort: "xhigh"`
- `auto_review: true`
- `allow_questions: true`
- `session_dir: "~/.codex-bridge/sessions"`
- `sandbox_policy: "danger-full-access"`
- `skip_meta_skills: true`
- `command_failure_circuit_breaker: true`
- `idle_timeout_ms: 300000`
- `turn_plan_ms: 1800000`
- `turn_default_ms: 1800000`
- `pipeline_stage_ms: 300000`
- `pipeline_total_ms: 900000`
- `question_answer_ms: 300000`
- `post_task_prompt` and `prompt_footer`

Config layers merge in this order: defaults, skill config, workspace-root
config, cwd config. `buildCollaborationMode("plan", ...)` always sets
`reasoning_effort: "xhigh"`. `buildSandboxPolicy` accepts only
`danger-full-access`, `workspace-write`, and `read-only`; invalid overrides fall
back to mode-derived defaults without widening permissions.

## State And Jobs

`state.mjs` stores state under a workspace-specific directory:

- The workspace root comes from `resolveWorkspaceRoot`.
- The hash uses `fs.realpathSync.native` when available.
- State root resolution reads `CLAUDE_PLUGIN_DATA` (the only env var
  consulted, defined as `PLUGIN_DATA_ENV` at `src/lib/state.mjs:9`) and
  falls back to `os.tmpdir()/codex-companion` when unset.
- `state.json`, `state.lock`, and `jobs/*.json` live under that state dir.
- Writes use a lock file with stale-lock cleanup and atomic state-file rename.
- `loadState` is read-only. Mutating writes reap queued/running jobs whose pid
  no longer exists while holding `state.lock`.
- Job lists are pruned to `MAX_JOBS = 50`.

`tracked-jobs.mjs` writes job detail files and state-index entries. Preserve the
two surfaces so `status`, `result`, `wait`, `events`, and `cancel` can resolve
jobs by id and sometimes by thread id.

`job-control.mjs` is read-side only. It enriches jobs with progress preview,
elapsed/duration, phase inference, session-runtime status, and stop-review-gate
state.

## Session Artifacts

`session-log.mjs` owns session files:

- `<threadId>.events`
- `<threadId>.ndjson`
- `<threadId>.diff`
- `<threadId>.plan.md`
- `<threadId>.review.json`

Only `logEvent` and `logNdjson` append to `.events` and `.ndjson`, and they use
`fs.appendFileSync`. Keep event writes synchronous and append-only.

Current terminal tags are `DONE`, `ERROR`, and `INCOMPLETE`. `events --follow`
and `wait` rely on headers matching those tags. `DEFAULT_MONITOR_EXCLUDE` is
`["HEARTBEAT"]`, so new tags should pass through unless explicitly excluded.

Current event-format helpers include:

- Terminal/result: `formatDoneEvent`, `formatErrorEvent`,
  `formatIncompleteEvent`
- Interactive: `formatQuestionEvent`, `formatConfirmedEvent`, `formatPlanEvent`
- Liveness/progress: `formatHeartbeatEvent`, `formatCheckpointEvent`,
  `formatPipelineEvent`, `formatWarningEvent`, `formatDirectivesEvent`
- Recovery: `formatPartialEvent`, `formatRetryingEvent`, `formatHandoffEvent`
- Extra defined helpers: `formatPhaseEvent`, `formatReviewEvent`

If a new event tag is emitted, update filtering, references, and tests together.

## Questions And IPC

`pending-requests.mjs` bridges a Codex server request and a separate
`respond` CLI invocation by disk files:

- Worker writes a pending request.
- `respond` locates it by request id and writes a response file.
- The worker polls, consumes the response, and resolves the original app-server
  request on the same client connection.

Do not replace this with in-memory state; foreground/background workers and
separate `respond` processes need disk IPC.

## Review Context

`git.mjs` resolves review targets and collects context:

- `--base` always means branch review.
- `--scope working-tree` reviews staged/unstaged/untracked context.
- `--scope branch` detects a default branch.
- `--scope auto` chooses working tree when dirty, otherwise branch.
- Inline diff inclusion is bounded by file count and byte limits.
- Untracked file content is included only when it is text-like and under
  `MAX_UNTRACKED_BYTES`.

Native `review` uses app-server `review/start`. `adversarial-review` builds a
prompt and uses `turn/start` with the JSON schema from `src/schemas`.

## Auto-Pipeline

`auto-pipeline.mjs` runs after successful task execution when enabled:

1. Capture initial git diff.
2. Optionally run native review.
3. Attempt a fix turn only when parsed findings exist. Current native review
   parsing returns no structured findings, so the fix stage is effectively a
   no-op for native review text.
4. Optionally run the completion check with `COMPLETION_CHECK_SCHEMA`.
5. Emit `[DONE]`, `[INCOMPLETE]`, or `[ERROR]`, plus `[PIPELINE:done]` or
   `[PIPELINE:failed]`.

Stage and total timeouts are configurable by caller/config. Keep the pipeline's
read-only completion check read-only.

## Errors And Recovery

`cli-errors.mjs` is the single taxonomy for CLI failures:

- Exit codes: success `0`, crash `1`, usage `2`, not found `3`, auth `4`,
  conflict `5`, validation `6`, transient `7`, partial `8`.
- `normalizeCodexErrorInfo` accepts string and object-shaped variants and maps
  camelCase and upstream snake_case to PascalCase known codes.
- Local `TurnTimeout` errors classify as retryable timeout failures, not
  internal crashes.
- `classifyTurnErrorOrigin` distinguishes idle, upstream compact proxy,
  upstream transport, response-chain loss, upstream auth, upstream invalid
  request, and generic turn failures.
- `UPSTREAM_RETRY_POLICY` currently retries same-thread for transport,
  compact-proxy, and invalid-request origins; response-chain loss is marked
  new-thread; auth has no retry.
- Handoff envelopes include artifacts, partial commit data, prompt information,
  retries, and upstream request ids when available.

Use `CliError` metadata instead of raw `Error` when a handler can classify the
failure.

## Broker Lifecycle

`broker-lifecycle.mjs` starts `src/app-server-broker.mjs` as a detached Node
process, stores `broker.json` in the workspace state dir, waits for readiness,
and tears down stale endpoints. `broker-endpoint.mjs` supports `unix:` and
`pipe:` endpoints.

`BROKER_BUSY_RPC_CODE` is `-32001`. Preserve the `turn/interrupt` exception in
the broker so a sibling client can cancel an active stream.

## Plugin Detection And Updates

`official-plugin.mjs` detects the official OpenAI Codex Claude plugin by parsing
`claude plugin list --json`. Status values are `active`, `absent`, and
`unknown`.

`update-check.mjs` uses `fetch` against
`https://api.github.com/repos/yigitkonur/codex-bridge/releases/latest`, caches
for one hour, and never throws. It does not read GitHub tokens. Apply attempts
are rate-limited with the same cache file.

## Tests To Remember

The test suite ships with `feat/runtime-improvements`; on this branch alone
`package.json` declares only `build` and `dev`, so `npm test` is not yet
runnable. Once that stack lands, these are the regression anchors:

- `test/app-server-client.test.mjs` pins server-request rejection/resolution and
  transport-exit behavior.
- `test/bridge-static.test.mjs` pins broker forwarding/exit handling, anchored
  wait terminal matching, retry thread binding, send-plan behavior, and
  cwd-before-config behavior.
- `test/codex-capture.test.mjs` pins pre-response terminal notifications and
  pending server-request idle suppression.
- `test/cli-errors.test.mjs` pins Codex error normalization and timeout
  classification.
- `test/official-plugin.test.mjs` pins official plugin detection.
- `test/plugin-surfaces.test.mjs` pins command coverage, metadata alignment,
  hooks, setup review-gate ownership, and runner thinness.
- `test/session-log.test.mjs` pins cwd-aware event action commands.
- `test/state.test.mjs` pins concurrent state writes, locked reaping,
  corruption handling, and plugin-data precedence.

Once the test suite is wired, run `npm test` for any change in this folder and
`npm run build` first when the change affects bundled output. Until then,
verify behaviour by re-running the CLI against an authenticated Codex install.
