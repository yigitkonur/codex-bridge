---
last_mapped_commit: 6b3a78a98eb5396798d0ed2ee3d8f7451f204652
---
# External Integrations

**Analysis Date:** 2026-05-02

## APIs & External Services

**OpenAI Codex Runtime:**
- OpenAI Codex CLI/app-server - Primary execution, review, resume, steering, question, and cancel runtime.
  - SDK/Client: No npm SDK; `src/adapters/codex/protocol.mjs` spawns `codex app-server` and communicates through newline-delimited JSON objects over stdio or broker sockets.
  - Auth: Managed by the external Codex CLI/account; bridge checks `codex --version`, `codex app-server --help`, `account/read`, and `config/read` in `src/adapters/codex/codex.mjs`.
  - Protocol methods: `initialize`, `thread/start`, `thread/resume`, `thread/name/set`, `thread/list`, `review/start`, `turn/start`, `turn/steer`, `turn/interrupt`, `account/read`, and `config/read` are typed in `src/adapters/codex/protocol.d.ts`.
  - Transport: Direct child-process stdio or shared broker socket selected in `src/adapters/codex/protocol.mjs` and `src/lib/broker-lifecycle.mjs`.

**Claude Code Plugin/Skill Surface:**
- Claude Code plugin system - Provides slash commands, agents, and hooks for the packaged plugin layout.
  - SDK/Client: File-based plugin manifests and command/agent Markdown in `.claude-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `plugin/commands/`, `plugin/agents/`, and `plugin/hooks/hooks.json`.
  - Auth: Inherits Claude Code's local plugin execution context; no application secrets are stored by this repo.
  - Hooks: Registered hooks in `plugin/hooks/hooks.json` and `hooks/hooks.json` run local Node scripts for `SessionStart`, `SessionEnd`, and `Stop`.
  - Env contract: Hook scripts read `CLAUDE_ENV_FILE`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, and `CODEX_BRIDGE_PLUGIN_DATA`.

**Claude CLI:**
- Official OpenAI Codex plugin detection - Prevents duplicate stop-gate behavior when the official plugin is active.
  - SDK/Client: `src/lib/official-plugin.mjs` shells out to `claude plugin list --json`.
  - Auth: Uses the local Claude CLI/plugin installation; no tokens are read by bridge code.

**Git:**
- Git command-line integration - Repository discovery, diff capture, review target selection, worktree creation, branch merge, and cleanup.
  - SDK/Client: `src/lib/git.mjs`, `src/lib/session-log.mjs`, `src/lib/state.mjs`, and hook state helpers run `git` through `child_process`.
  - Auth: Uses the user's local Git configuration for any remote access.
  - Remote calls: `src/lib/git.mjs` runs `git fetch --no-tags origin <baseRef>` during merge best-effort refresh.

**GitHub Releases API:**
- Public release update checks - Detects whether a newer `codex-bridge` release exists.
  - SDK/Client: Native Node `fetch` in `src/lib/update-check.mjs`.
  - Endpoint: `https://api.github.com/repos/yigitkonur/codex-bridge/releases/latest`.
  - Auth: Anonymous; comments in `src/lib/update-check.mjs` state no `GITHUB_TOKEN` or `GH_TOKEN` path is used for update checks.
  - Cache: Update results are cached in `CODEX_BRIDGE_PLUGIN_DATA/codex-bridge-update.json`, `CLAUDE_PLUGIN_DATA/codex-bridge-update.json`, or `~/.codex-bridge/update-cache.json`.

**npm / skills Installer:**
- Skill installer update path - Applies newer bridge releases through the public skills installer.
  - SDK/Client: `src/codex-bridge.mjs` spawns `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y`.
  - Auth: Uses npm registry access available to `npx`; no npm token file is read by bridge code.
  - Logs: Detached auto-apply writes `~/.codex-bridge/auto-update.log` from `src/codex-bridge.mjs`.

**GitHub Actions:**
- CI build and release automation - Verifies builds/tests and publishes release artifacts.
  - SDK/Client: `.github/workflows/build.yml` uses `actions/checkout@v4` and `actions/setup-node@v4`; `.github/workflows/release.yml` also uses `softprops/action-gh-release@v2`.
  - Auth: GitHub Actions provides repository permissions; release workflow declares `contents: write` in `.github/workflows/release.yml`.

## Data Storage

**Databases:**
- Not detected.
  - Connection: Not applicable.
  - Client: No database ORM or database client dependency appears in `package.json`, `package-lock.json`, or source imports.

