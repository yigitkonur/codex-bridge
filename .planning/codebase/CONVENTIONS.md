---
last_mapped_commit: 6b3a78a98eb5396798d0ed2ee3d8f7451f204652
---

# Coding Conventions

**Analysis Date:** 2026-05-02

## Naming Patterns

**Files:**
- Use ESM `.mjs` for runtime JavaScript. Core files include `src/codex-bridge.mjs`, `src/lib/state.mjs`, `src/lib/cli-errors.mjs`, `src/adapters/codex/protocol.mjs`, and `hooks/stop-gate.mjs`.
- Use lower-kebab or short domain names for source files: `src/lib/broker-lifecycle.mjs`, `src/lib/pending-requests.mjs`, `src/adapters/codex/pipeline.mjs`, `scripts/baseline-contracts.mjs`.
- Use `.test.mjs` under `test/` for tests: `test/adapter-routing.test.mjs`, `test/plugin-surfaces.test.mjs`, `test/bridge-static.test.mjs`.
- Use lower-kebab JSON/schema names for contract files: `src/schemas/review-output.schema.json`, `plugin/schemas/review-output.schema.json`.
- Generated bundle targets keep stable install-layout names: `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs`, `skill/app-server-broker.mjs`, `plugin/scripts/app-server-broker.mjs`.

**Functions:**
- Use lower camelCase verbs for functions: `loadConfigLayers` in `src/lib/config.mjs`, `resolveAdapterForRuntime` in `src/adapters/index.mjs`, `captureTurn` in `src/adapters/codex/codex.mjs`, `writeJsonFileAtomic` in `src/lib/state.mjs`.
- Use action prefixes consistently:
  - `build*` for structured payloads or rendered components: `buildErrorEnvelope` in `src/lib/cli-errors.mjs`, `buildCapabilities` in `src/adapters/codex/index.mjs`, `buildBaselineContracts` in `scripts/baseline-contracts.mjs`.
  - `resolve*` for path, config, adapter, and job lookup: `resolveStateDir` in `src/lib/state.mjs`, `resolveReviewTarget` in `src/lib/git.mjs`, `resolveCommandCwd` in `src/codex-bridge.mjs`.
  - `parse*` for string or CLI parsing: `parseArgs` in `src/lib/args.mjs`, `parseStructuredOutput` in `src/adapters/codex/codex.mjs`, `parseBrokerEndpoint` in `src/lib/broker-endpoint.mjs`.
  - `format*` and `render*` for display output: `formatDoneEvent` in `src/lib/session-log.mjs`, `renderStatusReport` in `src/lib/render.mjs`.
  - `handle*` for CLI subcommand handlers: `handleTask`, `handleEvents`, `handleVerdict`, and `handleMerge` in `src/codex-bridge.mjs`.
- Keep test-only reset hooks visibly test-only with leading underscores: `_resetAdapterCache` in `src/adapters/index.mjs`, `_setCodexAdapterRuntimeForTest` in `src/adapters/codex/index.mjs`.

**Variables:**
- Use lower camelCase for local variables and object fields inside JS: `workspaceRoot`, `sessionDir`, `threadId`, `startedAt`, `adapterCapabilities` in `src/codex-bridge.mjs` and `src/lib/job-control.mjs`.
- Use SCREAMING_SNAKE_CASE for constants and environment variable names: `DEFAULT_CONFIG` in `src/lib/runtime-options.mjs`, `BACKEND_ENV_VAR` in `src/adapters/index.mjs`, `CODEX_BRIDGE_PLUGIN_DATA` handling in `src/lib/state.mjs`.
- Preserve established public field casing instead of normalizing it during feature work. CLI envelopes use fields such as `schema_version` and `reviewGateLockPath` in `src/lib/cli-errors.mjs` and `src/codex-bridge.mjs`; config and registry files use snake_case keys such as `default_backend`, `adapter_routing`, `sandbox_policy`, and `task_id` in `src/lib/runtime-options.mjs`, `src/lib/registry.mjs`, and `skill/config.yaml`.
- Boolean helpers use `is*`, `has*`, `should*`, or explicit state names: `isThreadId` in `src/lib/thread-id.mjs`, `isActiveJob` in `src/lib/state.mjs`, `shouldAttemptApply` in `src/lib/update-check.mjs`, `hasLegacyStopReviewGateIntent` in `hooks/stop-gate.mjs`.

