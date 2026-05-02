---
last_mapped_commit: 6b3a78a98eb5396798d0ed2ee3d8f7451f204652
---
# Codebase Structure

**Analysis Date:** 2026-05-02

## Directory Layout

```text
codex-bridge/
|-- .claude-plugin/          # Root Claude plugin metadata and marketplace metadata
|-- .github/workflows/       # Build/test and release workflows
|-- .planning/               # GSD planning artifacts and codebase maps
|-- docs/                    # Project documentation outside runtime source
|-- hooks/                   # Root Claude hook sources copied into plugin layout
|-- plugin/                  # Packaged Claude Code plugin layout
|   |-- .claude-plugin/      # Packaged plugin manifest
|   |-- agents/              # Packaged Claude agent definitions
|   |-- commands/            # Packaged slash-command markdown files
|   |-- hooks/               # Generated/copied plugin hook scripts and manifest
|   |-- prompts/             # Generated prompt assets
|   |-- schemas/             # Generated/package schema assets
|   |-- scripts/             # Generated runtime bundles
|   |-- skills/              # Packaged skill entry
|   `-- templates/           # Generated instruction templates
|-- scripts/                 # Repo maintenance/contract scripts
|-- skill/                   # Legacy installable skill bundle
|   |-- prompts/             # Generated prompt assets
|   |-- schemas/             # Generated schema assets
|   |-- scripts/             # Generated runtime bundle
|   `-- templates/           # Generated instruction templates
|-- src/                     # Authored ESM runtime source
|   |-- adapters/            # Adapter interface docs and Codex implementation
|   |-- lib/                 # Shared runtime modules
|   |-- prompts/             # Authored prompt source
|   |-- schemas/             # Authored JSON schema source
|   |-- templates/           # Authored instruction templates
|   `-- codex-bridge.mjs     # Main CLI orchestrator
|-- test/                    # Node built-in test suite
|-- esbuild.config.mjs       # Build graph for generated layouts
|-- package.json             # Package metadata, scripts, runtime requirements
`-- package-lock.json        # npm dependency lockfile
```

## Directory Purposes

**Root:**
- Purpose: Holds package metadata, build config, plugin metadata, release metadata, and authored runtime source.
- Contains: `package.json`, `package-lock.json`, `esbuild.config.mjs`, `CHANGELOG.md`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `.claude-plugin/`, `.github/`, `src/`, `test/`, `skill/`, `plugin/`, `hooks/`.
- Key files: `package.json`, `esbuild.config.mjs`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.

**`.claude-plugin/`:**
- Purpose: Root plugin metadata used by Claude plugin packaging.
- Contains: `plugin.json`, `marketplace.json`.
- Key files: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.

**`.github/workflows/`:**
- Purpose: CI and release automation.
- Contains: Build/test workflow and release-packaging workflow.
- Key files: `.github/workflows/build.yml`, `.github/workflows/release.yml`.

**`.planning/`:**
- Purpose: GSD project state, requirements, roadmap, plans, research, and generated codebase maps.
- Contains: Planning state plus `.planning/codebase/ARCHITECTURE.md` and `.planning/codebase/STRUCTURE.md`.
- Key files: `.planning/STATE.md`, `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/codebase/`.

**`docs/`:**
- Purpose: Supporting project documentation outside the executable runtime.
- Contains: Markdown documentation.
- Key files: `docs/` contents are not part of the active runtime path unless explicitly loaded by commands or tests.

**`src/`:**
- Purpose: Authored Node ESM source for the bridge runtime.
- Contains: CLI orchestrator, adapter registry, Codex adapter, shared libraries, prompts, schemas, and templates.
- Key files: `src/codex-bridge.mjs`, `src/adapters/index.mjs`, `src/adapters/codex/index.mjs`, `src/lib/config.mjs`, `src/lib/state.mjs`.

**`src/adapters/`:**
- Purpose: Runtime adapter boundary and backend-specific implementations.
- Contains: Registry source, TypeScript declarations, adapter interface notes, Codex implementation, and placeholder interface docs for other backends.
- Key files: `src/adapters/index.mjs`, `src/adapters/index.d.ts`, `src/adapters/codex/index.mjs`, `src/adapters/codex/codex.mjs`, `src/adapters/codex/protocol.mjs`, `src/adapters/codex/broker.mjs`, `src/adapters/codex/pipeline.mjs`.

