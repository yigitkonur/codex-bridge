---
last_mapped_commit: 16f4fd188f47160bdaddabb9813c6fe67e486d5d
analysis_date: 2026-04-30
evidence_policy: current non-Markdown package, source, config, workflow, hook, and test files only
---

# External Integrations

**Analysis Date:** 2026-04-30

## APIs & External Services

**OpenAI Codex CLI / app-server:**
- Codex CLI is the primary execution backend for `codex-bridge`.
  - SDK/Client: No npm SDK; integration is process-based through the `codex` binary in `src/adapters/codex/protocol.mjs` and availability probes in `src/adapters/codex/codex.mjs`.
  - Process commands: `codex --version`, `codex app-server --help`, and `codex app-server`.
  - Protocol: newline-delimited JSON request/response and notification objects over child-process stdio or broker socket; request messages are built in `src/adapters/codex/protocol.mjs`.
  - Client identity: `DEFAULT_CLIENT_INFO.name` is `codex_bridge` in `src/adapters/codex/protocol.mjs`.
  - Auth: Codex CLI account state is read via app-server methods `account/read` and `config/read` in `src/adapters/codex/codex.mjs`; no Codex token is stored in this repository.

**Codex app-server broker:**
- Shared local broker is started by `src/lib/broker-lifecycle.mjs` and implemented by `src/adapters/codex/broker.mjs`.
  - SDK/Client: Local Node `net` server plus `CodexAppServerClient`.
  - Endpoint env var: `CODEX_COMPANION_APP_SERVER_ENDPOINT` from `src/adapters/codex/protocol.mjs`.
  - PID/log env vars: `CODEX_COMPANION_APP_SERVER_PID_FILE` and `CODEX_COMPANION_APP_SERVER_LOG_FILE` from `src/lib/broker-lifecycle.mjs`.
  - Transport: `unix:<sessionDir>/broker.sock` on non-Windows; `pipe:\\\\.\\pipe\\<name>` on Windows from `src/lib/broker-endpoint.mjs`.
  - State: broker session metadata is saved as `broker.json` under the bridge state directory by `src/lib/broker-lifecycle.mjs`.

