# src/AGENTS.md

This folder contains the authored runtime source. Build outputs live under
`skill/` and `plugin/`; do not edit generated bundle files to change behavior.

## Files And Folders

| Path | Role |
|---|---|
| `codex-bridge.mjs` | Main CLI entry point and orchestration layer |
| `adapters/codex/broker.mjs` | Standalone shared Codex app-server broker process |
| `adapters/codex/` | Codex protocol, turn/review capture, broker, and pipeline adapter code |
| `lib/` | Reusable client, state, config, git, session-log, render, update, and error modules |
| `prompts/` | Authored prompt source copied to bundled layouts |
| `schemas/` | Authored JSON schema source copied to bundled layouts |
| `templates/` | Authored developer-instruction templates copied to bundled layouts |

## `codex-bridge.mjs`

The CLI uses a single file for command metadata, parsing, handlers, and task
orchestration.

Important structures:

- `COMMANDS` is the displayed help and machine-readable help source for public
  subcommands.
- `SUBCOMMAND_DISPATCH` is the actual handler map.
- `parseCommandInput` adds global `-C/--cwd`, `-h/--help`, and `-j/--json`
  behavior through `src/lib/args.mjs`.
- `ROOT_DIR` detects source layout vs. bundled skill/plugin layout. Any new bundled
  asset must be reachable through this root.
- `runBridgeTask` is the integration layer for tasks: config merge, prompt
  decoration, developer instructions, sandbox policy, server-request handling,
  heartbeats/checkpoints, retries, session logging, and auto-pipeline.

Current public subcommands are visible with:

```bash
node src/codex-bridge.mjs --help
```

The implementation also has internal helpers such as `task-worker` and
`task-resume-candidate`; only expose a command through plugin docs when it is
intended for users.

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
- For user-facing commands, update `COMMANDS`, `SUBCOMMAND_DISPATCH`, skill
  references, and tests together. Once `feat/plugin-surfaces` lands, also
  update `commands/*.md`.

## Task Flow

`runBridgeTask` currently:

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
- Runs the auto-pipeline only when `--no-pipeline` is not set and at least one
  configured stage is enabled (`auto_review` or `post_task_prompt`).

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
