---
last_mapped_commit: 16f4fd188f47160bdaddabb9813c6fe67e486d5d
mapped_date: 2026-04-30
evidence_policy: source-tests-package-ci-only
---

# Coding Conventions

**Analysis Date:** 2026-04-30

## Evidence Boundary

Use source files, `package.json`, workflow YAML, and `test/*.test.mjs` as evidence for this map. Repository Markdown files are not used as evidence for this mapping.

## Naming Patterns

**Files:**
- Use ESM `.mjs` for runtime source under `src/`, such as `src/codex-bridge.mjs`, `src/lib/state.mjs`, and `src/adapters/codex/protocol.mjs`.
- Use `.test.mjs` for Node built-in tests under `test/`, such as `test/cli-errors.test.mjs`, `test/state.test.mjs`, and `test/plugin-surfaces.test.mjs`.
- Keep generated bundle targets under `skill/` and `plugin/` aligned through `esbuild.config.mjs`; source files remain under `src/`, `hooks/`, `commands/`, `agents/`, and `skill/config.yaml` when those source paths exist.

**Functions:**
- Use camelCase for exported and local functions, matching `emitError` in `src/lib/cli-errors.mjs`, `loadState` in `src/lib/state.mjs`, `collectReviewContext` in `src/lib/git.mjs`, and `buildCollaborationMode` in `src/lib/runtime-options.mjs`.
- Use verb-first names for side-effecting functions, such as `writeState`, `appendEvent`, `captureGitDiff`, and `spawnBackgroundWorker`.

**Variables:**
- Use camelCase for local variables and lower-case object keys in runtime envelopes.
- Use UPPER_SNAKE_CASE for constants and environment variable names, such as `DEFAULT_CONFIG` in `src/lib/runtime-options.mjs`, `DEFAULT_CLIENT_INFO` in `src/adapters/codex/protocol.mjs`, and `CODEX_BRIDGE_PLUGIN_DATA` in `src/lib/state.mjs`.

**Types:**
- Use class names in PascalCase for error and protocol abstractions, such as `CliError` in `src/lib/cli-errors.mjs`, `AdapterError` in `src/adapters/index.mjs`, `AppServerClientBase` in `src/adapters/codex/protocol.mjs`, and `CodexAppServerClient` in `src/adapters/codex/protocol.mjs`.
- Use JSDoc typedefs near the top of source files when a module needs structured object contracts, as in `src/adapters/codex/codex.mjs` and `src/adapters/codex/protocol.mjs`.

## Code Style

**Formatting:**
- No dedicated formatter config is detected at the repository root. Match adjacent source style in the file being changed.
- Keep source ESM-only. Import Node built-ins with `node:` specifiers, as in `src/lib/process.mjs`, `src/lib/state.mjs`, and `src/lib/git.mjs`.
- Prefer plain objects and small helpers over framework abstractions. Runtime modules use standard Node APIs, `js-yaml`, and local helpers rather than broad utility libraries.

**Linting:**
- No lint script or lint configuration is detected in `package.json`.
- Rely on `npm test`, focused `node --test` commands, and `npm run build` for automated validation.

## Import Organization

**Order:**
1. Node built-ins with `node:` specifiers, such as `node:fs`, `node:path`, `node:os`, and `node:child_process`.
2. Third-party packages, such as `js-yaml` in `src/lib/config.mjs` and `esbuild` in `esbuild.config.mjs`.
3. Internal relative `.mjs` modules, such as `src/lib/cli-errors.mjs`, `src/lib/process.mjs`, and `src/adapters/codex/protocol.mjs`.

**Path Aliases:**
- No path aliases are detected. Use explicit relative imports with file extensions, as in `src/codex-bridge.mjs` and `src/adapters/index.mjs`.

## CLI And Error Envelopes