**File Storage:**
- Local filesystem state only.
  - Session logs: `src/lib/session-log.mjs` writes `.ndjson`, `.events`, `.diff`, `.plan.md`, and `.review.json` files under `session_dir`, defaulting to `~/.codex-bridge/sessions`.
  - Workspace state: `src/lib/state.mjs` writes `state.json`, `state.lock`, per-job JSON files, and `broker.json` under `CODEX_BRIDGE_PLUGIN_DATA/state/<workspace-hash>`, `CLAUDE_PLUGIN_DATA/state/<workspace-hash>`, or `os.tmpdir()/codex-companion`.
  - Artifact registry: `src/lib/registry.mjs` writes `meta.json`, `verdict.json`, and `events.jsonl` under `CODEX_BRIDGE_REGISTRY` or `~/.codex-bridge/jobs`.
  - Pending questions: `src/lib/pending-requests.mjs` writes `{threadId}.pending.json` and `{threadId}.response.json` in the session directory.
  - Broker runtime: `src/lib/broker-lifecycle.mjs` writes temp `broker.pid`, `broker.log`, Unix socket/pipe endpoint files, and saved broker session metadata.
  - Crash and hook diagnostics: `src/codex-bridge.mjs` writes `~/.codex-bridge/crashes/*`; `plugin/hooks/*.mjs` write `~/.codex-bridge/hook-errors/*` and `~/.codex-bridge/hook-state/*`.
  - Worktree isolation: `src/lib/git.mjs` creates worker worktrees under `<repoRoot>/../.codex-bridge-worktrees/<taskId>` when requested.

**Caching:**
- Update cache: `src/lib/update-check.mjs` caches latest release metadata and apply-attempt markers.
- Broker session cache: `src/lib/broker-lifecycle.mjs` stores `broker.json` under the workspace state directory.
- Official plugin detection cache: `src/lib/official-plugin.mjs` keeps an in-process cache for `claude plugin list --json` results.
- Seen Monitor jobs: `plugin/hooks/post-tool-bash.mjs` stores bounded seen-job files under `~/.codex-bridge/hook-state/<workspace>/`.

## Authentication & Identity

**Auth Provider:**
- OpenAI Codex CLI authentication.
  - Implementation: `src/adapters/codex/codex.mjs` checks Codex availability, then reads app-server `account/read` and `config/read` status. It classifies OAuth and API-key account types from the app-server response; the bridge does not store OpenAI tokens.
