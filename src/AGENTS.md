# src/AGENTS.md

This folder contains the authored runtime source. Build outputs live under
`skill/` and `plugin/`; do not edit generated bundle files to change behavior.

## Files And Folders

| Path | Role |
|---|---|
| `codex-bridge.mjs` | Thin CLI entry point: usage, dispatch table, crash trap, and `main()` |
| `adapters/codex/broker.mjs` | Standalone shared Codex app-server broker process |
| `adapters/codex/` | Codex protocol, turn/review capture, broker, and pipeline adapter code |
| `handlers/` | Command handlers grouped by domain: meta, task, review, inspect, registry |
| `lib/` | Reusable runtime, parser, state, config, git, session-log, render, update, and error modules |
| `prompts/` | Authored prompt source copied to bundled layouts |
| `schemas/` | Authored JSON schema source copied to bundled layouts |
| `templates/` | Authored developer-instruction templates copied to bundled layouts |

For adapter/backend facts, read `.planning/codebase/ADAPTERS.md` after checking
the source. The active runtime is Codex-only unless `src/adapters/index.mjs`,
tests, command help, setup/auth behavior, and public docs are updated together.

## `codex-bridge.mjs`

The CLI entrypoint stays intentionally thin. It owns process-level concerns and
delegates command behavior to `src/handlers/` and shared runtime behavior to
`src/lib/`.

Important structures:

- `COMMANDS` is imported from `src/commands-meta.mjs` and is the displayed help
  and machine-readable help source for public subcommands.
- `SUBCOMMAND_DISPATCH` is the actual handler map.
- `maybeTriggerAutoApply` is imported from `src/lib/update-check.mjs` and runs
  before handler dispatch.
- `printUsage`, `printSubcommandUsage`, SIGPIPE/EPIPE guards, the crash trap,
  and `main()` remain local to the entrypoint.
- Path constants such as `ROOT_DIR`, `SCRIPT_DIR`, and `SCRIPT_PATH` come from
  `src/lib/runtime-paths.mjs`; do not recompute `import.meta.url` in handlers.

Current public subcommands are visible with:

```bash
node src/codex-bridge.mjs --help
```

The implementation also has internal helpers such as `task-worker` and
`task-resume-candidate`; only expose a command through plugin docs when it is
intended for users.

## Module Boundaries

Current runtime ownership:

- `src/commands-meta.mjs` defines command metadata, global flag help, and exit
  code help.
- `src/handlers/meta.mjs` handles setup, version, update, config, auth, and
  machine-readable help data.
- `src/handlers/task.mjs` handles task execution, background workers, send,
  steer, respond, and cancel.
- `src/handlers/review.mjs` handles native review and adversarial review.
- `src/handlers/inspect.mjs` handles read-only status/result/wait/events and
  task artifact inspection.
- `src/handlers/registry.mjs` handles merge, verdict, verdicts, and iterate.
- `src/lib/task-runtime.mjs` owns `runBridgeTask`, task/review execution
  runtimes, background launch helpers, and task-runtime-only helper functions.
- `src/lib/handler-utils.mjs` owns shared command argument/cwd/prompt helpers
  used by multiple handler groups.

## Handler Conventions

When adding or changing a handler:

- Parse only declared flags with `parseCommandInput`.
- Resolve cwd before loading config when behavior depends on the caller's
  project.
- Use `resolveWorkspaceRoot` for state/job identity and cwd for git/Codex
  execution.
- Normalize model/effort through existing helpers.
- Emit success through `emitSuccess` and failures through `emitError` or
  `CliError` subclasses.
- Use existing job helpers so `status`, `result`, `wait`, `events`, and
  `cancel` keep working.
- For user-facing commands, update `COMMANDS`, `SUBCOMMAND_DISPATCH`,
  `plugin/commands/*.md`, skill references, and tests together.
- If a helper is called by two or more handler groups, promote it to `src/lib/`
  instead of duplicating it between handler files.

## Task Flow

`src/lib/task-runtime.mjs` exports `runBridgeTask`. It currently:

- Loads config with `getBridgeConfig(cwd, workspaceRoot)`.
- Applies `skip_meta_skills` and `prompt_footer` to the prompt.
- Uses `plan` mode unless overridden or resuming.
- Injects `plan-enforcement.md` or `execute-instructions.md` as developer
  instructions.
- Resolves sandbox through `buildSandboxPolicy`; configured
  `sandbox_policy` wins over mode-derived defaults.
- Handles `item/tool/requestUserInput` by writing a pending request to disk and
  waiting for `respond`.
- Writes `TURN_PARAMS`, `DIRECTIVES`, item-completion NDJSON, heartbeats,
  checkpoints, terminal events, partial/handoff data, and pipeline events.
- Keeps the diff-reporting stage for `--no-pipeline` runs while skipping
  review/fix/check, and reports write-mode no-op runs as incomplete.

Do not bypass `runBridgeTask` from task paths. `task-worker` intentionally calls
it so foreground and background runs produce the same session artifacts.

## Broker Entry

`src/adapters/codex/broker.mjs` serves one shared Codex app-server connection. It:

- Accepts `serve --endpoint <value> [--cwd <path>] [--pid-file <path>]`.
- Handles newline-delimited JSON messages.
- Owns streaming request exclusivity for `turn/start`, `review/start`, and
  `thread/compact/start`.
- Allows `turn/interrupt` from a different socket during an active stream.
- Routes server-side notifications to the active downstream client via
  `appClient.setNotificationHandler(routeNotification)`.
- Routes server-initiated requests through
  `appClient.setServerRequestHandler(routeServerRequest)`. `routeServerRequest`
  selects the active downstream request or stream socket, records the upstream
  request in `pendingServerRequests`, forwards `{ id, method, params }` to that
  socket, and later routes the downstream `{ id, result|error }` back through
  `resolveServerRequest` or `rejectServerRequest`. If no active downstream
  client exists, the downstream socket closes before answering, or the forward
  write fails, the broker rejects the upstream request with a JSON-RPC error.
- Removes unix sockets and pid files on shutdown.

Any broker change needs `npm test`; `test/bridge-static.test.mjs` and
`test/app-server-client.test.mjs` pin several request/response invariants. For
runtime behavior changes, also re-run the CLI against an authenticated Codex
install when possible.

## Build Rules

After any source change in this folder, run `npm run build` and confirm the
generated `skill/` and `plugin/` outputs match the source change. Also run
`npm test`:

```bash
npm run build
npm test
```

For AGENTS-only edits, re-read the cited source against the new wording.

## Common Mistakes

- Do not update generated `skill/` or `plugin/` bundle files directly.
- Do not add a CLI flag to help text without adding it to the handler parser.
- Do not add a handler without `SUBCOMMAND_DISPATCH`.
- Do not assume static tests cover real Codex app-server round trips.
- Do not resurrect references to absent behavioral-spec directories as required
  workflow unless the directories and runnable process exist in the working tree.