**Patterns:**
- Represent CLI failures with `CliError` and `emitError` from `src/lib/cli-errors.mjs`. Do not hand-build JSON error output in command handlers.
- JSON success output uses the central envelope emitted by `emitSuccess` in `src/lib/cli-errors.mjs`: include `ok`, `schema_version`, `command`, `result`, and `meta`.
- JSON failure output uses the central envelope emitted by `emitError` in `src/lib/cli-errors.mjs`: include `ok`, `schema_version`, `error`, and optional command context.
- Map semantic error classes to exit codes through `ExitCode` and `CLASS_TO_EXIT` in `src/lib/cli-errors.mjs`.
- Preserve command dispatch through `COMMANDS`, command handlers, and `SUBCOMMAND_DISPATCH` in `src/codex-bridge.mjs`.
- Detect top-level `--json` and help flags with the helper functions in `src/lib/cli-errors.mjs`; tests in `test/cli-errors.test.mjs` cover avoiding prompt-text false positives.

**Error Class Guidance:**
- Use `CliError` for user-facing CLI failures in modules like `src/lib/git.mjs`, `src/lib/brief.mjs`, and `src/codex-bridge.mjs`.
- Use `AdapterError` from `src/adapters/index.mjs` for backend selection and capability failures.
- Preserve retryability and classification fields because `test/cli-errors.test.mjs` asserts timeout, sandbox, upstream disconnect, and other Codex error normalization behavior.

## JSON And Schema Behavior

**Patterns:**
- Keep structured output schemas strict. `src/schemas/review-output.schema.json` uses required fields, enums, numeric bounds, and `additionalProperties: false`.
- Update schema, prompt, renderer, and tests together for review-output changes: `src/schemas/review-output.schema.json`, `src/prompts/adversarial-review.md`, `src/lib/render.mjs`, and `test/render-finding-validity.test.mjs`.
- Keep completion-check JSON strict through `COMPLETION_CHECK_SCHEMA` in `src/lib/runtime-options.mjs`.
- Keep structured brief validation in `src/lib/brief.mjs` hand-rolled and explicit. Tests in `test/brief.test.mjs` cover allowed fields, size limits, hashes, backend values, and path loading.
- Registry writes in `src/lib/registry.mjs` own fields such as schema, task identity, and timestamps. Do not trust caller-provided values for controlled metadata.

## Config, Runtime Options, And State

**Configuration:**
- Load YAML config through `src/lib/config.mjs`; the optional `codex_bridge` root is supported there.
- Preserve config precedence from `src/lib/config.mjs`: defaults, install-root config, workspace-root config, then cwd config.
- Add new config keys in `DEFAULT_CONFIG` and related rendering/merge behavior in `src/lib/runtime-options.mjs`, with tests under `test/`.

**Runtime Defaults:**
- Keep default runtime options centralized in `DEFAULT_CONFIG` in `src/lib/runtime-options.mjs`.
- Plan mode must continue to force reasoning effort through `buildCollaborationMode` in `src/lib/runtime-options.mjs`.
- Sandbox mapping belongs in `buildSandboxPolicy` in `src/lib/runtime-options.mjs`.

**State:**
- Use `src/lib/state.mjs` for workspace-scoped state. State is keyed by the canonical workspace root and stored under the plugin data root chosen by `CODEX_BRIDGE_PLUGIN_DATA`, then `CLAUDE_PLUGIN_DATA`, then the temp fallback.
- Preserve lock behavior in `withStateLock` in `src/lib/state.mjs`, including stale-lock and inode checks covered by `test/state-stale-lock-toctou.test.mjs`.
- Use atomic write helpers in `src/lib/state.mjs`; tests in `test/state.test.mjs` and `test/state-tmp-sweep-on-rename-failure.test.mjs` cover corruption quarantine, pruning, concurrent writers, and temp cleanup.
- Keep read-only status paths read-only. `listJobs` in `src/lib/state.mjs` reaps stale PIDs in memory unless called through a mutating path.

