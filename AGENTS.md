# AGENTS.md — codex-bridge

> This is the canonical instruction file for agents working in this repository. `CLAUDE.md` is a symlink to this file. Do not duplicate it; edit here.

## What this repo is

`codex-bridge` is a **Claude Code skill** (`skill/SKILL.md`) whose payload is a single Node.js CLI (`src/codex-bridge.mjs`) that speaks JSON-RPC to the OpenAI **Codex app-server**. Claude orchestrates; the bridge writes events; the Monitor tool tails an `.events` file and self-terminates on terminal tags.

Codex upstream, version-pinned reference points:
- Protocol spec: `codex-rs/app-server/README.md` + `codex-rs/app-server-protocol/src/protocol/common.rs` + `codex-rs/app-server/src/error_code.rs`
- Reference client: `codex-rs/app-server-client/src/{lib.rs,remote.rs}` (enum `AppServerClient { InProcess, Remote }`)
- Test suite we must not regress against: `codex-rs/app-server/tests/suite/v2/*`

Every protocol claim in `src/lib/AGENTS.md` cites back to those paths. When Codex updates, regenerate types via `codex app-server generate-ts --experimental` and diff against `src/lib/app-server-protocol.d.ts`.

## Commands

| Purpose | Command | Notes |
|---|---|---|
| Build the skill bundle | `npm run build` | esbuild `src/codex-bridge.mjs` → `skill/scripts/codex-bridge.mjs` + copies prompts/schemas/templates into `skill/`. Required after every `src/` change. |
| Run the dev entry | `npm run dev` | `node src/codex-bridge.mjs` — unbundled; useful for printing usage. |
| Toolchain self-check | `node src/codex-bridge.mjs setup --json` | Verifies Node, npm, `codex` CLI, auth, broker runtime. |
| Smoke a task locally | `node src/codex-bridge.mjs task --write "<prompt>"` | Requires `codex` installed and authenticated. |

**There is no test runner.** `test-gherkin/*.feature` are behavioral specs, not runnable (no `cucumber-js` / `vitest-cucumber` in `package.json`). See `test-gherkin/AGENTS.md`. Verify changes by running the CLI against a real Codex install and reading the specs.

## Runtime requirements

- **Node ≥22** (`package.json` engines). ESM only (`.mjs`).
- **Codex CLI** on `$PATH`, authenticated: `npm i -g @openai/codex && codex login`.
- **macOS / Linux**: broker uses unix sockets. Windows would use named pipes (code supports it via `src/lib/broker-endpoint.mjs`, but not a primary target).

## Architecture in one paragraph

`src/codex-bridge.mjs` is a multi-subcommand CLI dispatcher. Each subcommand parses its args (`src/lib/args.mjs`), resolves workspace vs. cwd (`src/lib/workspace.mjs`), builds a job record (`src/lib/tracked-jobs.mjs` + `src/lib/state.mjs`), and calls into the **bridge layer** (`runBridgeTask`) which merges config (`src/lib/config.mjs`), developer-instruction templates (`src/templates/`), and then delegates to the **Codex layer** (`src/lib/codex.mjs` → `src/lib/app-server.mjs`) speaking JSON-RPC over a unix-socket broker (`src/lib/broker-lifecycle.mjs`, `src/lib/broker-endpoint.mjs`, `src/app-server-broker.mjs`). Results flow back through `src/lib/session-log.mjs` (up to five artifacts per thread: `.events`, `.ndjson`, `.diff`, `.plan.md`, `.review.json`) and `src/lib/auto-pipeline.mjs` (review → fix → completion check, silent). `src/lib/render.mjs` turns snapshots into markdown for CLI output. `src/lib/pending-requests.mjs` bridges the worker connection and a separate `respond` CLI invocation via disk files.

Deeper per-layer detail lives in `src/lib/AGENTS.md`. Folder-local guidance lives in each folder's `AGENTS.md`.

## Repository layout

```
codex-bridge/
├── AGENTS.md                    # this file
├── REVIEW.md                    # review-time rules
├── package.json                 # ESM, Node 22+, esbuild + js-yaml devDeps
├── esbuild.config.mjs           # bundles src/codex-bridge.mjs → skill/scripts/
├── src/                         # authored source
│   ├── AGENTS.md                # src/ overview, handler layer, codex-bridge.mjs
│   ├── codex-bridge.mjs         # CLI entry + per-subcommand handlers
│   ├── app-server-broker.mjs    # standalone socket multiplexer (alt entry)
│   ├── lib/                     # library modules
│   │   └── AGENTS.md            # per-module brief + protocol invariants
│   ├── prompts/AGENTS.md        # adversarial-review.md authoring rules
│   ├── schemas/AGENTS.md        # review-output.schema.json contract
│   └── templates/AGENTS.md      # plan-enforcement vs execute-instructions
├── skill/                       # the skill bundle — shipped via `npx skills add`
│   ├── AGENTS.md                # authored vs generated, references index
│   ├── SKILL.md                 # user-facing skill doc (authored)
│   ├── config.yaml              # user-facing defaults (authored)
│   ├── references/*.md          # end-user reference docs (authored)
│   ├── scripts/codex-bridge.mjs # ← generated, COMMITTED (CI enforces freshness)
│   ├── app-server-broker.mjs    # ← generated, COMMITTED
│   ├── prompts/ schemas/ templates/   # ← generated, COMMITTED
├── .claude-plugin/plugin.json   # declares ./skill for skills.sh / Claude plugin discovery
└── test-gherkin/                # behavioral specs, not runnable tests
    └── AGENTS.md
```

## Cross-cutting conventions