**`src/adapters/codex/`:**
- Purpose: Implement the Codex backend against Codex app-server.
- Contains: Adapter facade, app-server turn/review capture, protocol client, broker process, pipeline defaults, and protocol declarations.
- Key files: `src/adapters/codex/index.mjs`, `src/adapters/codex/codex.mjs`, `src/adapters/codex/protocol.mjs`, `src/adapters/codex/protocol.d.ts`, `src/adapters/codex/broker.mjs`, `src/adapters/codex/pipeline.mjs`.

**`src/adapters/_interface/`:**
- Purpose: Documents the adapter interface vocabulary and contracts.
- Contains: Interface notes, capability notes, event vocabulary, brief contract notes.
- Key files: `src/adapters/_interface/INTERFACE.md`, `src/adapters/_interface/CAPABILITIES.md`, `src/adapters/_interface/EVENT_VOCABULARY.md`, `src/adapters/_interface/BRIEF.md`.

**`src/adapters/aider/`, `src/adapters/claude-cli/`, `src/adapters/gemini/`, `src/adapters/ollama/`:**
- Purpose: Placeholder/interface documentation for potential non-Codex backends.
- Contains: `README.md` and `INTERFACE.md` files, not active runtime implementations.
- Key files: `src/adapters/aider/README.md`, `src/adapters/claude-cli/README.md`, `src/adapters/gemini/README.md`, `src/adapters/ollama/README.md`.

**`src/lib/`:**
- Purpose: Shared runtime modules used by the CLI and adapter layers.
- Contains: Config, runtime options, broker lifecycle, state, tracked jobs, job control, session logs, Git helpers, registry, brief validation, rendering, CLI errors, update checks, official plugin detection, process helpers, filesystem helpers, prompt helpers, workspace helpers, thread-id helpers, and pending request IPC.
- Key files: `src/lib/config.mjs`, `src/lib/runtime-options.mjs`, `src/lib/state.mjs`, `src/lib/session-log.mjs`, `src/lib/tracked-jobs.mjs`, `src/lib/job-control.mjs`, `src/lib/git.mjs`, `src/lib/registry.mjs`, `src/lib/brief.mjs`, `src/lib/render.mjs`, `src/lib/cli-errors.mjs`.

**`src/prompts/`:**
- Purpose: Authored prompt source for adversarial review.
- Contains: Prompt markdown copied into generated layouts by `esbuild.config.mjs`.
- Key files: `src/prompts/adversarial-review.md`, `src/prompts/AGENTS.md`.

**`src/schemas/`:**
- Purpose: Authored JSON schema source for structured review output.
- Contains: Review output schema copied into generated layouts by `esbuild.config.mjs`.
- Key files: `src/schemas/review-output.schema.json`, `src/schemas/AGENTS.md`.

**`src/templates/`:**
- Purpose: Authored instruction templates injected into task prompts.
- Contains: Execute-mode and plan-mode instruction templates copied into generated layouts by `esbuild.config.mjs`.
- Key files: `src/templates/execute-instructions.md`, `src/templates/plan-enforcement.md`, `src/templates/AGENTS.md`.

**`hooks/`:**
- Purpose: Root Claude hook source and hook manifest copied into the packaged plugin layout.
- Contains: Session lifecycle hook, Stop gate hook, alternate Stop review hook, and active hook config.
- Key files: `hooks/hooks.json`, `hooks/session-lifecycle-hook.mjs`, `hooks/stop-gate.mjs`, `hooks/stop-review-gate-hook.mjs`.

**`plugin/`:**
- Purpose: Packaged Claude Code plugin layout.
- Contains: Plugin manifest, packaged commands/agents/hooks, generated scripts/assets/config, and plugin-local skill entry.
- Key files: `plugin/.claude-plugin/plugin.json`, `plugin/scripts/codex-bridge.mjs`, `plugin/scripts/app-server-broker.mjs`, `plugin/commands/task.md`, `plugin/agents/codex-bridge-runner.md`, `plugin/hooks/hooks.json`, `plugin/skills/codex-bridge/SKILL.md`.

**`plugin/commands/`:**
- Purpose: Packaged Claude Code slash-command markdown files.
- Contains: Command surfaces for task, review, adversarial-review, status, result, wait, events, cancel, setup, version, config, update, auth-status, send, steer, respond, summary, await-artifact, iterate, merge, verdict, and verdicts.
- Key files: `plugin/commands/task.md`, `plugin/commands/review.md`, `plugin/commands/adversarial-review.md`, `plugin/commands/status.md`, `plugin/commands/result.md`.