**Session Logs:**
- Use `src/lib/session-log.mjs` for `.ndjson` and `.events` writes. These writes are synchronous append-only best-effort writes.
- Event formatting belongs in `src/lib/session-log.mjs`; update event tags and terminal behavior there with tests in `test/session-log.test.mjs`.
- Terminal event tags are intentionally limited. Pipeline and review events are formatted in `src/lib/session-log.mjs` and verified by `test/bridge-static.test.mjs` and `test/auto-pipeline-turn-watchdog.test.mjs`.

## Filesystem, Process, And Git Interactions

**Process Execution:**
- Use `runCommand` and `runCommandChecked` from `src/lib/process.mjs` for subprocesses. Do not introduce ad hoc shell execution for behavior that needs testable timeouts, signals, or exit-code handling.
- Keep command arguments as arrays. Tests in `test/process.test.mjs` cover timeout, signal, status, and output behavior.

**Git:**
- Use helpers in `src/lib/git.mjs` for repository detection, dirty-state checks, diff capture, worktree creation, branch merging, and pruning.
- Preserve safe ref and task-id validation in `src/lib/git.mjs`; tests in `test/git-worktree.test.mjs` cover branch clobbering, unsafe ids, injection attempts, fallback behavior, fast-forward merge, and stale expected SHA guards.
- Keep untracked file capture conservative in `collectReviewContext` in `src/lib/git.mjs`; tests in `test/git.test.mjs` and `test/session-log.test.mjs` cover omitted bodies, symlink handling, and safe file limits.

## Adapter And Protocol Conventions

**Adapter Registry:**
- Backend selection and capability checks live in `src/adapters/index.mjs`.
- Add backend behavior through adapter registry shapes and tests in `test/adapter-registry.test.mjs`, `test/adapter-routing.test.mjs`, and `test/adapter-selection.test.mjs`.
- Keep adapter capability errors mapped through `AdapterError` in `src/adapters/index.mjs`.

**Codex Protocol:**
- Keep `DEFAULT_CLIENT_INFO.name` in `src/adapters/codex/protocol.mjs` stable as `codex_bridge`.
- Outbound app-server messages from `src/adapters/codex/protocol.mjs` are newline-delimited JSON with `id`, `method`, and `params`.
- Do not add a JSON-RPC version field to outbound app-server messages unless protocol tests are changed with it.
- Server-originated requests without handlers are rejected by `AppServerClientBase` in `src/adapters/codex/protocol.mjs`; tests in `test/app-server-client.test.mjs` cover this behavior.
- Request abort cleanup and pending-turn cleanup are covered by `test/app-server-abort.test.mjs`, `test/codex-capture.test.mjs`, and `test/codex-capture-turn-timeout-fallback.test.mjs`.

## Generated File Discipline

**Build Source Of Truth:**
- `esbuild.config.mjs` is the source of truth for bundled outputs and copied static assets.
- After changes to runtime source, adapter source, library source, prompts, schemas, templates, plugin surfaces, hooks, or `skill/config.yaml`, run `npm run build` and include generated output changes.

**Do Not Hand Edit Generated Runtime Outputs:**
- Do not hand-edit `skill/scripts/`, `skill/app-server-broker.mjs`, `skill/prompts/`, `skill/schemas/`, or `skill/templates/`.
- Do not hand-edit `plugin/scripts/`, `plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`, `plugin/config.yaml`, `plugin/commands/`, `plugin/agents/`, or `plugin/hooks/`.
- Edit source paths such as `src/`, `hooks/`, `commands/`, `agents/`, and `skill/config.yaml` where present, then regenerate through `npm run build`.
- CI in `.github/workflows/build.yml` fails when generated outputs drift from a fresh build.

## Comments

**When to Comment:**
- Add comments only when they preserve an invariant, explain a race, document a compatibility contract, or clarify a non-obvious failure mode.
- Good comment locations are timeout/race logic in `src/adapters/codex/codex.mjs`, lock/atomic-write logic in `src/lib/state.mjs`, protocol handling in `src/adapters/codex/protocol.mjs`, and generated asset copying in `esbuild.config.mjs`.