**Types:**
- Use PascalCase for classes and JSDoc typedefs: `CliError` in `src/lib/cli-errors.mjs`, `AdapterError` in `src/adapters/index.mjs`, `RegistryReadError` in `src/lib/registry.mjs`, `AppServerClientBase` and `CodexAppServerClient` in `src/adapters/codex/protocol.mjs`.
- Use `Object.freeze(...)` for enum-like maps and immutable contracts: `ExitCode` in `src/lib/cli-errors.mjs`, `COMMANDS` and `SUBCOMMAND_DISPATCH` in `src/codex-bridge.mjs`, `GENERATED_SURFACES` in `scripts/baseline-contracts.mjs`.

## Code Style

**Formatting:**
- Use semicolons. Runtime files such as `src/lib/process.mjs`, `src/lib/state.mjs`, `src/adapters/index.mjs`, and `esbuild.config.mjs` terminate imports, declarations, and calls with semicolons.
- Use double quotes for JS strings by default. Single quotes appear mainly for embedded shell snippets or quote-sensitive test strings in `test/pre-tool-bash-hook.test.mjs`, `test/git-worktree.test.mjs`, and `src/lib/session-log.mjs`.
- Use two-space indentation for blocks, object literals, and test bodies. Match local indentation in large existing files such as `src/codex-bridge.mjs` instead of reformatting unrelated code.
- Use trailing commas in multiline imports, arrays, objects, and function calls when the surrounding file already does so, as in `src/adapters/codex/index.mjs`, `src/lib/runtime-options.mjs`, and `test/adapter-registry.test.mjs`.
- Keep runtime source ESM-only. Import built-ins with `node:` specifiers, for example `node:fs`, `node:path`, `node:child_process`, and `node:test` in `src/lib/process.mjs` and `test/baseline-contracts.test.mjs`.
- Prefer structured APIs over shell strings. `src/lib/process.mjs` wraps `spawnSync(command, args, ...)`, and `src/lib/git.mjs` passes git arguments as arrays through `runCommand` and `runCommandChecked`.
- Use synchronous filesystem writes for bridge state, registry, session logs, generated files, hooks, and test fixtures when the code needs deterministic ordering: `src/lib/state.mjs`, `src/lib/session-log.mjs`, `src/lib/registry.mjs`, `esbuild.config.mjs`, and `test/plugin-surfaces.test.mjs`.

**Linting:**
- Not detected. There is no ESLint, Prettier, Biome, Jest, Vitest, or TypeScript compiler config in the repository root.
- The enforced static quality gate is command-based, not linter-based:
  - `npm run verify:static` in `package.json` runs `npm run build`, `npm test`, and `npm run baseline:contracts -- --check`.
  - `.github/workflows/build.yml` runs `npm ci`, `npm run build`, `npm test`, generated bundle drift checks, output existence checks, and JSON-envelope sanity probes.
  - `scripts/baseline-contracts.mjs` verifies generated surfaces, command coverage metadata, and JSON envelope probe expectations.

## Import Organization

**Order:**
1. Node built-ins with `node:` specifiers, as in `src/lib/state.mjs`, `src/lib/git.mjs`, `src/adapters/codex/protocol.mjs`, and `test/plugin-surfaces.test.mjs`.
2. External package imports, as in `esbuild.config.mjs` (`esbuild`) and `src/lib/config.mjs` (`js-yaml`).
3. A blank line before relative local imports, as in `src/lib/git.mjs`, `src/adapters/index.mjs`, and `src/codex-bridge.mjs`.
4. Relative local imports ending in `.mjs`; JSON imports use `with { type: "json" }` where needed, as in `src/codex-bridge.mjs`.

**Path Aliases:**
- Not detected. Use relative paths such as `../src/lib/state.mjs`, `./cli-errors.mjs`, and `../../lib/session-log.mjs`.
- Generated layouts are located through runtime root detection instead of aliases. `src/codex-bridge.mjs` computes `ROOT_DIR`; `src/lib/broker-lifecycle.mjs` resolves source, `skill/`, and `plugin/` broker script paths.

