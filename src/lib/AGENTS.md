# src/lib/AGENTS.md

This folder contains the reusable modules that `src/codex-bridge.mjs` composes
into CLI behavior. Keep rules here tied to the current module code and tests.

## Module Map

| File | Responsibility |
|---|---|
| `../adapters/codex/protocol.mjs` | JSONL app-server client, direct Codex spawn, broker transport, server requests |
| `../adapters/codex/protocol.d.ts` | JSDoc TypeScript surface for app-server shapes |
| `adversarial-review-prompt.mjs` | Prompt interpolation and orchestrator concern rendering for adversarial reviews |
| `args.mjs` | Strict CLI argument parser and raw string tokenizer |
| `brief.mjs` | Structured brief loading, validation, hashing, and Markdown rendering |
| `broker-endpoint.mjs` | Unix socket / Windows pipe endpoint formatting and parsing |
| `broker-lifecycle.mjs` | Shared broker session spawn, readiness, persistence, teardown |
| `cli-errors.mjs` | Exit-code taxonomy, Codex error normalization, retry/handoff envelopes |
| `../adapters/codex/codex.mjs` | Codex app-server turn/review/auth runtime wrapper and notification capture |
| `config.mjs` | Config schema validation, diagnostics, layering, collaboration mode, sandbox policy |
| `fs.mjs` | Small filesystem helpers and stdin/text sniffing |
| `git.mjs` | Review target resolution and review-context collection |
| `iterate-loop.mjs` | Closed-loop task review / verdict / follow-up orchestration |
| `job-control.mjs` | Job lookup/enrichment/status/result/cancel resolution |
| `official-plugin.mjs` | Official OpenAI Codex Claude plugin detection |
| `pending-requests.mjs` | Disk IPC for `requestUserInput` and `respond` |
| `process.mjs` | Process execution, availability checks, process-tree termination |
| `prompts.mjs` | Prompt template load/interpolation |
| `registry.mjs` | Task artifact registry, metadata, brief, review, verdict, diff, and event files |
| `render.mjs` | Human-readable CLI rendering |
| `review-result.mjs` | Native/adversarial review result normalization and finding validation |
| `runtime-options.mjs` | Hard-coded default config values, effort/model resolution, sandbox construction |
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
- Server requests without a custom handler are rejected with JSON-RPC
  `-32601`. Task paths intentionally install a handler for
  `item/tool/requestUserInput` so questions flow through the disk-backed
  `respond` IPC path; do not assume protocol defaults will auto-answer or
  auto-approve requests.

The `.d.ts` method map should include every app-server method live code sends:
`initialize`, thread start/resume/name/list, `review/start`, turn
start/steer/interrupt, `account/read`, and `config/read`. Keep declarations in
sync when adding methods; do not invent aliases for JSON-RPC method names.

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
  the budget. While `pendingServerRequests > 0`, `captureTurn` marks activity
  and does not idle-timeout the turn; long human/orchestrator delays should
  still raise `--question-timeout-ms` and `--idle-timeout-ms` together.
- Turn timeout sends `turn/interrupt` when `state.turnId` or the thread's
  tracked turn id is known, then waits for an interrupted `turn/completed`
  until the interrupt grace timer fires. If no turn id is known, the timeout
  completes the capture as failed and warns that the upstream turn may continue.
- Auth status uses `account/read` plus `config/read`.
- Availability checks require both `codex --version` and
  `codex app-server --help`.

Do not resolve a turn early while subagent/collaboration notifications are still
active. Do not drop `onServerRequest`, `onTurnStart`, or `onItemCompleted`
plumbing from task paths; session logs and questions depend on them.

## Config

`runtime-options.mjs` is the source of truth for bridge defaults; `config.mjs`
owns schema validation, diagnostics, and layer merging:

- `mode: "plan"`
- `model: "gpt-5.4"`
- `effort: "xhigh"`
- `auto_review: true`
- `post_task_prompt`
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
- `artifact_retention_jobs: 50`
- `artifact_retention_days: 30`
- `redact_secrets: false`
- `prompt_footer`

Config layers merge in this order: defaults, install-root config (`skill/` or
`plugin/`), workspace-root config, then cwd config. Malformed YAML and invalid
values are reported through diagnostics; only schema-known, schema-valid keys
enter the effective runtime config. `buildCollaborationMode("plan", ...)`
always sets `reasoning_effort: "xhigh"`. `buildSandboxPolicy` accepts only
`danger-full-access`, `workspace-write`, and `read-only`.