**`plugin/agents/`:**
- Purpose: Packaged Claude agent definitions that run bridge tasks and reviews.
- Contains: Runner and reviewer agents.
- Key files: `plugin/agents/codex-bridge-runner.md`, `plugin/agents/codex-bridge-reviewer.md`.

**`plugin/hooks/`:**
- Purpose: Packaged hook scripts and active hook manifest.
- Contains: Generated copies from `hooks/` plus additional packaged hook scripts; active execution is governed by `plugin/hooks/hooks.json`.
- Key files: `plugin/hooks/hooks.json`, `plugin/hooks/session-lifecycle-hook.mjs`, `plugin/hooks/stop-gate.mjs`, `plugin/hooks/pre-tool-agent.mjs`, `plugin/hooks/hook-state.mjs`.

**`plugin/scripts/`:**
- Purpose: Generated packaged runtime bundles.
- Contains: `codex-bridge.mjs` and `app-server-broker.mjs` generated by `npm run build`.
- Key files: `plugin/scripts/codex-bridge.mjs`, `plugin/scripts/app-server-broker.mjs`.

**`plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`:**
- Purpose: Generated/copied packaged assets consumed by the packaged runtime.
- Contains: Prompt markdown, schema JSON, and instruction templates.
- Key files: `plugin/prompts/adversarial-review.md`, `plugin/schemas/review-output.schema.json`, `plugin/schemas/brief.schema.json`, `plugin/templates/execute-instructions.md`, `plugin/templates/plan-enforcement.md`.

**`skill/`:**
- Purpose: Legacy installable skill bundle.
- Contains: Authored skill metadata/config/references plus generated runtime bundles and assets.
- Key files: `skill/SKILL.md`, `skill/config.yaml`, `skill/scripts/codex-bridge.mjs`, `skill/app-server-broker.mjs`, `skill/prompts/adversarial-review.md`, `skill/schemas/review-output.schema.json`, `skill/templates/execute-instructions.md`, `skill/templates/plan-enforcement.md`.

**`scripts/`:**
- Purpose: Repository maintenance and contract validation scripts.
- Contains: Baseline contract validation script.
- Key files: `scripts/baseline-contracts.mjs`.

**`test/`:**
- Purpose: Node built-in test suite.
- Contains: `.test.mjs` files covering CLI args, adapter registry/routing, app-server protocol, broker lifecycle, state locking, job control, Git/worktree helpers, hooks, plugin surfaces, rendering, prompt/schema contracts, update checks, and static contracts.
- Key files: `test/baseline-contracts.test.mjs`, `test/adapter-registry.test.mjs`, `test/app-server-client.test.mjs`, `test/broker-lifecycle.test.mjs`, `test/state.test.mjs`, `test/plugin-surfaces.test.mjs`, `test/bridge-static.test.mjs`.

## Key File Locations

**Entry Points:**
- `src/codex-bridge.mjs`: Authored CLI dispatcher and orchestration entrypoint.
- `plugin/scripts/codex-bridge.mjs`: Generated packaged plugin CLI entrypoint.
- `skill/scripts/codex-bridge.mjs`: Generated legacy skill CLI entrypoint.
- `src/adapters/codex/broker.mjs`: Authored shared app-server broker entrypoint.
- `plugin/scripts/app-server-broker.mjs`: Generated packaged broker entrypoint.
- `skill/app-server-broker.mjs`: Generated legacy skill broker entrypoint.
- `hooks/session-lifecycle-hook.mjs`: Authored SessionStart/SessionEnd hook source.
- `hooks/stop-gate.mjs`: Authored Stop review gate hook source.
- `plugin/commands/*.md`: Packaged slash-command entrypoints.
- `plugin/agents/*.md`: Packaged Claude agent entrypoints.

**Configuration:**
- `package.json`: Node version, ESM mode, npm scripts, dependencies, and package metadata.
- `package-lock.json`: npm dependency lockfile.
- `esbuild.config.mjs`: Build graph for bundled scripts and copied static assets.
- `skill/config.yaml`: Install-root default config source.
- `plugin/config.yaml`: Generated plugin config copy.
- `.claude-plugin/plugin.json`: Root plugin metadata.
- `.claude-plugin/marketplace.json`: Root marketplace metadata.
- `plugin/.claude-plugin/plugin.json`: Packaged plugin manifest with command/agent/hook/skill paths.
- `hooks/hooks.json`: Authored active hook manifest.
- `plugin/hooks/hooks.json`: Packaged active hook manifest.
- `.github/workflows/build.yml`: CI build/test/generated-drift verification.
- `.github/workflows/release.yml`: Release archive workflow.

