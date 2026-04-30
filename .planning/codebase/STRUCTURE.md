---
last_mapped_commit: 16f4fd188f47160bdaddabb9813c6fe67e486d5d
mapped_date: 2026-04-30
evidence_boundary: Repository Markdown files were not read or used as evidence for this map.
---

# Codebase Structure

**Analysis Date:** 2026-04-30

## Directory Layout

```text
codex-bridge/
|-- .claude-plugin/          # Root plugin metadata surface
|-- .github/workflows/       # Build and release CI workflows
|-- .planning/codebase/      # GSD codebase maps written by mapper agents
|-- agents/                  # Authored plugin agent surfaces copied into plugin/
|-- commands/                # Authored plugin slash-command surfaces copied into plugin/
|-- hooks/                   # Authored hook config and hook scripts
|-- plugin/                  # Packaged Claude Code plugin layout
|   |-- .claude-plugin/      # Packaged plugin metadata
|   |-- agents/              # Generated/copied agent surfaces
|   |-- commands/            # Generated/copied command surfaces
|   |-- hooks/               # Generated/copied hook surfaces
|   |-- prompts/             # Generated prompt assets
|   |-- schemas/             # Generated JSON schemas
|   |-- scripts/             # Generated bundled CLI and broker
|   |-- skills/codex-bridge/ # Plugin-local skill metadata
|   `-- templates/           # Generated developer-instruction templates
|-- skill/                   # Legacy installable skill layout
|   |-- prompts/             # Generated prompt assets
|   |-- schemas/             # Generated JSON schemas
|   |-- scripts/             # Generated bundled CLI
|   `-- templates/           # Generated developer-instruction templates
|-- src/                     # Authoritative runtime source
|   |-- adapters/            # Backend registry and Codex runtime
|   |-- lib/                 # Shared config, state, git, render, and process modules
|   |-- prompts/             # Authored prompt assets copied by build
|   |-- schemas/             # Authored schemas copied by build
|   `-- templates/           # Authored templates copied by build
|-- test/                    # Node built-in test suite
|-- esbuild.config.mjs       # Dual skill/plugin bundle and asset-copy build
|-- package.json             # Package metadata and script source of truth
`-- package-lock.json        # npm lockfile
```

## Directory Purposes

**`.claude-plugin/`:**
- Purpose: Root plugin metadata for repository-level plugin packaging.
- Contains: `plugin.json`.
- Key files: `.claude-plugin/plugin.json`.

**`.github/workflows/`:**
- Purpose: CI and release automation.
- Contains: YAML workflows.
- Key files: `.github/workflows/build.yml`, `.github/workflows/release.yml`.
- Use `build.yml` as evidence for generated-path drift checks and standard CI commands.