- Claude Code local plugin identity.
  - Implementation: Plugin and hook execution are file/local-process based through `.claude-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, and `hooks/hooks.json`.
- Git identity and remotes.
  - Implementation: Git operations in `src/lib/git.mjs` use the user's local Git configuration and remote credentials.
- GitHub Actions release identity.
  - Implementation: `.github/workflows/release.yml` relies on workflow `contents: write` permissions for `softprops/action-gh-release@v2`; no explicit repository secret names are configured.

## Monitoring & Observability

**Error Tracking:**
- None external.
- Local crash reports are written by `src/codex-bridge.mjs` to `~/.codex-bridge/crashes/`.
- Hook failures are logged by `plugin/hooks/*.mjs` to `~/.codex-bridge/hook-errors/`.

**Logs:**
- Per-thread `.events` and `.ndjson` files are written by `src/lib/session-log.mjs`.
- Per-job logs are written by `src/lib/tracked-jobs.mjs` under the workspace state jobs directory from `src/lib/state.mjs`.
- Registry events are appended by `src/lib/registry.mjs` as `events.jsonl`.
- Broker logs are written by `src/lib/broker-lifecycle.mjs` to temp `broker.log` files.
- GitHub Actions logs come from `.github/workflows/build.yml` and `.github/workflows/release.yml`.

## CI/CD & Deployment

**Hosting:**
- Not detected as a hosted runtime.
- Distribution target is local installable artifacts: legacy skill bundle under `skill/` and packaged Claude Code plugin under `plugin/`.
- Release artifacts are tar/zip archives produced from `skill/` in `.github/workflows/release.yml`.

**CI Pipeline:**
- GitHub Actions.
- Build workflow `.github/workflows/build.yml` runs `npm ci`, `npm run build`, `npm test`, generated-output drift checks, bundle existence checks, and CLI sanity probes.
- Release workflow `.github/workflows/release.yml` runs `npm ci`, `npm run build`, stages `skill/`, removes maintainer docs, creates tar/zip archives and `SHA256SUMS`, builds release notes from `CHANGELOG.md`, and uploads artifacts.

## Environment Configuration

**Required env vars:**
- None are required for the default local CLI beyond standard `PATH` access to `node`, `git`, and `codex`.
- `CODEX_BRIDGE_BACKEND` optionally overrides backend selection in `src/adapters/index.mjs`.
- `CODEX_BRIDGE_PLUGIN_DATA` optionally controls bridge state root and takes precedence over `CLAUDE_PLUGIN_DATA` in `src/lib/state.mjs` and hook helpers.
- `CLAUDE_PLUGIN_DATA` is the legacy/fallback plugin data root in `src/lib/state.mjs`, `src/lib/update-check.mjs`, and hook files.
- `CODEX_COMPANION_SESSION_ID` scopes jobs to a Claude session in `src/lib/tracked-jobs.mjs` and hooks.
- `CODEX_COMPANION_APP_SERVER_ENDPOINT` optionally points clients at an existing Codex app-server broker in `src/adapters/codex/protocol.mjs`.
- `CODEX_COMPANION_APP_SERVER_PID_FILE` and `CODEX_COMPANION_APP_SERVER_LOG_FILE` are broker lifecycle exports in `src/lib/broker-lifecycle.mjs`.
- `CODEX_BRIDGE_NO_UPDATE_CHECK` disables hot-path update checks in `src/codex-bridge.mjs`.
- `CODEX_BRIDGE_REGISTRY` optionally overrides registry storage in `src/lib/registry.mjs`.
- `CODEX_BRIDGE_HEARTBEAT_MS`, `CODEX_BRIDGE_CHECKPOINT_MS`, and `CODEX_BRIDGE_STALL_CHECKPOINTS` tune observability timers in `src/codex-bridge.mjs`.
- `CODEX_BRIDGE_HOOK_DISABLE` disables specific plugin hooks in `plugin/hooks/*.mjs` and root stop/session hook code.
- `CODEX_BRIDGE_DISABLE_WORKTREE_AUTO` opts out of the `task --write` worktree-isolation hook in `plugin/hooks/pre-tool-bash.mjs`.
- `CLAUDE_ENV_FILE`, `CLAUDE_PROJECT_DIR`, and `CLAUDE_PLUGIN_ROOT` are provided by Claude Code plugin execution and consumed by `hooks/session-lifecycle-hook.mjs` and `plugin/hooks/*.mjs`.

**Secrets location:**
- Secrets are not stored in repo-tracked files.
- No `.env` file was detected in the repo scan.
- `.gitignore` excludes `.env`, `.env.local`, `.env.*.local`, `*.pem`, `*.p12`, `id_rsa`, `*.key`, `credentials.json`, and `service-account.json`.
- Codex, Claude, Git, npm, and GitHub credentials are delegated to their respective external CLIs/platforms.

## Webhooks & Callbacks

**Incoming:**
- Claude Code plugin hooks registered by `plugin/hooks/hooks.json` and `hooks/hooks.json`:
  - `SessionStart` runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-lifecycle-hook.mjs" SessionStart`.
  - `SessionEnd` runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-lifecycle-hook.mjs" SessionEnd`.
  - `Stop` runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-gate.mjs"`.
- Packaged but not manifest-registered hook scripts also exist under `plugin/hooks/` for `session-start`, `session-end`, `pre-tool-bash`, `pre-tool-agent`, `post-tool-bash`, `subagent-stop`, and `user-prompt-submit`; the active manifest for this checkout is still `plugin/hooks/hooks.json`.
- Codex app-server can issue server requests such as `item/tool/requestUserInput`; `src/adapters/codex/protocol.mjs`, `src/adapters/codex/broker.mjs`, and `src/lib/pending-requests.mjs` route these through pending/response files.
- Broker management accepts local `broker/shutdown` messages in `src/lib/broker-lifecycle.mjs` and `src/adapters/codex/broker.mjs`.

**Outgoing:**
- Codex app-server requests are sent by `src/adapters/codex/protocol.mjs` over child stdio or local broker sockets.
- Git commands are run by `src/lib/git.mjs`, `src/lib/session-log.mjs`, and `src/lib/state.mjs`.
- Claude plugin list checks are run by `src/lib/official-plugin.mjs`.
- GitHub Releases API requests are made by `src/lib/update-check.mjs`.
- `npx skills@latest add yigitkonur/codex-bridge -a claude-code -g -y` is launched by `src/codex-bridge.mjs` for update apply paths.
- GitHub release uploads are performed by `softprops/action-gh-release@v2` in `.github/workflows/release.yml`.
- No inbound or outbound HTTP webhooks are implemented in source.

---

*Integration audit: 2026-05-02*