## Error Handling

**Patterns:**
- CLI-facing errors must flow through `CliError`, factory helpers, `classifyError`, `buildErrorEnvelope`, and `emitError` in `src/lib/cli-errors.mjs`.
- CLI handlers in `src/codex-bridge.mjs` should emit successful responses with `emitSuccess` and error responses with `emitError`; do not hand-roll JSON envelopes in new command handlers.
- Use semantic error classes and codes for user-facing failures. Examples include `INVALID_THREAD_ID` in `src/lib/cli-errors.mjs`, `BACKEND_INCAPABLE` in `src/adapters/index.mjs`, `PROMPT_FILE_NOT_FOUND` in `src/codex-bridge.mjs`, and `DEFAULT_BRANCH_NOT_FOUND` in `src/lib/git.mjs`.
- Low-level module contract violations use standard `Error` or `TypeError`, as in `src/lib/registry.mjs`, `src/lib/broker-endpoint.mjs`, and `src/lib/prompts.mjs`.
- Adapter selection errors use `AdapterError` in `src/adapters/index.mjs` and are classified as validation errors by `src/lib/cli-errors.mjs`.
- Registry read failures use `RegistryReadError` in `src/lib/registry.mjs`; missing registry JSON returns `null`, invalid JSON throws a typed read error.
- Best-effort observability paths swallow failures to avoid breaking the primary operation: `logNdjson`, `logEvent`, `writeDiff`, `writePlan`, and `writeReview` in `src/lib/session-log.mjs`.
- Durable state mutations should fail loudly or preserve forensic data. `src/lib/state.mjs` uses lock files, atomic temp-file writes, corrupt-state quarantine, and temp-file cleanup on failed rename.
- Hooks must fail open unless their purpose is explicitly to block. `plugin/hooks/pre-tool-agent.mjs`, `plugin/hooks/pre-tool-bash.mjs`, and `hooks/session-lifecycle-hook.mjs` return `{"continue":true}` on hook-local failures; `hooks/stop-gate.mjs` emits `{"decision":"block"}` only for active review-gate decisions.

## Logging

**Framework:** `process.stdout` / `process.stderr` / filesystem appenders

**Patterns:**
- Use `emitSuccess` and `emitError` from `src/lib/cli-errors.mjs` for command stdout/stderr and JSON envelope consistency.
- Keep machine-readable JSON on stdout and diagnostics/progress on stderr. `src/codex-bridge.mjs` foreground and background command paths preserve stdout for envelopes and rendered command output.
- Use session artifacts for runtime observability:
  - `.ndjson` via `logNdjson` in `src/lib/session-log.mjs`.
  - `.events` via `logEvent` in `src/lib/session-log.mjs`.
  - Diff, plan, and review artifacts via `writeDiff`, `writePlan`, and `writeReview` in `src/lib/session-log.mjs`.
- Use tracked job logs for background progress through `createProgressReporter`, `appendLogLine`, and `runTrackedJob` in `src/lib/tracked-jobs.mjs`.
- Hook diagnostics go to `~/.codex-bridge/hook-errors` through `logHookError` in `hooks/stop-gate.mjs`, `plugin/hooks/pre-tool-agent.mjs`, and `plugin/hooks/pre-tool-bash.mjs`.
- `console.log` is limited to build/help-style output such as `esbuild.config.mjs` and some command rendering in `src/codex-bridge.mjs`; new runtime code should prefer explicit stdout/stderr writers or existing emit helpers.

## Comments

**When to Comment:**
- Comment invariants, failure modes, concurrency decisions, generated-layout rules, and error taxonomy. Good examples are the state lock comments in `src/lib/state.mjs`, timeout comments in `hooks/stop-gate.mjs`, adapter registry comments in `src/adapters/index.mjs`, and generated-surface comments in `esbuild.config.mjs`.
- Keep comments near the code that owns the invariant. Generated surface ownership belongs in `esbuild.config.mjs`, bundle drift proof belongs in `scripts/baseline-contracts.mjs`, and event formatting rules belong in `src/lib/session-log.mjs`.
- Avoid comments that restate obvious assignments. Prefer short orientation before a complex block, as in `src/lib/args.mjs` quote parsing and `plugin/hooks/pre-tool-bash.mjs` command classification.