**JSDoc/TSDoc:**
- Prefer local JSDoc typedefs for structured runtime objects where TypeScript is not present.
- Keep typedefs near the functions that consume them, matching patterns in `src/adapters/codex/codex.mjs` and `src/adapters/codex/protocol.mjs`.

## Function Design

**Size:**
- Keep small validation, parsing, and normalization helpers close to their owning module.
- Large orchestration functions in `src/codex-bridge.mjs` and `src/adapters/codex/pipeline.mjs` should delegate filesystem, state, process, git, render, and protocol behavior to `src/lib/` and `src/adapters/codex/` helpers.

**Parameters:**
- Use options objects for helpers with optional behavior, dependency injection, or test fakes. Examples include `runCommand` in `src/lib/process.mjs`, adapter selection in `src/adapters/index.mjs`, and turn capture in `src/adapters/codex/codex.mjs`.
- Preserve injectable dependencies used by tests, such as custom spawn implementations, fake clients, and custom environment objects.

**Return Values:**
- Return structured objects for CLI envelopes, git context, adapter selection, registry reads, and state snapshots.
- Prefer explicit `{ ok: true }` / `{ ok: false }` style where a caller needs non-throwing validation, matching `loadBrief` in `src/lib/brief.mjs`.

## Module Design

**Exports:**
- Export focused helpers and classes from each module. Avoid exporting incidental module internals unless tests or runtime composition need them.
- Test-only reset helpers are acceptable where cache state exists, such as adapter and official-plugin detection helpers covered by `test/adapter-routing.test.mjs` and `test/cli-status-spawn-memoization.test.mjs`.

**Barrel Files:**
- `src/adapters/index.mjs` acts as the adapter registry entry point. No broad project-level barrel file is detected.

## Change Procedures

**New CLI Subcommand:**
- Update `COMMANDS`, add a handler, and wire `SUBCOMMAND_DISPATCH` in `src/codex-bridge.mjs`.
- Add or update focused tests under `test/`, and update plugin command surfaces if the command is user-facing.
- Run focused tests, `npm run build`, then `npm test`.

**New Config Key:**
- Add the key to `DEFAULT_CONFIG` in `src/lib/runtime-options.mjs`.
- Update config loading/render behavior in `src/lib/config.mjs` or `src/lib/runtime-options.mjs` as needed.
- Update `skill/config.yaml` and generated `plugin/config.yaml` through `npm run build`.
- Add tests for precedence and CLI visibility in files like `test/adapter-routing.test.mjs` or a focused new test file.

**New Event Tag:**
- Add event formatting in `src/lib/session-log.mjs`.
- Update tests that assert event text, JSON envelopes, terminal behavior, or pipeline tag vocabulary: `test/session-log.test.mjs`, `test/events-json.test.mjs`, `test/bridge-static.test.mjs`, and related adapter tests.

**New Review Output Field:**
- Update `src/schemas/review-output.schema.json`, `src/lib/render.mjs`, prompt loading/formatting code, and tests such as `test/render-finding-validity.test.mjs` and `test/adversarial-review-prompt.test.mjs`.

**Protocol Or App-Server Change:**
- Update `src/adapters/codex/protocol.mjs` and related capture code in `src/adapters/codex/codex.mjs`.
- Add tests in `test/app-server-client.test.mjs`, `test/app-server-abort.test.mjs`, or `test/codex-capture*.test.mjs`.

**Git Or Workspace Change:**
- Update `src/lib/git.mjs` or `src/lib/state.mjs`.
- Use real temporary repositories and focused state tests matching `test/git-worktree.test.mjs`, `test/git.test.mjs`, and `test/state*.test.mjs`.

---

*Convention analysis: 2026-04-30*