**Core Logic:**
- `src/codex-bridge.mjs`: Command handlers, task/review orchestration, lifecycle hooks, background workers, Stop-gate setup, update/config/status commands.
- `src/adapters/index.mjs`: Backend adapter registry and selection precedence.
- `src/adapters/codex/index.mjs`: Codex adapter facade and capability declaration.
- `src/adapters/codex/codex.mjs`: Codex app-server turn/review capture and structured result parsing.
- `src/adapters/codex/protocol.mjs`: JSONL app-server client, direct app-server spawn, broker client connection.
- `src/adapters/codex/broker.mjs`: Shared broker server process.
- `src/adapters/codex/pipeline.mjs`: Default follow-up review pipeline behavior.
- `src/lib/config.mjs`: YAML config layer loading and merging.
- `src/lib/runtime-options.mjs`: Default config, collaboration mode, sandbox policy, completion schema.
- `src/lib/state.mjs`: Workspace-scoped state, lock, broker state, job index, stop gate state, and job request files.
- `src/lib/session-log.mjs`: Session event/NDJSON artifact writing and formatting.
- `src/lib/tracked-jobs.mjs`: Detached job execution tracking.
- `src/lib/job-control.mjs`: Status/result/cancel job resolution.
- `src/lib/git.mjs`: Git context, review target resolution, worktree creation, pruning, merging, and worktree listing.
- `src/lib/registry.mjs`: Per-task artifact registry.
- `src/lib/brief.mjs`: Structured brief validation/rendering.
- `src/lib/pending-requests.mjs`: Disk-backed request/response IPC for app-server questions.
- `src/lib/render.mjs`: Human-readable output rendering and review shape validation.
- `src/lib/cli-errors.mjs`: Error taxonomy, envelopes, and exit behavior.
- `src/lib/update-check.mjs`: Release check and auto-apply update logic.
- `src/lib/official-plugin.mjs`: Official OpenAI Codex plugin detection.

**Testing:**
- `test/*.test.mjs`: Node built-in tests loaded by `npm test`.
- `test/plugin-surfaces.test.mjs`: Verifies packaged plugin command/agent/hook surfaces.
- `test/baseline-contracts.test.mjs`: Verifies baseline command/runtime contracts.
- `scripts/baseline-contracts.mjs`: Script backing baseline contract checks.
- `.github/workflows/build.yml`: Runs `npm run build`, `npm test`, generated-drift checks, and CLI sanity checks.

**Generated Runtime Outputs:**
- `skill/scripts/codex-bridge.mjs`: Generated from `src/codex-bridge.mjs`.
- `plugin/scripts/codex-bridge.mjs`: Generated from `src/codex-bridge.mjs`.
- `skill/app-server-broker.mjs`: Generated from `src/adapters/codex/broker.mjs`.
- `plugin/scripts/app-server-broker.mjs`: Generated from `src/adapters/codex/broker.mjs`.
- `skill/prompts/adversarial-review.md`: Generated/copied from `src/prompts/adversarial-review.md`.
- `plugin/prompts/adversarial-review.md`: Generated/copied from `src/prompts/adversarial-review.md`.
- `skill/schemas/review-output.schema.json`: Generated/copied from `src/schemas/review-output.schema.json`.
- `plugin/schemas/review-output.schema.json`: Generated/copied from `src/schemas/review-output.schema.json`.
- `skill/templates/execute-instructions.md`: Generated/copied from `src/templates/execute-instructions.md`.
- `plugin/templates/execute-instructions.md`: Generated/copied from `src/templates/execute-instructions.md`.
- `skill/templates/plan-enforcement.md`: Generated/copied from `src/templates/plan-enforcement.md`.
- `plugin/templates/plan-enforcement.md`: Generated/copied from `src/templates/plan-enforcement.md`.

## Naming Conventions