**JSDoc/TSDoc:**
- Use JSDoc typedef blocks where plain JS needs type contracts. `src/adapters/codex/protocol.mjs` defines protocol typedefs, and `src/adapters/codex/codex.mjs` defines turn-capture typedefs.
- Keep formal TypeScript declarations in `.d.ts` files, especially `src/adapters/index.d.ts` and `src/adapters/codex/protocol.d.ts`.
- Do not add TypeScript source files; this package is ESM JavaScript with declaration files only.

## Function Design

**Size:** Keep new reusable logic in focused modules under `src/lib/` or `src/adapters/` instead of adding to `src/codex-bridge.mjs` unless it is command-dispatch glue. Existing large integration files include `src/codex-bridge.mjs`, `src/adapters/codex/codex.mjs`, and `src/lib/session-log.mjs`; new helpers should reduce growth in those files.

**Parameters:** Use explicit `cwd`, `workspaceRoot`, `sessionDir`, `threadId`, and `options = {}` parameters. Established examples include `runCommand(command, args, options)` in `src/lib/process.mjs`, `loadConfigLayers(skillDir, overrideDir, workspaceRoot)` in `src/lib/config.mjs`, `selectAdapter(options)` in `src/adapters/index.mjs`, and `captureTurn(client, threadId, startRequest, options)` in `src/adapters/codex/codex.mjs`.

**Return Values:** Return structured, JSON-serializable objects for command and adapter boundaries. Public envelopes use stable fields such as `ok`, `schema_version`, `command`, `result`, `error`, `meta`, `jobId`, `threadId`, and `phase` in `src/lib/cli-errors.mjs`, `src/adapters/codex/index.mjs`, and `src/codex-bridge.mjs`.

**Async Boundaries:** Use `async` functions for app-server, adapter, and pipeline operations. Keep synchronous helpers for short, local filesystem or subprocess checks where ordering matters, as in `src/lib/state.mjs`, `src/lib/process.mjs`, and `hooks/stop-gate.mjs`.

**Dependency Injection:** Add optional injected dependencies when tests need deterministic behavior. Existing examples include `options.spawnSync` in `src/lib/process.mjs`, `options.killProcess` in `src/lib/broker-lifecycle.mjs`, `runtime` overrides in `src/adapters/codex/index.mjs`, and `__testHooks__` in `src/adapters/codex/broker.mjs`.

## Module Design

**Exports:** Use named exports for library modules. Examples: `src/lib/state.mjs`, `src/lib/config.mjs`, `src/lib/process.mjs`, `src/lib/cli-errors.mjs`, and `src/lib/git.mjs`.

**Default Exports:** Use default exports only where a module represents one primary adapter object. `src/adapters/codex/index.mjs` exports the Codex adapter as default.

**Barrel Files:** There is no broad barrel export for `src/lib/`. `src/adapters/index.mjs` is an adapter registry and resolver, not a re-export-only barrel. Import helpers directly from their owning module.

**Generated Surfaces:** Source-first edits are required for generated assets. `esbuild.config.mjs` copies or bundles:
- `src/codex-bridge.mjs` to `skill/scripts/codex-bridge.mjs` and `plugin/scripts/codex-bridge.mjs`.
- `src/adapters/codex/broker.mjs` to `skill/app-server-broker.mjs` and `plugin/scripts/app-server-broker.mjs`.
- `src/prompts/adversarial-review.md`, `src/schemas/review-output.schema.json`, and `src/templates/*.md` to both `skill/` and `plugin/`.
- `hooks/` to `plugin/hooks/` with plugin path transforms.
- `skill/config.yaml` to `plugin/config.yaml`.

**Plugin Surfaces:** Packaged command and agent markdown files are part of the tested product surface. `test/plugin-surfaces.test.mjs` pins 22 command files under `plugin/commands/` and 2 agent files under `plugin/agents/`. Command markdown uses YAML frontmatter with `description`, `argument-hint`, and `allowed-tools`; agent markdown uses frontmatter with `name`, `description`, `model`, `tools`, and `skills`.

---

*Convention analysis: 2026-05-02*
