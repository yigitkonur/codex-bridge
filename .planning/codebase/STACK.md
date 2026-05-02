---
last_mapped_commit: 6b3a78a98eb5396798d0ed2ee3d8f7451f204652
---
# Technology Stack

**Analysis Date:** 2026-05-02

## Languages

**Primary:**
- JavaScript ESM on Node.js `>=22.0.0` - Runtime source is `.mjs` under `src/`, hook source is `.mjs` under `hooks/` and `plugin/hooks/`, and build/test scripts are `.mjs` in `esbuild.config.mjs`, `scripts/baseline-contracts.mjs`, and `test/*.test.mjs`.

**Secondary:**
- TypeScript declarations - Public adapter and Codex app-server type contracts live in `src/adapters/index.d.ts` and `src/adapters/codex/protocol.d.ts`; no TypeScript compiler or `tsconfig.json` is detected in `package.json` or the repo root.
- JSON - Package metadata, plugin manifests, schemas, state artifacts, and tests use JSON files including `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `src/schemas/review-output.schema.json`, and `plugin/schemas/brief.schema.json`.
- YAML - Runtime configuration and CI workflows use YAML in `skill/config.yaml`, `plugin/config.yaml`, `.github/workflows/build.yml`, and `.github/workflows/release.yml`.
- Markdown - Plugin command/agent surfaces and generated/static prompt assets use Markdown in `plugin/commands/*.md`, `plugin/agents/*.md`, `src/prompts/adversarial-review.md`, and `src/templates/*.md`.

## Runtime

**Environment:**
- Node.js `>=22.0.0` is required by `package.json` `engines.node`.
- GitHub Actions runs Node `22` via `.github/workflows/build.yml` and `.github/workflows/release.yml`.
- Local command inspection reported Node `v25.9.0`; treat `package.json` and CI as the compatibility contract.
- The package is ESM-only through `"type": "module"` in `package.json`.

**Package Manager:**
- npm is the package manager implied by `package-lock.json` lockfile version `3` and CI `npm ci` in `.github/workflows/build.yml` and `.github/workflows/release.yml`.
- Local command inspection reported npm `11.12.1`; no `packageManager` field is pinned in `package.json`.
- Lockfile: present at `package-lock.json`.

## Frameworks

**Core:**
- Node.js CLI application - Main dispatcher and command surface live in `src/codex-bridge.mjs`.
- OpenAI Codex app-server protocol adapter - Codex runtime bridge code lives in `src/adapters/codex/protocol.mjs`, `src/adapters/codex/codex.mjs`, `src/adapters/codex/index.mjs`, `src/adapters/codex/broker.mjs`, and `src/adapters/codex/pipeline.mjs`.
- Claude Code skill/plugin packaging - Root plugin metadata lives in `.claude-plugin/plugin.json`; packaged plugin metadata and surfaces live in `plugin/.claude-plugin/plugin.json`, `plugin/commands/`, `plugin/agents/`, and `plugin/hooks/hooks.json`; legacy skill metadata lives in `skill/SKILL.md`.
- Adapter registry abstraction - Backend selection and capability validation live in `src/adapters/index.mjs`; this build registers only the `codex` adapter.

**Testing:**
- Node built-in test runner - `npm test` runs `node --test test/*.test.mjs` from `package.json`.
- Node built-in assertions - Tests import `node:assert/strict` throughout `test/*.test.mjs`.
- Static baseline contract verifier - `npm run baseline:contracts` runs `scripts/baseline-contracts.mjs`; `npm run verify:static` combines build, tests, and baseline contract checks in `package.json`.

**Build/Dev:**
- esbuild `0.24.2` - Direct dev dependency in `package-lock.json`; build script is `node esbuild.config.mjs`.
- Dual bundle output - `esbuild.config.mjs` bundles `src/codex-bridge.mjs` to `skill/scripts/codex-bridge.mjs` and `plugin/scripts/codex-bridge.mjs`, and bundles `src/adapters/codex/broker.mjs` to `skill/app-server-broker.mjs` and `plugin/scripts/app-server-broker.mjs`.
- Static asset copying - `esbuild.config.mjs` copies `src/prompts/*`, `src/schemas/*`, `src/templates/*`, `skill/config.yaml`, and `hooks/` into generated skill/plugin layouts.
- GitHub Actions build gate - `.github/workflows/build.yml` runs install, build, tests, generated-output drift checks, and CLI sanity probes against both bundled layouts.

## Key Dependencies

**Critical:**
- Node built-ins - Source imports `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:process`, `node:url`, `node:net`, `node:readline`, and `node:crypto` across `src/`, `hooks/`, `plugin/hooks/`, `scripts/`, and `test/`.
- Codex CLI on `PATH` - Runtime checks and launches `codex --version` and `codex app-server --help` in `src/adapters/codex/codex.mjs`, then spawns `codex app-server` from `src/adapters/codex/protocol.mjs`.
- Git CLI on `PATH` - Review context, worktree isolation, merge, status, and diff capture use `git` in `src/lib/git.mjs`, `src/lib/session-log.mjs`, and `src/lib/state.mjs`.
- Claude CLI on `PATH` for official plugin detection - `src/lib/official-plugin.mjs` runs `claude plugin list --json`.
- npm/npx on `PATH` for installer flows - `src/codex-bridge.mjs` spawns `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y` for auto-apply/update install paths.

**Infrastructure:**
- `esbuild` `0.24.2` - Bundling and static build generation, configured in `esbuild.config.mjs` and used by `scripts/baseline-contracts.mjs`.
- `js-yaml` `4.1.1` - YAML config loading in `src/lib/config.mjs`.
- `argparse` `2.0.1` - Transitive dependency of `js-yaml` in `package-lock.json`.
- `softprops/action-gh-release@v2` - Release artifact upload in `.github/workflows/release.yml`.
- `actions/checkout@v4` and `actions/setup-node@v4` - CI setup in `.github/workflows/build.yml` and `.github/workflows/release.yml`.

## Configuration

**Environment:**
- Config precedence is implemented in `src/lib/config.mjs`: `DEFAULT_CONFIG` from `src/lib/runtime-options.mjs`, then install-root `config.yaml`, then workspace-root `config.yaml`, then cwd `config.yaml`.
- Shipped config files are `skill/config.yaml` and generated `plugin/config.yaml`.
- Default runtime options in `src/lib/runtime-options.mjs` include `mode: "plan"`, `model: "gpt-5.4"`, `effort: "xhigh"`, `auto_review: true`, `allow_questions: true`, `session_dir: "~/.codex-bridge/sessions"`, `sandbox_policy: "danger-full-access"`, `skip_meta_skills: true`, and timeout budgets.
- Backend selection accepts CLI/config routing plus `CODEX_BRIDGE_BACKEND` in `src/adapters/index.mjs`; only `codex` is loadable in this checkout.
- State and session scoping env vars include `CODEX_BRIDGE_PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, `CODEX_COMPANION_SESSION_ID`, `CODEX_COMPANION_APP_SERVER_ENDPOINT`, `CODEX_COMPANION_APP_SERVER_PID_FILE`, and `CODEX_COMPANION_APP_SERVER_LOG_FILE` in `src/lib/state.mjs`, `src/lib/broker-lifecycle.mjs`, `src/adapters/codex/protocol.mjs`, and hook files under `hooks/` and `plugin/hooks/`.
- Operational toggles include `CODEX_BRIDGE_NO_UPDATE_CHECK`, `CODEX_BRIDGE_REGISTRY`, `CODEX_BRIDGE_HEARTBEAT_MS`, `CODEX_BRIDGE_CHECKPOINT_MS`, `CODEX_BRIDGE_STALL_CHECKPOINTS`, `CODEX_BRIDGE_HOOK_DISABLE`, and `CODEX_BRIDGE_DISABLE_WORKTREE_AUTO` in `src/codex-bridge.mjs`, `src/lib/registry.mjs`, and `plugin/hooks/*.mjs`.
- Claude plugin hook env vars include `CLAUDE_ENV_FILE`, `CLAUDE_PROJECT_DIR`, and `CLAUDE_PLUGIN_ROOT` in `hooks/session-lifecycle-hook.mjs` and `plugin/hooks/*.mjs`.
- No `.env` files are present in the repo scan; `.gitignore` excludes `.env`, `.env.local`, `.env.*.local`, credentials, keys, and certificates.

**Build:**
- Package scripts are declared in `package.json`: `baseline:contracts`, `build`, `dev`, `test`, and `verify:static`.
- Build config is `esbuild.config.mjs`.
- Lockfile is `package-lock.json`.
- Root plugin metadata is `.claude-plugin/plugin.json`; packaged plugin metadata is `plugin/.claude-plugin/plugin.json`.
- Generated runtime outputs are under `skill/scripts/`, `skill/app-server-broker.mjs`, `skill/prompts/`, `skill/schemas/`, `skill/templates/`, `plugin/scripts/`, `plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`, `plugin/config.yaml`, and `plugin/hooks/`.
- CI workflow files are `.github/workflows/build.yml` and `.github/workflows/release.yml`.

## Platform Requirements

**Development:**
- Install with `npm ci` from `package-lock.json`.
- Run `npm run build` to regenerate committed skill/plugin bundles from `src/`, `hooks/`, `skill/config.yaml`, prompts, schemas, and templates.
- Run `npm test` or `npm run verify:static` for static verification.
- Codex runtime commands require the `codex` CLI with `app-server` support on `PATH`; setup/auth checks are in `src/adapters/codex/codex.mjs`.
- Git-backed review and worktree commands require `git` on `PATH`; validation and error handling are in `src/lib/git.mjs`.
- Claude plugin detection requires `claude plugin list --json` when checking for the official OpenAI Codex plugin in `src/lib/official-plugin.mjs`.

**Production:**
- Distribution is committed/generated local artifacts, not a hosted service: legacy skill layout under `skill/` and packaged Claude Code plugin layout under `plugin/`.
- Runtime executes locally through Node.js, child processes, local filesystem state, and Codex app-server IPC from `src/adapters/codex/protocol.mjs` and `src/lib/broker-lifecycle.mjs`.
- Broker endpoints use Unix sockets on macOS/Linux and named pipes on Windows via `src/lib/broker-endpoint.mjs`; source and tests cover pipe parsing, while the main lifecycle is local process/socket oriented.
- Release packaging builds `skill/`, removes maintainer docs, creates tar/zip archives, checksums them, and uploads to GitHub Releases from `.github/workflows/release.yml`.

---

*Stack analysis: 2026-05-02*