**Files:**
- Use `.mjs` for executable/authored ESM modules, for example `src/lib/state.mjs`.
- Use `.d.ts` for type declarations that describe runtime JavaScript modules, for example `src/adapters/codex/protocol.d.ts`.
- Use `.test.mjs` for Node built-in test files under `test/`, for example `test/state.test.mjs`.
- Use kebab-case for command markdown, hook scripts, and many runtime modules, for example `plugin/commands/auth-status.md`, `hooks/stop-gate.mjs`, `src/lib/broker-lifecycle.mjs`.
- Use uppercase `AGENTS.md`, `README.md`, `CHANGELOG.md`, and GSD map filenames.
- Use `.json` for manifests and schemas, for example `.claude-plugin/plugin.json` and `src/schemas/review-output.schema.json`.
- Use `.yaml` for install-root bridge config, for example `skill/config.yaml`.

**Directories:**
- Use lower-case or kebab-case directories for runtime source and packaged surfaces, for example `src/adapters/codex/`, `plugin/commands/`, `plugin/hooks/`.
- Keep generated runtime bundles under `skill/` and `plugin/`; keep authored source under `src/`.
- Keep tests flat under `test/` with one focused `.test.mjs` file per contract area.

**CLI Subcommands:**
- Use kebab-case command names in `COMMANDS` and `SUBCOMMAND_DISPATCH`, for example `auth-status`, `await-artifact`, `task-worker`, and `adversarial-review`.
- Match user-facing plugin command filenames to subcommand names under `plugin/commands/`.

**Functions and Values:**
- Use camelCase for functions and local variables in source modules, for example `runBridgeTask`, `executeReviewRun`, `resolveCommandWorkspace`.
- Use UPPER_SNAKE_CASE for module constants and environment variable names, for example `DEFAULT_CONFIG`, `BROKER_ENDPOINT_ENV`, `CODEX_BRIDGE_PLUGIN_DATA`.
- Use PascalCase for classes, for example `CliError` and `RegistryReadError`.

## Where to Add New Code

**New CLI Subcommand:**
- Primary code: Add metadata in `COMMANDS`, implement a handler, and wire `SUBCOMMAND_DISPATCH` in `src/codex-bridge.mjs`.
- User-facing plugin surface: Add `plugin/commands/<subcommand>.md` in this checkout. If root `commands/` is restored, edit root `commands/<subcommand>.md` instead because `esbuild.config.mjs` copies root commands into `plugin/commands/`.
- Tests: Add or update `test/*.test.mjs`, especially static surface tests and command behavior tests.
- Generated outputs: Run `npm run build` after command-surface or runtime changes.

**New Task/Review Runtime Behavior:**
- Primary code: Route task behavior through `runBridgeTask` and review behavior through `executeReviewRun` in `src/codex-bridge.mjs`.
- Adapter code: Put Codex-specific app-server behavior in `src/adapters/codex/codex.mjs`, protocol changes in `src/adapters/codex/protocol.mjs`, and capability changes in `src/adapters/codex/index.mjs`.
- Tests: Add or update `test/codex-capture*.test.mjs`, `test/app-server-client.test.mjs`, `test/codex-adapter-lifecycle.test.mjs`, and relevant CLI tests.

**New Runtime Adapter:**
- Implementation: Add `src/adapters/<backend>/index.mjs` and any backend support modules.
- Registry: Update `src/adapters/index.mjs` and `src/adapters/index.d.ts`.
- Interface docs: Update `src/adapters/_interface/*.md` only after source behavior is defined.
- Tests: Add adapter selection/routing tests under `test/adapter-*.test.mjs`.

**New Shared Helper Module:**
- Implementation: Add `src/lib/<area>.mjs`.
- Tests: Add `test/<area>.test.mjs`.
- Usage: Import from `src/codex-bridge.mjs` or adapter modules; keep filesystem/process/Git side effects behind small module APIs.

**New Config Key:**
- Primary code: Add the default in `src/lib/runtime-options.mjs`, loading/merge behavior in `src/lib/config.mjs` if needed, and rendering in `src/lib/render.mjs` or `src/codex-bridge.mjs`.
- Install config: Update `skill/config.yaml`; generated `plugin/config.yaml` is produced by `npm run build`.
- Tests: Add config and command coverage under `test/*.test.mjs`.

**New Prompt, Schema, or Template Asset:**
- Prompt source: Add to `src/prompts/`.
- Schema source: Add to `src/schemas/`.
- Template source: Add to `src/templates/`.
- Build config: Add the source/destination pair to `staticAssets` or a layout-specific asset list in `esbuild.config.mjs`.
- Tests: Add strict prompt/schema or build-surface tests under `test/*.test.mjs`.