**`.planning/codebase/`:**
- Purpose: GSD codebase intelligence documents.
- Contains: Mapper outputs for future planning and execution agents.
- Key files: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`.
- Write only assigned GSD outputs here unless another GSD command explicitly assigns more files.

**`src/`:**
- Purpose: Authoritative runtime source.
- Contains: CLI entry point, adapter runtime, shared modules, prompt/schema/template source assets.
- Key files: `src/codex-bridge.mjs`, `src/adapters/index.mjs`, `src/adapters/codex/codex.mjs`, `src/lib/runtime-options.mjs`.

**`src/adapters/`:**
- Purpose: Backend abstraction and backend-specific implementations.
- Contains: `src/adapters/index.mjs`, `src/adapters/codex/`, plus placeholder directories for other backend names.
- Key files: `src/adapters/index.mjs`, `src/adapters/codex/index.mjs`, `src/adapters/codex/codex.mjs`, `src/adapters/codex/protocol.mjs`, `src/adapters/codex/broker.mjs`, `src/adapters/codex/pipeline.mjs`.
- Only `codex` is loadable through the current adapter registry.

**`src/adapters/codex/`:**
- Purpose: Codex app-server backend runtime.
- Contains: Backend descriptor, runtime functions, protocol client, broker, pipeline logic, and type declarations.
- Key files: `src/adapters/codex/index.mjs`, `src/adapters/codex/codex.mjs`, `src/adapters/codex/protocol.mjs`, `src/adapters/codex/protocol.d.ts`, `src/adapters/codex/broker.mjs`, `src/adapters/codex/pipeline.mjs`.

**`src/lib/`:**
- Purpose: Shared implementation modules used by CLI handlers and Codex runtime.
- Contains: Config, runtime options, state, jobs, session logs, git, rendering, broker lifecycle, update checks, official-plugin detection, process helpers, and pending request handling.
- Key files: `src/lib/config.mjs`, `src/lib/runtime-options.mjs`, `src/lib/state.mjs`, `src/lib/session-log.mjs`, `src/lib/git.mjs`, `src/lib/tracked-jobs.mjs`, `src/lib/job-control.mjs`, `src/lib/broker-lifecycle.mjs`, `src/lib/update-check.mjs`.

**`src/prompts/`:**
- Purpose: Authored prompt assets copied into both install layouts by `esbuild.config.mjs`.
- Contains: Prompt source files.
- Key files: `src/prompts/adversarial-review.md`.
- Evidence note: Path and copy relationship were verified through `esbuild.config.mjs`; repository Markdown contents were not read.

**`src/schemas/`:**
- Purpose: Authored JSON schemas for structured outputs.
- Contains: Schema files copied into both install layouts.
- Key files: `src/schemas/review-output.schema.json`.

**`src/templates/`:**
- Purpose: Authored developer-instruction templates copied into both install layouts.
- Contains: Template files.
- Key files: `src/templates/execute-instructions.md`, `src/templates/plan-enforcement.md`.
- Evidence note: Path and copy relationship were verified through `esbuild.config.mjs`; repository Markdown contents were not read.

**`commands/`:**
- Purpose: Authored plugin slash-command surfaces.
- Contains: Command files copied into `plugin/commands/` when the build runs.
- Key files: `commands/`.
- Evidence note: Contents were not read because repository Markdown was excluded; build-copy behavior was verified through `esbuild.config.mjs`.

**`agents/`:**
- Purpose: Authored plugin agent surfaces.
- Contains: Agent files copied into `plugin/agents/` when the build runs.
- Key files: `agents/`.
- Evidence note: Contents were not read because repository Markdown was excluded; build-copy behavior was verified through `esbuild.config.mjs`.

**`hooks/`:**
- Purpose: Authored Claude Code hook config and hook scripts.
- Contains: Hook declaration JSON and Node hook scripts.
- Key files: `hooks/hooks.json`, `hooks/session-lifecycle-hook.mjs`, `hooks/stop-gate.mjs`, `hooks/stop-review-gate-hook.mjs`.

**`skill/`:**
- Purpose: Legacy installable skill layout.
- Contains: Default config, generated bundled CLI, generated broker, generated prompts, generated schemas, generated templates, and skill metadata.
- Key files: `skill/config.yaml`, `skill/scripts/codex-bridge.mjs`, `skill/app-server-broker.mjs`, `skill/schemas/review-output.schema.json`.
- Do not hand-edit generated runtime/assets under `skill/scripts/`, `skill/app-server-broker.mjs`, `skill/prompts/`, `skill/schemas/`, or `skill/templates/`.

**`plugin/`:**
- Purpose: Packaged Claude Code plugin layout.
- Contains: Plugin metadata, copied command/agent/hook surfaces, generated bundled scripts, generated assets, generated default config, and plugin-local skill metadata.
- Key files: `plugin/.claude-plugin/plugin.json`, `plugin/scripts/codex-bridge.mjs`, `plugin/scripts/app-server-broker.mjs`, `plugin/config.yaml`, `plugin/hooks/hooks.json`.
- Do not hand-edit generated runtime/assets under `plugin/scripts/`, `plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`, `plugin/commands/`, `plugin/agents/`, `plugin/hooks/`, or `plugin/config.yaml`.

**`test/`:**
- Purpose: Node built-in test suite.
- Contains: `*.test.mjs` files grouped by behavior area.
- Key files: `test/adapter-registry.test.mjs`, `test/adapter-routing.test.mjs`, `test/app-server-client.test.mjs`, `test/broker-lifecycle.test.mjs`, `test/broker-stream-release-ordering.test.mjs`, `test/session-log.test.mjs`, `test/state.test.mjs`, `test/task-command.test.mjs`, `test/review-command.test.mjs`.

## Authored vs Generated Areas

**Authoritative source areas:**
- `src/codex-bridge.mjs`: CLI command registry, dispatch, task/review orchestration, status/result/events surfaces, setup/update/config handlers.
- `src/adapters/index.mjs`: backend registry and adapter capability contract.
- `src/adapters/codex/*.mjs`: Codex runtime, protocol, broker, and pipeline source.
- `src/lib/*.mjs`: shared runtime modules.
- `src/prompts/`, `src/schemas/`, `src/templates/`: source assets copied into install layouts.
- `commands/`, `agents/`, `hooks/`: root-authored plugin surfaces.
- `skill/config.yaml`: source default config copied to `plugin/config.yaml`.
- `.claude-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `package.json`: package and plugin metadata.

**Generated or copied install surfaces:**
- `skill/scripts/codex-bridge.mjs` from `src/codex-bridge.mjs`.
- `skill/app-server-broker.mjs` from `src/adapters/codex/broker.mjs`.
- `skill/prompts/`, `skill/schemas/`, `skill/templates/` from `src/prompts/`, `src/schemas/`, `src/templates/`.
- `plugin/scripts/codex-bridge.mjs` from `src/codex-bridge.mjs`.
- `plugin/scripts/app-server-broker.mjs` from `src/adapters/codex/broker.mjs`.
- `plugin/prompts/`, `plugin/schemas/`, `plugin/templates/` from `src/prompts/`, `src/schemas/`, `src/templates/`.
- `plugin/config.yaml` from `skill/config.yaml`.
- `plugin/commands/`, `plugin/agents/`, `plugin/hooks/` from `commands/`, `agents/`, `hooks/`, with runtime path rewrites from skill script paths to plugin script paths.

## Key File Locations

**Entry Points:**
- `src/codex-bridge.mjs`: Source CLI entry point and main dispatcher.
- `skill/scripts/codex-bridge.mjs`: Generated legacy skill CLI bundle.
- `plugin/scripts/codex-bridge.mjs`: Generated plugin CLI bundle.
- `src/adapters/codex/broker.mjs`: Source broker entry point.
- `skill/app-server-broker.mjs`: Generated legacy skill broker bundle.
- `plugin/scripts/app-server-broker.mjs`: Generated plugin broker bundle.
- `hooks/session-lifecycle-hook.mjs`: SessionStart/SessionEnd hook implementation.
- `hooks/stop-gate.mjs`: Stop hook entry point.
- `hooks/stop-review-gate-hook.mjs`: Stop review gate hook implementation.

**Configuration:**
- `package.json`: Package type, Node engine, npm scripts, dependencies, and package version.
- `package-lock.json`: npm dependency lockfile.
- `skill/config.yaml`: Shipped default bridge config source.
- `plugin/config.yaml`: Generated plugin default config copy.
- `.claude-plugin/plugin.json`: Root plugin metadata.
- `plugin/.claude-plugin/plugin.json`: Packaged plugin metadata.
- `hooks/hooks.json`: Hook declaration file.
- `esbuild.config.mjs`: Build layout and copy rules.

**Core Logic:**
- `src/codex-bridge.mjs`: CLI handlers and orchestration.
- `src/adapters/index.mjs`: Adapter selection and capability checks.
- `src/adapters/codex/codex.mjs`: App-server turn/review runtime.
- `src/adapters/codex/protocol.mjs`: Direct and brokered app-server protocol clients.
- `src/adapters/codex/broker.mjs`: Shared local app-server broker.
- `src/adapters/codex/pipeline.mjs`: Auto-review, auto-fix, and completion-check pipeline.
- `src/lib/runtime-options.mjs`: Runtime defaults and option builders.
- `src/lib/config.mjs`: Config source resolution and merge behavior.
- `src/lib/state.mjs`: Workspace state root, locks, jobs, broker metadata, and stop-gate state.
- `src/lib/session-log.mjs`: Session artifacts and event formatting.
- `src/lib/git.mjs`: Review context, worktrees, branch merge, and cleanup.
- `src/lib/tracked-jobs.mjs`: Background job records and logs.
- `src/lib/job-control.mjs`: Status/result/cancel lookup helpers.
- `src/lib/pending-requests.mjs`: User response handoff files.
- `src/lib/render.mjs`: Human and JSON output rendering.
- `src/lib/update-check.mjs`: Release update checks and cache.
- `src/lib/process.mjs`: Command execution and process tree termination.

**Testing:**
- `test/*.test.mjs`: Node built-in tests executed by `npm test`.
- `test/adapter-registry.test.mjs`: Adapter contract behavior.
- `test/adapter-routing.test.mjs`: Backend precedence behavior.
- `test/app-server-client.test.mjs`: Protocol client behavior.
- `test/broker-lifecycle.test.mjs`: Broker script resolution and lifecycle.
- `test/broker-stream-release-ordering.test.mjs`: Broker stream ownership behavior.
- `test/session-log.test.mjs`: Session event command formatting and diff capture.
- `test/state.test.mjs`: State locking, pruning, and data root behavior.
- `test/events-json.test.mjs`: JSON event output behavior.

**CI and Release:**
- `.github/workflows/build.yml`: Runs Node 22, `npm ci`, `npm run build`, `npm test`, generated drift checks, and bundle sanity probes.
- `.github/workflows/release.yml`: Builds release artifacts for tag-based releases.

## Naming Conventions

**Files:**
- Runtime JavaScript modules use `.mjs`, for example `src/codex-bridge.mjs` and `src/lib/state.mjs`.
- Type declaration files use `.d.ts`, for example `src/adapters/codex/protocol.d.ts`.
- Tests use `*.test.mjs` under `test/`, for example `test/state.test.mjs`.
- Generated bundle filenames mirror source entry names, for example `codex-bridge.mjs` and `app-server-broker.mjs`.
- JSON schemas use `.schema.json`, for example `src/schemas/review-output.schema.json`.

**Directories:**
- Runtime source belongs under `src/`.
- Backend-specific runtime code belongs under `src/adapters/<backend>/`.
- Shared reusable modules belong under `src/lib/`.
- Generated plugin install code belongs under `plugin/`.
- Legacy skill install code belongs under `skill/`.
- Hook declarations and authored hook scripts belong under `hooks/`.
- Tests belong under `test/`.

**Commands and Jobs:**
- CLI subcommands use kebab-case names in `COMMANDS`, for example `adversarial-review`, `await-artifact`, and `auth-status`.
- Background job and task ids are safe filesystem ids generated by bridge helpers, then stored under workspace state and registry paths.
- Subagent worktree branches use the pattern `subagent/<backend>/<taskId>` in `src/lib/git.mjs`.

## Import Organization

**Source modules:**
- Use ESM imports only.
- Prefer Node built-ins with the `node:` prefix, as seen across `src/codex-bridge.mjs`, `src/lib/*.mjs`, and `src/adapters/codex/*.mjs`.
- Import shared bridge helpers from `src/lib/`.
- Import backend runtime helpers from `src/adapters/codex/`.

**Build outputs:**
- Generated bundles are self-contained ESM files produced by `esbuild.config.mjs`.
- Plugin copies of command, agent, and hook files receive runtime path rewrites in `toPluginRuntimePath`.

## Where to Add New Code

**New CLI Subcommand:**
- Primary code: `src/codex-bridge.mjs`.
- Update: `COMMANDS`, a handler function, `SUBCOMMAND_DISPATCH`, help/render behavior, and tests under `test/`.
- If user-facing in the plugin, add or update the authored command surface under `commands/`, then run `npm run build`.

**New Config Key:**
- Primary code: `src/lib/runtime-options.mjs`.
- Merge/loading behavior: `src/lib/config.mjs` if the key needs source-specific handling.
- Shipped defaults: `skill/config.yaml`, then regenerate `plugin/config.yaml`.
- Tests: Add coverage under `test/` for defaults, merge behavior, CLI rendering, or runtime effects.

**New Backend Adapter:**
- Primary code: `src/adapters/<backend>/index.mjs`.
- Registry: Add a loader to `ADAPTER_LOADERS` in `src/adapters/index.mjs`.
- Runtime: Keep backend-specific protocol/process code under `src/adapters/<backend>/`.
- Tests: Extend `test/adapter-registry.test.mjs` and `test/adapter-routing.test.mjs`.

**Codex Runtime Change:**
- Runtime behavior: `src/adapters/codex/codex.mjs`.
- Protocol method or transport behavior: `src/adapters/codex/protocol.mjs` and `src/adapters/codex/protocol.d.ts`.
- Shared broker behavior: `src/adapters/codex/broker.mjs`, `src/lib/broker-lifecycle.mjs`, `src/lib/broker-endpoint.mjs`.
- Tests: Use app-server client, broker lifecycle, and stream-ordering tests under `test/`.

**Task or Pipeline Behavior:**
- CLI orchestration: `src/codex-bridge.mjs`.
- Pipeline stages: `src/adapters/codex/pipeline.mjs`.
- Runtime option defaults: `src/lib/runtime-options.mjs`.
- Session artifacts: `src/lib/session-log.mjs`.
- Tests: `test/task-command.test.mjs`, `test/pipeline-command.test.mjs`, `test/auto-pipeline.test.mjs`.

**State, Status, Result, or Cancel Behavior:**
- State persistence: `src/lib/state.mjs`.
- Job progress and logs: `src/lib/tracked-jobs.mjs`.
- Status/result/cancel resolution: `src/lib/job-control.mjs`.
- CLI surfaces: `src/codex-bridge.mjs`.
- Tests: `test/state.test.mjs`, `test/job-control.test.mjs`, `test/status-watch.test.mjs`.

**Session Event or Transcript Behavior:**
- Event formatters and terminal tags: `src/lib/session-log.mjs`.
- CLI consumers: `src/codex-bridge.mjs`.
- Pending user responses: `src/lib/pending-requests.mjs`.
- Tests: `test/session-log.test.mjs`, `test/events-json.test.mjs`.

**Review or Git Behavior:**
- Review target and context: `src/lib/git.mjs`.
- Review command orchestration: `src/codex-bridge.mjs`.
- Review schema/prompt assets: `src/schemas/review-output.schema.json`, `src/prompts/adversarial-review.md`.
- Tests: `test/review-command.test.mjs`, schema/output parsing tests under `test/`.

**Plugin Surface Change:**
- Authored commands: `commands/`.
- Authored agents: `agents/`.
- Authored hooks: `hooks/`.
- Plugin metadata: `.claude-plugin/plugin.json` or `plugin/.claude-plugin/plugin.json`, depending on the target surface.
- Build: Run `npm run build` so `plugin/commands/`, `plugin/agents/`, `plugin/hooks/`, and generated scripts stay aligned.
- Tests: Run `npm test`; plugin surface coverage lives in `test/plugin-surfaces.test.mjs`.

**Generated Asset Change:**
- Prompts: Edit `src/prompts/`, then run `npm run build`.
- Schemas: Edit `src/schemas/`, then run `npm run build`.
- Templates: Edit `src/templates/`, then run `npm run build`.
- Never edit generated copies in `skill/` or `plugin/` directly.

## Special Directories

**`skill/`:**
- Purpose: Installable legacy skill layout.
- Generated: Partially.
- Committed: Yes.
- Safe edits: `skill/config.yaml` and non-generated metadata only. Regenerate runtime outputs with `npm run build`.

**`plugin/`:**
- Purpose: Packaged Claude Code plugin layout.
- Generated: Partially.
- Committed: Yes.
- Safe edits: Metadata files only when intentionally changing plugin package identity. Regenerate copied/runtime surfaces with `npm run build`.

**`plugin/skills/codex-bridge/`:**
- Purpose: Plugin-local skill metadata.
- Generated: No evidence from `esbuild.config.mjs` marks this path as copied at build time.
- Committed: Yes.
- Evidence note: Markdown contents were not read.

**`.planning/`:**
- Purpose: GSD planning and codebase intelligence artifacts.
- Generated: Yes, by GSD workflows.
- Committed: Repository-dependent.
- Safe edits: Only files explicitly assigned by the current GSD task.

**`.github/workflows/`:**
- Purpose: Build and release automation.
- Generated: No.
- Committed: Yes.
- Safe edits: Update when build, test, generated-artifact, or release behavior changes.

**`docs/`:**
- Purpose: Repository documentation directory.
- Generated: Not determined.
- Committed: Present in the tree.
- Evidence note: Contents were not mapped because repository Markdown was excluded from this architecture pass.

## Build and Verification Commands

Use `package.json` as the command source of truth:

```bash
npm run build    # Bundle skill/plugin outputs and copy static assets
npm test         # Run node --test test/*.test.mjs
npm run dev      # Run node src/codex-bridge.mjs
```

Use `.github/workflows/build.yml` as the CI behavior anchor:

```bash
npm ci
npm run build
npm test
```

## Evidence Boundaries

- This map used non-Markdown source, config, workflow, package, and test files as evidence.
- Repository Markdown file contents were not read or used as evidence.
- Markdown paths under `src/prompts/`, `src/templates/`, `commands/`, `agents/`, `skill/`, and `plugin/` are mentioned only because non-Markdown build/config files refer to those paths.
- When future agents need prompt, template, command, agent, or skill text, they must read the relevant Markdown files under the rules of their own task before relying on their contents.

---

*Structure analysis: 2026-04-30*