1. **Edit `src/`, then `npm run build`, then commit both the source and the regenerated bundle.** `skill/scripts/*`, `skill/app-server-broker.mjs`, `skill/prompts/*`, `skill/schemas/*`, `skill/templates/*` are build outputs — **committed to git** so `npx skills add yigitkonur/codex-bridge` works without a build step on the user's machine. CI verifies the committed bundle matches a fresh build (see `.github/workflows/build.yml`). `skill/SKILL.md`, `skill/config.yaml`, and `skill/references/**` are hand-authored.
2. **Two path roots.** `ROOT_DIR` in `src/codex-bridge.mjs:97-103` detects source vs. bundled layout. Any new bundled asset must be added to `esbuild.config.mjs`'s `copies` array AND referenced through `ROOT_DIR`.
3. **`workspaceRoot` ≠ `cwd`.** `state.mjs` hashes off the canonical workspace root (`fs.realpathSync.native` — stable across symlink layouts). Job files, logs, and the broker session are workspace-scoped; git operations and the Codex spawn environment use `cwd`. Don't cross the streams.
4. **Session artifacts are append-only.** `src/lib/session-log.mjs`'s `appendFileSync` is the only writer to `.events` and `.ndjson`. Adding async writers will interleave lines.
5. **No `"jsonrpc":"2.0"` on the wire.** The Codex app-server spec explicitly omits it (`codex-rs/app-server/README.md` → "Protocol"). Any JSON-RPC parser that rejects missing `jsonrpc` will break the transport. Our client in `src/lib/app-server.mjs` is already compliant.
6. **`DEFAULT_CLIENT_INFO.name = "codex_bridge"` (`src/lib/app-server.mjs:25`) is load-bearing.** The upstream server uses it as the HTTP `originator` header (tested in `codex-rs/app-server/tests/suite/v2/initialize.rs`). ASCII only; no CR/LF/colons. Changing it breaks broker session identification and upstream model routing.
7. **Plan mode forces `effort: "xhigh"` regardless of config.** `src/lib/config.mjs` at `buildCollaborationMode("plan", ...)`. This is intentional (deep reasoning for planning) and tested in `test-gherkin/01-task-lifecycle.feature:27`.
8. **Don't guess method names.** Every JSON-RPC method sent on the wire must match the Rust `protocol/common.rs` serde-renamed name exactly. See `src/lib/AGENTS.md` for the full list.

## Environment variables

| Var | Read by | Purpose |
|---|---|---|
| `CLAUDE_PLUGIN_DATA` | `src/lib/state.mjs:9` | State/job root directory. Falls back to `os.tmpdir()/codex-companion`. |
| `CODEX_COMPANION_APP_SERVER_ENDPOINT` | `src/lib/app-server.mjs:19` | Broker socket endpoint (unix or pipe URI). Usually managed by `broker-lifecycle.mjs`. |
| `CODEX_COMPANION_APP_SERVER_PID_FILE` | `src/lib/broker-lifecycle.mjs:11` | Broker PID file path (informational, for diagnostics). |
| `CODEX_COMPANION_APP_SERVER_LOG_FILE` | `src/lib/broker-lifecycle.mjs:12` | Broker stdout/stderr log path. |
| `CODEX_COMPANION_SESSION_ID` | `src/lib/tracked-jobs.mjs:6` (`SESSION_ID_ENV`) | Scopes job filtering to the current Claude session. |
| `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` | upstream server | Overrides `ClientInfo.name`-based originator; tested upstream. Do not set unless debugging. |

## What to do when making a change

- **New subcommand** → handler in `src/codex-bridge.mjs`, wire into the `main()` switch, extend `printUsage()`, add coverage in `test-gherkin/07-cli-commands.feature`.
- **New event tag** → format helper in `src/lib/session-log.mjs`, add to `skill/references/notification-format.md`, update `test-gherkin/04-notifications-and-events.feature`, update `REVIEW.md` if the tag carries structured data.
- **New bundled asset** → path in `esbuild.config.mjs` `copies`, update `.gitignore`, reference through `ROOT_DIR` in `codex-bridge.mjs`.
- **Protocol change upstream** → regenerate `src/lib/app-server-protocol.d.ts` (`codex app-server generate-ts --experimental --out <dir>`), audit diff against `src/lib/app-server.mjs` and `src/lib/codex.mjs`, update `src/lib/AGENTS.md` invariants.
- **Config key** → add to `DEFAULT_CONFIG` in `src/lib/config.mjs`, document in `skill/config.yaml` (with comment) and `skill/references/config-reference.md`, add a scenario in `test-gherkin/08-config-system.feature`.

## Where to look next

| Need | Read |
|---|---|
| Per-subcommand handler shape or add a new one | `src/AGENTS.md` |
| Module-level behavior, protocol invariants, error codes | `src/lib/AGENTS.md` |
| Editing the adversarial review prompt | `src/prompts/AGENTS.md` |
| Editing the output schema | `src/schemas/AGENTS.md` |
| Editing plan/execute developer instructions | `src/templates/AGENTS.md` |
| Editing user-facing skill docs | `skill/AGENTS.md` |
| Adding or modifying Gherkin specs | `test-gherkin/AGENTS.md` |
| What reviewers should flag | `REVIEW.md` |

## Unknowns flagged during discovery

- No test runner is configured. Gherkin specs are not executed automatically; there may or may not be an external CI pipeline. Treat them as behavioral contracts regardless.
- `DEFAULT_IN_PROCESS_CHANNEL_CAPACITY` in the upstream Rust reference client is re-exported but its numeric value is defined in the `codex-app-server` crate; pick a sensible JS default (our client uses unbounded — see `src/lib/AGENTS.md` drift notes).
- `src/app-server-broker.mjs` is a standalone process entry, not imported by any module. Its exact invocation path (directly by users, or via a plugin harness) is not documented inside the repo.