## State And Jobs

`state.mjs` stores state under a workspace-specific directory:

- The workspace root comes from `resolveWorkspaceRoot`.
- The hash uses `fs.realpathSync.native` when available.
- State root resolution prefers `CODEX_BRIDGE_PLUGIN_DATA`, falls back to
  `CLAUDE_PLUGIN_DATA`, then `os.tmpdir()/codex-companion`.
- `state.json` and `jobs/*.json` live under that state dir. Mutating state
  updates use `state.lock`; `state.json`, `jobs/*.json`, and `broker.json` use
  temp-write + rename persistence. Corrupt `state.json` and job detail files
  are preserved as `.corrupt-<ts>` siblings for diagnosis.
- `loadState` is read-only. It quarantines corrupt state and returns defaults,
  but stale running/queued job reaping is persisted only by writer paths.
- State index pruning keeps terminal jobs to `MAX_JOBS = 50`; the user-facing
  `status --cleanup` command uses `artifact_retention_jobs` and
  `artifact_retention_days` from config to remove terminal job artifacts.

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
`fs.appendFileSync`. Keep event writes synchronous and append-only. When
`redact_secrets` is true, persisted event and NDJSON text is redacted before
write.

Current terminal tags are `DONE`, `ERROR`, `INCOMPLETE`, and `PLAN`.
`events --follow` and `wait` rely on `TERMINAL_TAG_REGEX`; `QUESTION` is
interrupt-class but not terminal. `DEFAULT_MONITOR_EXCLUDE` is `["HEARTBEAT"]`,
so new tags should pass through unless explicitly excluded.

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

`src/adapters/codex/pipeline.mjs` runs after successful task execution when enabled:

1. Capture initial git diff.
2. Optionally run native review.
3. Parse native review text through `parseNativeReviewText`; actionable
   markdown findings drive the fix stage. Unstructured attention without parsed
   findings is reported incomplete without starting a fix turn.
4. Optionally run the completion check with `COMPLETION_CHECK_SCHEMA`.
5. Emit `[DONE]`, `[INCOMPLETE]`, or `[ERROR]`, plus `[PIPELINE:done]` or
   `[PIPELINE:failed]`.

Stage and total timeouts are configurable by caller/config. Keep the pipeline's
read-only completion check read-only.

## Errors And Recovery

`cli-errors.mjs` is the single taxonomy for CLI failures:

- Exit codes: success `0`, crash `1`, usage `2`, not found `3`, auth `4`,
  conflict `5`, validation `6`, transient `7`, partial `8`.
- `classifyError` normalizes `err.codexErrorInfo` / `err.codex_error_info`
  across PascalCase, camelCase, snake_case, and object-shaped variants before
  consulting `CODEX_ERROR_INFO`.
- The per-turn-budget rejection synthesized in `runAppServerTurn`
  (`Turn timed out after <ms>ms`) maps to retryable `TurnTimeout` (exit 7).
  The idle-watchdog message (`/No events received for \d+s/`) maps to
  retryable `ClientTimeout`.
- JSON error envelopes include `error.next_action` when the runtime has an
  explicit recovery move, or a follow-suggestion action when only a suggestion
  is available. Turn failures also include `error.origin` when classified.
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

`broker-lifecycle.mjs` starts the resolved broker script as a detached Node
process, stores `broker.json` in the workspace state dir, waits for readiness,
and tears down stale endpoints. Source mode resolves to
`src/adapters/codex/broker.mjs`; bundled mode resolves to either
`skill/app-server-broker.mjs` or `plugin/scripts/app-server-broker.mjs`.
`broker-endpoint.mjs` supports `unix:` and `pipe:` endpoints.

`BROKER_BUSY_RPC_CODE` is `-32001`. Preserve the `turn/interrupt` exception in
the broker so a sibling client can cancel an active stream.

## Plugin Detection And Updates

`official-plugin.mjs` detects the official OpenAI Codex Claude plugin by
parsing `claude plugin list --json`. Status values are `active`, `absent`, and
`unknown`.

`update-check.mjs` uses `fetch` against
`https://api.github.com/repos/yigitkonur/codex-bridge/releases/latest`, caches
for one hour, and never throws. It does not read GitHub tokens. Apply attempts
are rate-limited with the same cache file.

## Tests To Remember

The regression anchors are:

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

Run `npm test` for any change in this folder and `npm run build` first when the
change affects bundled output. For runtime behavior changes, also verify by
re-running the CLI against an authenticated Codex install when possible.