**Claude Code plugin and skill runtime:**
- Root plugin metadata is in `.claude-plugin/plugin.json` and exposes `./skill`.
  - Canonical packaged plugin metadata is in `plugin/.claude-plugin/plugin.json`.
  - Plugin commands live under `plugin/commands/`; current checkout has 22 command Markdown files inventoried by file listing only.
  - Plugin agents live under `plugin/agents/`; current checkout has 2 agent Markdown files inventoried by file listing only.
  - Plugin hooks are registered by `plugin/hooks/hooks.json`.
  - Legacy skill bundle lives under `skill/`.
  - Plugin-local skill bundle lives under `plugin/skills/codex-bridge/`.
  - Path env vars used by hooks: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_ENV_FILE`, and `CLAUDE_PROJECT_DIR`.

**Claude CLI official plugin detection:**
- The bridge detects whether the official OpenAI Codex plugin is enabled by spawning `claude plugin list --json` in `src/lib/official-plugin.mjs`.
  - Auth: none handled by this repository; it relies on the local Claude CLI environment.
  - Use: stop-review-gate setup can suppress codex-bridge's own Stop gate when the official plugin is active through `src/lib/state.mjs` and `src/codex-bridge.mjs`.

**Git and worktree operations:**
- Git CLI is used by `src/lib/git.mjs`, `src/lib/workspace.mjs`, `src/lib/session-log.mjs`, `src/lib/state.mjs`, and Stop hooks.
  - Commands include `rev-parse`, `symbolic-ref`, `show-ref`, `branch --show-current`, `diff`, `ls-files`, `merge-base`, `status --porcelain`, and `log`.
  - Review target resolution uses dirty working tree detection and branch comparison in `src/lib/git.mjs`.
  - Workspace identity for state uses `git rev-parse --show-toplevel` through `src/lib/workspace.mjs` and `src/lib/state.mjs`.
  - Stop gate lock path is the Git project root plus `.codex-bridge-stop-review-gate.lock` in `src/lib/state.mjs` and `hooks/stop-gate.mjs`.

**GitHub Releases API:**
- Update checks call `https://api.github.com/repos/yigitkonur/codex-bridge/releases/latest` in `src/lib/update-check.mjs`.
  - SDK/Client: Node 22 global `fetch`.
  - Auth: anonymous request with `Accept: application/vnd.github+json` and `User-Agent: codex-bridge-update-check`; no `GITHUB_TOKEN` or `GH_TOKEN` path is implemented in current source.
  - Cache: `codex-bridge-update.json` under `CODEX_BRIDGE_PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, or `~/.codex-bridge/update-cache.json`.
  - Timeout: default fetch timeout is 2500 ms in `src/lib/update-check.mjs`.

**npm / skills installer:**
- Update auto-apply and explicit apply spawn `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y` from `src/codex-bridge.mjs`.
  - SDK/Client: local `npx` process.
  - Auth: none detected in repository code.
  - Control env var: `CODEX_BRIDGE_NO_UPDATE_CHECK=1` disables hot-path update checks in `src/codex-bridge.mjs`.

## Data Storage

**Databases:**
- Not detected. There is no database server, ORM, or persistent remote data store in `package.json` or source imports.

**Local filesystem state:**
- Bridge state root is resolved in `src/lib/state.mjs`.
  - Preferred root: `CODEX_BRIDGE_PLUGIN_DATA/state`.
  - Fallback root: `CLAUDE_PLUGIN_DATA/state`.
  - Final fallback: `os.tmpdir()/codex-companion`.
  - Workspace state file: `state.json`.
  - State lock file: `state.lock`.
  - Job metadata directory: `jobs/`.
  - Broker session file: `broker.json` from `src/lib/broker-lifecycle.mjs`.
- Session logs are local files from `src/lib/session-log.mjs`.
  - `*.ndjson` append-only event log.
  - `*.events` append-only human-readable event stream.
  - `*.diff`, `*.plan.md`, and `*.review.json` generated as task/review artifacts.
- Hook diagnostics are local files under `~/.codex-bridge/hook-errors/` in `plugin/hooks/*.mjs` and `hooks/stop-gate.mjs`.
- Update cache is local JSON from `src/lib/update-check.mjs`.
- Temporary prompt files are written under `os.tmpdir()` by `hooks/stop-gate.mjs` and `plugin/hooks/pre-tool-agent.mjs`, then removed best-effort.

**File Storage:**
- Local filesystem only. No S3, GCS, Azure Blob, or hosted file storage integration detected.

**Caching:**
- GitHub release cache in `src/lib/update-check.mjs`.
- Update apply-attempt lock/cache in `src/lib/update-check.mjs`.
- Official plugin detection cache in `src/lib/official-plugin.mjs`.
- Adapter cache in `src/adapters/index.mjs`.
- Broker session cache in `src/lib/broker-lifecycle.mjs`.

## Authentication & Identity

**Auth Provider:**
- Codex CLI OAuth/account state is the effective auth provider for OpenAI work.
  - Implementation: `src/adapters/codex/codex.mjs` connects to app-server and reads account/config state.
  - Capability metadata in `src/adapters/codex/index.mjs` declares `auth_strategy: "oauth-cli"` and `billing_model: "subscription"`.
  - No access tokens, API keys, or OAuth secrets are read from repository files.

**Claude Code Identity:**
- Claude Code plugin execution identity comes from local Claude plugin runtime env vars and hook payloads.
  - `CODEX_COMPANION_SESSION_ID` scopes session behavior in `hooks/session-lifecycle-hook.mjs`, `plugin/hooks/session-start.mjs`, `plugin/hooks/session-end.mjs`, and `src/lib/state.mjs`.
  - `CLAUDE_PROJECT_DIR` and hook payload `cwd` choose workspace cwd in hook scripts.

## Monitoring & Observability

**Error Tracking:**
- No external error tracking service detected.
- Hook errors are written to `~/.codex-bridge/hook-errors/` by `plugin/hooks/*.mjs` and `hooks/stop-gate.mjs`.
- CLI task/review events are written to `.ndjson` and `.events` files by `src/lib/session-log.mjs`.

**Logs:**
- Session logs: `src/lib/session-log.mjs`.
- Broker log file: `broker.log` under a temporary broker session directory from `src/lib/broker-lifecycle.mjs`.
- Background job log file: `resolveJobLogFile()` in `src/lib/state.mjs`.
- Git diff and partial-progress artifacts: `src/lib/session-log.mjs` and `src/lib/git.mjs`.
- Monitor/event command support is implemented in `src/codex-bridge.mjs` and backed by job/session artifacts under the state/session directories.

## CI/CD & Deployment

**Hosting:**
- Not applicable. This package ships as local Claude Code skill/plugin files, not a hosted web service.

**CI Pipeline:**
- GitHub Actions build workflow: `.github/workflows/build.yml`.
  - Triggers: push to `main` and pull request to `main`.
  - Steps: checkout, setup Node 22 with npm cache, `npm ci`, `npm run build`, `npm test`, generated bundle drift check, bundle existence checks, CLI sanity probes.
- GitHub Actions release workflow: `.github/workflows/release.yml`.
  - Trigger: version tags `v*.*.*`.
  - Steps: checkout, setup Node 22, `npm ci`, `npm run build`, stage `skill/`, remove maintainer docs from release payload, create tar/zip archives, create `SHA256SUMS`, build release notes, upload to GitHub release via `softprops/action-gh-release@v2`.

## Environment Configuration

**Required env vars:**
- None are required for local source inspection or `npm test`.
- Real Claude plugin runtime supplies `CLAUDE_PLUGIN_ROOT`, `CLAUDE_ENV_FILE`, `CLAUDE_PROJECT_DIR`, and hook JSON payloads.
- Real Codex runtime requires `codex` on `PATH`; availability is checked by `src/adapters/codex/codex.mjs`.

**Optional/runtime env vars:**
- `CODEX_BRIDGE_BACKEND` - Backend override in `src/adapters/index.mjs`.
- `CODEX_BRIDGE_PLUGIN_DATA` - Preferred plugin data root in `src/lib/state.mjs` and hook scripts.
- `CLAUDE_PLUGIN_DATA` - Legacy/fallback plugin data root in `src/lib/state.mjs` and hook scripts.
- `CODEX_COMPANION_SESSION_ID` - Session scoping in hooks and state.
- `CODEX_COMPANION_APP_SERVER_ENDPOINT` - Explicit app-server broker endpoint in `src/adapters/codex/protocol.mjs`.
- `CODEX_COMPANION_APP_SERVER_PID_FILE` - Broker PID file path in `src/lib/broker-lifecycle.mjs`.
- `CODEX_COMPANION_APP_SERVER_LOG_FILE` - Broker log file path in `src/lib/broker-lifecycle.mjs`.
- `CODEX_BRIDGE_NO_UPDATE_CHECK` - Disables update checks in `src/codex-bridge.mjs`.
- `CODEX_BRIDGE_HOOK_DISABLE` - Disables specific or all plugin hooks in `hooks/stop-gate.mjs` and `plugin/hooks/*.mjs`.
- `CODEX_BRIDGE_DISABLE_WORKTREE_AUTO` - Allows `task --write` without `--worktree-auto` in `plugin/hooks/pre-tool-bash.mjs`.

**Secrets location:**
- Not detected. No `.env*`, `*secret*`, or `*credential*` files were found during the mapping check.
- Do not put secrets in `skill/config.yaml`, `plugin/config.yaml`, workspace `config.yaml`, or cwd `config.yaml`; the config loader in `src/lib/config.mjs` reads YAML as plain local configuration.

## Hooks & Callbacks

**Incoming:**
- Claude Code hook events registered in `hooks/hooks.json` and `plugin/hooks/hooks.json`:
  - `SessionStart` -> `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-lifecycle-hook.mjs" SessionStart`.
  - `SessionEnd` -> `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-lifecycle-hook.mjs" SessionEnd`.
  - `Stop` -> `node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-gate.mjs"`.
- `plugin/hooks/hooks.json` currently registers only SessionStart, SessionEnd, and Stop. Additional hook scripts exist under `plugin/hooks/`, but they are not referenced by the current hook registration JSON.

**Outgoing:**
- Stop gate can spawn `codex-bridge task --json --mode default --read-only --no-pipeline` for stop-time review from `hooks/stop-gate.mjs`.
- Session lifecycle hook spawns `codex-bridge status --prune-orphans --json` on SessionEnd from `hooks/session-lifecycle-hook.mjs`.
- Packaged plugin hook scripts can spawn bridge commands and write hook context when registered; current registered JSON points to the legacy `session-lifecycle-hook.mjs` and `stop-gate.mjs` scripts.

## External Boundary Rules

**Generated artifact boundary:**
- Build writes both legacy skill and packaged plugin outputs. Future source changes under `src/`, `skill/config.yaml`, or hook/plugin surfaces must run `npm run build` before committing generated outputs.
- `.github/workflows/build.yml` enforces generated-output freshness.

**Network boundary:**
- Runtime network use detected in source is limited to GitHub Releases API update checks through `src/lib/update-check.mjs`.
- Codex app-server communication is local process/socket communication with the user's installed Codex CLI; upstream model/network behavior is owned by Codex CLI, not by repository HTTP code.

**Process boundary:**
- Child process execution is central: `codex`, `git`, `claude`, `npx`, and Node worker/broker scripts are spawned by `src/lib/process.mjs`, `src/adapters/codex/protocol.mjs`, `src/lib/official-plugin.mjs`, `src/codex-bridge.mjs`, and hook scripts.
- `src/lib/process.mjs` sets `shell` to `process.env.SHELL || true` only on Windows and otherwise avoids shell mode for spawned commands.

---

*Integration audit: 2026-04-30*