**New Claude Hook:**
- Source: Add or modify hook scripts under `hooks/` when the hook is part of the build-copied active hook surface.
- Manifest: Update `hooks/hooks.json`; generated `plugin/hooks/hooks.json` is produced by `npm run build`.
- Tests: Add hook behavior or plugin-surface coverage under `test/*.test.mjs`.
- Packaged-only scripts: Only edit `plugin/hooks/*.mjs` directly for plugin-only packaged helpers that are not generated from root `hooks/`.

**New Plugin Agent:**
- Implementation: Add `plugin/agents/<agent>.md` in this checkout. If root `agents/` is restored, edit root `agents/<agent>.md` instead because `esbuild.config.mjs` copies root agents into `plugin/agents/`.
- Tests: Update `test/plugin-surfaces.test.mjs`.

**New Git/Worktree Behavior:**
- Implementation: Add logic to `src/lib/git.mjs`.
- CLI integration: Wire through `src/codex-bridge.mjs`.
- Tests: Add or update `test/git.test.mjs` and `test/git-worktree.test.mjs`.

**New Job/State Behavior:**
- Workspace state: Use `src/lib/state.mjs`, `src/lib/tracked-jobs.mjs`, and `src/lib/job-control.mjs`.
- Session artifacts: Use `src/lib/session-log.mjs`.
- Per-task registry: Use `src/lib/registry.mjs`.
- Tests: Add or update `test/state*.test.mjs`, `test/job-control.test.mjs`, `test/session-log.test.mjs`, or `test/registry.test.mjs`.

**New Build or Release Behavior:**
- Build graph: Update `esbuild.config.mjs`.
- Package scripts: Update `package.json`.
- CI: Update `.github/workflows/build.yml`.
- Release archives: Update `.github/workflows/release.yml`.
- Tests: Add generated drift or static contract checks under `test/*.test.mjs`.

## Special Directories

**`skill/scripts/`:**
- Purpose: Generated legacy skill runtime bundle.
- Generated: Yes.
- Committed: Yes.

**`skill/app-server-broker.mjs`:**
- Purpose: Generated legacy skill broker bundle.
- Generated: Yes.
- Committed: Yes.

**`skill/prompts/`, `skill/schemas/`, `skill/templates/`:**
- Purpose: Generated legacy skill assets copied from `src/prompts/`, `src/schemas/`, and `src/templates/`.
- Generated: Yes.
- Committed: Yes.

**`plugin/scripts/`:**
- Purpose: Generated packaged plugin runtime bundles.
- Generated: Yes.
- Committed: Yes.

**`plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`:**
- Purpose: Generated/copied packaged plugin assets.
- Generated: Yes.
- Committed: Yes.

**`plugin/config.yaml`:**
- Purpose: Generated packaged copy of `skill/config.yaml`.
- Generated: Yes.
- Committed: Yes.

**`plugin/commands/`:**
- Purpose: Packaged Claude command surfaces in this checkout.
- Generated: No, unless root `commands/` is restored and `esbuild.config.mjs` starts copying it into `plugin/commands/`.
- Committed: Yes.

**`plugin/agents/`:**
- Purpose: Packaged Claude agent definitions in this checkout.
- Generated: No, unless root `agents/` is restored and `esbuild.config.mjs` starts copying it into `plugin/agents/`.
- Committed: Yes.

**`plugin/hooks/`:**
- Purpose: Packaged hook manifest/scripts. `hooks/` is copied into this directory by `npm run build`; additional packaged hook helpers may also exist.
- Generated: Mixed.
- Committed: Yes.

**`src/adapters/aider/`, `src/adapters/claude-cli/`, `src/adapters/gemini/`, `src/adapters/ollama/`:**
- Purpose: Adapter interface placeholders/documentation for non-Codex backends.
- Generated: No.
- Committed: Yes.

**`.planning/codebase/`:**
- Purpose: GSD codebase maps consumed by planning/execution workflows.
- Generated: Yes, by mapper agents.
- Committed: Yes.

**`node_modules/`:**
- Purpose: Local npm dependency install directory when dependencies are installed.
- Generated: Yes.
- Committed: No.

---

*Structure analysis: 2026-05-02*
