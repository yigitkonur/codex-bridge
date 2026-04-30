# src/lib/AGENTS.md

This folder contains the reusable modules that `src/codex-bridge.mjs` composes
into CLI behavior. Keep rules here tied to the current module code and tests.

## Module Map

| File | Responsibility |
|---|---|
| `../adapters/codex/protocol.mjs` | JSONL app-server client, direct Codex spawn, broker transport, server requests |
| `../adapters/codex/protocol.d.ts` | JSDoc TypeScript surface for app-server shapes |
| `args.mjs` | Strict CLI argument parser and raw string tokenizer |
| `auto-pipeline.mjs` | Post-task diff, review, fix, completion-check pipeline |
| `broker-endpoint.mjs` | Unix socket / Windows pipe endpoint formatting and parsing |
| `broker-lifecycle.mjs` | Shared broker session spawn, readiness, persistence, teardown |
| `cli-errors.mjs` | Exit-code taxonomy, Codex error normalization, retry/handoff envelopes |
| `../adapters/codex/codex.mjs` | Codex app-server turn/review/auth runtime wrapper and notification capture |
| `config.mjs` | Default config, config layering, collaboration mode, sandbox policy |
| `fs.mjs` | Small filesystem helpers and stdin/text sniffing |
| `git.mjs` | Review target resolution and review-context collection |
| `job-control.mjs` | Job lookup/enrichment/status/result/cancel resolution |
| `official-plugin.mjs` *(preview — `feat/plugin-surfaces`)* | Official OpenAI Codex Claude plugin detection. Not present on this branch. |
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

`codex.mjs` (via `src/adapters/codex/protocol.mjs`) is the wire client. Preserve these facts:

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
- Server requests without a custom handler use built-in defaults in
  `AppServerClientBase.handleServerRequest` (`src/adapters/codex/protocol.mjs:152-186`):
  `item/tool/requestUserInput` auto-answers with `{ answers: {} }`,
  `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval` auto-accept (`{ decision: "accept" }`),
  `item/permissions/requestApproval` auto-grants the requested permissions
  for the session, and `mcpServer/elicitation/request` auto-accepts. Only
  unknown methods are rejected with `-32601`. When wiring a custom handler
  for a known method, take care that disabling the auto-answer is the
  intended behavior change.

The `.d.ts` method map should include every app-server method live code sends:
`initialize`, thread start/resume/name/list, `review/start`, turn
start/steer/interrupt, `account/read`, and `config/read`. Current declarations
may lag behind live code — as of this writing `turn/steer`, `account/read`, and
`config/read` are sent on the wire but not yet declared in
`src/adapters/codex/protocol.d.ts`. File `app-server generate-ts` regen issues against
the upstream codex-rs spec when adding new methods; keep this map in sync
before tightening type checking.

## Codex Runtime

`src/adapters/codex/codex.mjs` owns app-server interactions above the transport:

- `runAppServerTurn` starts or resumes a thread, builds text input, attaches
  collaboration mode, sandbox policy, effort, output schema, and optional server
  request handling, then waits for `turn/completed`.
- `runAppServerReview` starts an ephemeral review thread and calls
  `review/start`.
- `captureTurn` tracks root and collaboration-thread notifications, final
  assistant output, plans, review text, reasoning summaries, touched files,
  command executions, idle timeouts, turn timeouts, and process death.
- Completion is preferentially driven by `turn/completed`, but
  `scheduleInferredCompletion` (called from agent-message and drained-subagent
  paths in `src/adapters/codex/codex.mjs`) can also conclude the capture when
  `turn/completed` is missing — final answer text alone is not enough on its
  own, but it is one of several signals the inferred-completion path
  considers.
- Pre-response `turn/started` may establish the turn id before the `turn/start`
  response resolves so buffered `turn/completed` can complete the capture.
- The idle watchdog polls `lastNotificationAt` against `idle_timeout_ms` on a
  `Math.min(5000, idle_timeout_ms)` interval and fires when the gap exceeds
  the budget. `requestUserInput` does not separately suppress the idle timer;
  on long human/orchestrator delays, raise `--question-timeout-ms` and/or
  `--idle-timeout-ms` together so the idle watchdog does not preempt the
  pending question.
- Turn timeout is enforced as `Promise.race([turnPromise, setTimeout(reject)])`
  in `runAppServerTurn` — when the budget elapses, the race rejects and the
  turn is failed without an explicit `turn/interrupt`. The standalone
  `interruptTurn` helper exists for callers who need to interrupt by id, but
  it is not the per-turn-budget path.
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
- `state.json` and `jobs/*.json` live under that state dir. There is no
  `state.lock` file in the current implementation — `src/lib/state.mjs` writes
  `state.json` with a plain `fs.writeFileSync`, with no separate lock file
  and no write-temp-then-rename. Callers running concurrently can race; the
  upstream broker session and the per-launch `tracked-jobs.mjs` writes are the
  only serialization in practice.
- `loadState` is **not** strictly read-only: when it detects orphaned
  `running`/`queued` jobs whose pid is no longer alive (`reapOrphans`), it
  rewrites `state.json` in place via `fs.writeFileSync`. Writers should expect
  that any `loadState` call may flush a reaper update.
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
- `classifyError` does a direct lookup of `err.codexErrorInfo` /
  `err.codex_error_info` against the frozen `CODEX_ERROR_INFO` table —
  there is no `normalizeCodexErrorInfo` helper or string/snake-case
  normalization layer. Variants the upstream sends camelCase are matched
  as-is; unknown values fall through to the generic classifier.
- The per-turn-budget rejection synthesized in `runAppServerTurn`
  (`Turn timed out after <ms>ms`, `src/adapters/codex/codex.mjs:712`) has no
  dedicated retryable branch in `classifyError`; it falls through to the
  generic catch-all and surfaces as `INTERNAL_ERROR` (exit 1). Only the
  idle-watchdog message (`/No events received for \d+s/`) maps to the
  retryable `ClientTimeout` (exit 7) branch — see
  `src/lib/cli-errors.mjs:170-180`. Aligns with the round-4 fix in
  `skill/references/error-recovery.md`.
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

`broker-lifecycle.mjs` starts `src/adapters/codex/broker.mjs` as a detached Node
process (via `resolveBrokerScriptPath()` which probes both bundled and source
locations), stores `broker.json` in the workspace state dir, waits for readiness,
and tears down stale endpoints. `broker-endpoint.mjs` supports `unix:` and
`pipe:` endpoints.

`BROKER_BUSY_RPC_CODE` is `-32001`. Preserve the `turn/interrupt` exception in
the broker so a sibling client can cancel an active stream.

## Plugin Detection And Updates

`official-plugin.mjs` *(preview — lands with sibling branch
`feat/plugin-surfaces`; not present on this branch)* detects the official
OpenAI Codex Claude plugin by parsing `claude plugin list --json`. Status
values are `active`, `absent`, and `unknown`.

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
