---
last_mapped_commit: 16f4fd188f47160bdaddabb9813c6fe67e486d5d
analysis_date: 2026-04-30
evidence_policy: current non-Markdown package, source, config, workflow, hook, and test files only
---

# Technology Stack

**Analysis Date:** 2026-04-30

## Languages

**Primary:**
- JavaScript ESM - Runtime and build source in `src/codex-bridge.mjs`, `src/adapters/codex/*.mjs`, `src/lib/*.mjs`, `hooks/*.mjs`, `plugin/hooks/*.mjs`, `esbuild.config.mjs`, and `test/*.test.mjs`.
- JSON - Package/plugin metadata and schemas in `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `plugin/hooks/hooks.json`, `src/schemas/review-output.schema.json`, `plugin/schemas/review-output.schema.json`, and `skill/schemas/review-output.schema.json`.
- YAML - Bridge config defaults and GitHub Actions workflows in `skill/config.yaml`, `plugin/config.yaml`, `.github/workflows/build.yml`, and `.github/workflows/release.yml`.

**Secondary:**
- TypeScript declaration syntax - Adapter and Codex app-server protocol contracts in `src/adapters/index.d.ts` and `src/adapters/codex/protocol.d.ts`; these files are declarations only, not compiled by a TypeScript build step.
- POSIX shell inside GitHub Actions - Inline workflow checks in `.github/workflows/build.yml` and `.github/workflows/release.yml`.

## Runtime

**Environment:**
- Node.js `>=22.0.0` from `package.json` `engines.node`.
- CI runs Node 22 via `actions/setup-node@v4` in `.github/workflows/build.yml` and `.github/workflows/release.yml`.
- Local mapping environment reported Node `v25.9.0`; treat `package.json` and CI Node 22 as the package requirement.
- Package mode is ESM only via `"type": "module"` in `package.json`.

**Package Manager:**
- npm - The repository has `package-lock.json` lockfile version 3 and no alternate lockfile detected.
- Local mapping environment reported npm `11.12.1`.
- Install command in CI is `npm ci` from `.github/workflows/build.yml` and `.github/workflows/release.yml`.

## Package Surface

**Package metadata:**
- Name: `codex-bridge` in `package.json`.
- Version: `2.0.0` in `package.json` and `.claude-plugin/plugin.json`.
- License: `MIT` in `package.json`, `.claude-plugin/plugin.json`, and `plugin/.claude-plugin/plugin.json`.
- Root plugin manifest `.claude-plugin/plugin.json` exposes `skills: ["./skill"]`.
- Packaged plugin manifest `plugin/.claude-plugin/plugin.json` is a noncanonical alpha layout named `codex-bridge-v2-alpha` at version `2.0.0-alpha.0`; it declares `skills`, `commands`, `agents`, and `hooks` paths under `plugin/`.
- Marketplace metadata `.claude-plugin/marketplace.json` points only to `./plugin` under the alpha name `codex-bridge-v2-alpha`.

**Package scripts:**
```bash
npm run build          # node esbuild.config.mjs
npm run dev            # node src/codex-bridge.mjs
npm test               # node --test test/*.test.mjs
```

## Frameworks

**Core:**
- Node.js standard library - CLI, filesystem state, child processes, sockets, crypto, paths, OS tmpdirs, JSON, and tests across `src/codex-bridge.mjs`, `src/lib/*.mjs`, `src/adapters/codex/*.mjs`, `hooks/*.mjs`, and `plugin/hooks/*.mjs`.
- Claude Code plugin layout - Root metadata in `.claude-plugin/plugin.json`; packaged plugin metadata and surfaces in `plugin/.claude-plugin/plugin.json`, `plugin/commands/`, `plugin/agents/`, `plugin/hooks/`, and `plugin/skills/codex-bridge/`.
- Claude Code legacy skill layout - Installable skill bundle in `skill/`, with runtime script `skill/scripts/codex-bridge.mjs`, broker `skill/app-server-broker.mjs`, config `skill/config.yaml`, prompts/schemas/templates under `skill/`.

**Testing:**
- Node built-in test runner - `npm test` runs `node --test test/*.test.mjs`.
- Assertion library is `node:assert/strict`, used throughout `test/*.test.mjs`.
- Test suite count at mapping time: 37 files under `test/*.test.mjs`.

**Build/Dev:**
- esbuild `^0.24.0` in `package.json`; exact lockfile package is `node_modules/esbuild` version `0.24.2`.
- js-yaml `^4.1.0` in `package.json`; exact lockfile package is `node_modules/js-yaml` version `4.1.1`.
- Build entrypoint is `esbuild.config.mjs`; it bundles CLI and broker outputs for both legacy skill and packaged plugin layouts.

## Key Dependencies

**Critical:**
- `esbuild` - Bundles `src/codex-bridge.mjs` and `src/adapters/codex/broker.mjs` to shippable `skill/` and `plugin/` runtime outputs in `esbuild.config.mjs`.
- `js-yaml` - Parses YAML config files in `src/lib/config.mjs`.

**Infrastructure:**
- Node `child_process` - Spawns `codex`, `git`, `npm`/`npx`, `claude`, and Node child workers through `src/lib/process.mjs`, `src/adapters/codex/protocol.mjs`, `src/lib/official-plugin.mjs`, `src/lib/state.mjs`, and hook scripts.
- Node `net` - Provides Unix socket / Windows named-pipe app-server broker transport through `src/lib/broker-endpoint.mjs`, `src/lib/broker-lifecycle.mjs`, `src/adapters/codex/protocol.mjs`, and `src/adapters/codex/broker.mjs`.
- Node `fetch` - Performs anonymous GitHub release checks in `src/lib/update-check.mjs`; no HTTP client package is used.

## Configuration

**Environment:**
- Runtime config file format is YAML under the `codex_bridge` key. Current shipped copies are `skill/config.yaml` and `plugin/config.yaml`.
- Config precedence in code is `DEFAULT_CONFIG` from `src/lib/runtime-options.mjs`, then install-root `config.yaml`, then workspace-root `config.yaml`, then cwd `config.yaml`, implemented by `src/lib/config.mjs`.
- Default config values in `src/lib/runtime-options.mjs` include `mode: "plan"`, `model: "gpt-5.4"`, `effort: "xhigh"`, `auto_review: true`, `allow_questions: true`, `sandbox_policy: "danger-full-access"`, `skip_meta_skills: true`, and `session_dir: "~/.codex-bridge/sessions"`.
- Backend selection uses `CODEX_BRIDGE_BACKEND`, `default_backend`, and `adapter_routing` through `src/adapters/index.mjs`.
- Runtime state root prefers `CODEX_BRIDGE_PLUGIN_DATA`, then `CLAUDE_PLUGIN_DATA`, then `os.tmpdir()/codex-companion` in `src/lib/state.mjs`.

**Build:**
- Build config: `esbuild.config.mjs`.
- CI config: `.github/workflows/build.yml` and `.github/workflows/release.yml`.
- Plugin metadata: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `plugin/.claude-plugin/plugin.json`.
- Hook registration: `hooks/hooks.json` and `plugin/hooks/hooks.json`.

## Generated Outputs

**esbuild bundle outputs:**
- `src/codex-bridge.mjs` -> `skill/scripts/codex-bridge.mjs`.
- `src/codex-bridge.mjs` -> `plugin/scripts/codex-bridge.mjs`.
- `src/adapters/codex/broker.mjs` -> `skill/app-server-broker.mjs`.
- `src/adapters/codex/broker.mjs` -> `plugin/scripts/app-server-broker.mjs`.

**Copied static assets from `esbuild.config.mjs`:**
- `src/prompts/adversarial-review.md` -> `skill/prompts/adversarial-review.md` and `plugin/prompts/adversarial-review.md`.
- `src/schemas/review-output.schema.json` -> `skill/schemas/review-output.schema.json` and `plugin/schemas/review-output.schema.json`.
- `src/templates/execute-instructions.md` -> `skill/templates/execute-instructions.md` and `plugin/templates/execute-instructions.md`.
- `src/templates/plan-enforcement.md` -> `skill/templates/plan-enforcement.md` and `plugin/templates/plan-enforcement.md`.
- `skill/config.yaml` -> `plugin/config.yaml`.

**Plugin layout copies:**
- `esbuild.config.mjs` copies root `commands/`, `agents/`, and `hooks/` into `plugin/` only when those source directories exist.
- Current checkout has no root `commands/` or `agents/` directories; current packaged surfaces are already present in `plugin/commands/` and `plugin/agents/`.
- Current checkout has root `hooks/`, and build copies it to `plugin/hooks/` with runtime path rewrites.
- `plugin/commands/` currently contains 22 Markdown command files and `plugin/agents/` currently contains 2 Markdown agent files; names were inventoried by file listing only, without reading repository Markdown contents.

## CI Build/Test Gates

**Build workflow:**
- `.github/workflows/build.yml` runs on pushes and pull requests to `main`.
- Build job installs with `npm ci`, runs `npm run build`, and runs `npm test`.
- Build job fails if generated paths drift after a fresh build: `skill/scripts`, `skill/app-server-broker.mjs`, `skill/prompts`, `skill/schemas`, `skill/templates`, `plugin/scripts`, `plugin/prompts`, `plugin/schemas`, `plugin/templates`, `plugin/config.yaml`, `plugin/commands`, `plugin/agents`, and `plugin/hooks`.
- Build job verifies required bundle outputs exist, including skill/plugin CLI, broker, prompts, schemas, templates, plugin config, plugin commands, plugin agents, and plugin hooks.
- Build job sanity-checks both `skill/scripts/codex-bridge.mjs` and `plugin/scripts/codex-bridge.mjs` with `help --json`, `version --json`, unknown subcommand behavior, and invalid thread-id behavior.

**Release workflow:**
- `.github/workflows/release.yml` runs on tags matching `v*.*.*`.
- Release job installs with `npm ci`, runs `npm run build`, stages `skill/` under `dist/codex-bridge/`, removes maintainer docs from the staged skill bundle, creates tar/zip archives, creates `SHA256SUMS`, builds release notes, and uploads artifacts with `softprops/action-gh-release@v2`.

## Platform Requirements

**Development:**
- Node.js `>=22.0.0`.
- npm with `package-lock.json` v3 support.
- Git for repository checks, review target detection, worktree operations, state-root canonicalization, and CI release/tag workflows.
- Codex CLI for real runtime commands; code checks `codex --version` and `codex app-server --help` in `src/adapters/codex/codex.mjs`.
- Claude CLI for official OpenAI Codex plugin detection through `claude plugin list --json` in `src/lib/official-plugin.mjs`.

**Production/Distribution:**
- No server hosting target is detected. Distribution is a committed Node bundle installed as a Claude Code skill/plugin and shipped through GitHub release artifacts.
- Runtime writes local files for state, sessions, broker metadata, hook errors, update cache, and temporary prompt files.
- Runtime broker transport is Unix socket on macOS/Linux and named pipe on Windows as defined in `src/lib/broker-endpoint.mjs`.

---

*Stack analysis: 2026-04-30*
