# Changelog

All notable changes to `codex-bridge` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Unreleased changes live under the `Unreleased` section until a release is cut —
see the "Adding an entry" section at the bottom for the workflow.

## [Unreleased]

### Fixed

- Update-check now honors `GITHUB_TOKEN` / `GH_TOKEN` env vars. Without
  auth, unauthenticated requests against a private repository return 404
  and the check silently skips (`check_skip_reason:
  "fetch-failed-no-cache"`). With a token set, the check succeeds and
  returns the real `latest_version`. GH Actions workflows and developers
  running `gh auth login` get working checks for free; nothing else
  breaks if the token is absent.

## [1.1.0] — 2026-04-18

First release with per-launch update-check surface and workspace-level
config override. No breaking changes; every 1.0.0 caller continues to
work unchanged.

### Added

- **Update-check plumbing** (commit `cff0e5f`).
  - New `src/lib/update-check.mjs` module: 24h on-disk cache, 2.5s fetch
    timeout, silent failure. Uses GitHub REST (unauthenticated, within
    rate-limit budget given the cache).
  - `version [--check-update] [--json]` now surfaces `result.update` with
    `latest_version`, `has_update`, `checked_at_age_ms`,
    `check_skipped`, `check_skip_reason`. `--check-update` forces a
    fresh fetch.
  - New `update [--force] [--json]` subcommand: prints current vs
    latest + the `npx -y skills add …` install recipe. Does NOT
    self-modify the skill.
  - Silent per-launch stdout notice when a newer version is cached.
    Opt-out via `CODEX_BRIDGE_NO_UPDATE_CHECK=1` env or `--json` flag
    (envelope is preserved). Also skipped for `help`/`version`/`update`.
  - `BRIDGE_CAPABILITIES` gains `update-check` and
    `workspace-config-override`.

### Changed

- **Workspace `config.yaml` override** is now a real thing (commit
  `945621b`, see
  `unexpected-bridge-observations/07-cwd-config-yaml-is-ignored.md`).
  `src/lib/config.mjs::loadConfig(skillDir, overrideDir = null)` reads
  three layers top-down (`DEFAULT_CONFIG` < `{skillDir}/config.yaml` <
  `{overrideDir}/config.yaml`). Callers with a meaningful cwd (task,
  send, steer, wait, events) pass it through; cwd-less callers (help,
  version, respond, summary) keep the old behavior. New export
  `resolveConfigSources()` reports both paths + existence flags.

### Fixed

- `next_action.description` at `phase: "incomplete"` no longer claims
  "Codex's completion check flagged gaps" when the actual cause was a
  pipeline stage timeout. Branches on `pipeline.error` presence so
  orchestrators get a truthful next-step (commit `945621b`,
  `unexpected-bridge-observations/03`).

### Docs

- `CHANGELOG.md` (this file) introduced with "Adding an entry"
  workflow at the bottom.
- `README.md` gains a "Releasing" subsection documenting the version-
  bump + tag + push procedure.
- `skill/references/config-reference.md` documents the three-layer
  config resolution order.
- `unexpected-bridge-observations/` grows to 8 entries — new 07
  (workspace config.yaml ignored, partially resolved) and 08
  (`adversarial-review` creates no session artifacts).
- `gherkin-tests-v2/LIVE_RUN_REPORT.md` adds a retest addendum showing
  5 predicates now PASS live (1 was blocked on the config fix).

## [1.0.0] — 2026-04-17

First tagged release of the Claude Code skill + single-file Node.js bridge to
the OpenAI Codex app-server. `npx -y skills add yigitkonur/codex-bridge -a claude-code -g -y`
installs and runs; `bridge task --json "…"` delegates work to Codex and returns
a uniform envelope that Claude Code can switch on.

### Added

- Plan → approve → execute → auto-pipeline → done/incomplete lifecycle, driven
  by `src/lib/auto-pipeline.mjs` (diff → review → fix → completion-check).
- Append-only `.events` and `.ndjson` session artifacts per thread, plus
  `.diff` and `.plan.md` captured at appropriate points
  (`src/lib/session-log.mjs`).
- Structured error envelope (`{ok, error:{class, code, retryable, suggestion}}`)
  on failure, mapped 1:1 to exit codes 0/1/2/3/4/5/6/7/8
  (`src/lib/cli-errors.mjs`).
- `requestUserInput` round-trip via disk IPC (`src/lib/pending-requests.mjs`)
  so a separate `respond` CLI invocation can answer a question raised mid-turn.
- `adversarial-review` subcommand returning findings that validate against
  `schemas/review-output.schema.json`.
- `wait`, `events --follow`, `steer`, `summary`, `cancel`, and background jobs
  via `task --background`.
- JSON-RPC broker (`src/app-server-broker.mjs`) that multiplexes multiple CLI
  invocations onto a single Codex app-server connection in the same workspace.
- `.claude-plugin/plugin.json` for skills.sh / Claude plugin-marketplace
  discovery.
- Guided README bootstrap for new machines (Node 22 → Codex CLI → skill
  install) plus a troubleshooting table.
- CI drift check: `.github/workflows/build.yml` rebuilds from source and
  refuses to pass if `skill/scripts/*` diverges from the committed bundle.
- Release workflow: pushing a `vX.Y.Z` tag auto-packages `.tar.gz` + `.zip` +
  `SHA256SUMS` and attaches them to a GitHub release.
### Docs

- `AGENTS.md` (+ `CLAUDE.md` symlink) — repo-root instructions for agents.
- `REVIEW.md` — review-time checklist.
- `src/`, `src/lib/`, `skill/`, `gherkin-tests-v2/` — per-folder `AGENTS.md`
  with folder-specific conventions and invariants.
- `skill/references/` — user-facing reference docs for commands, config,
  notifications, NDJSON schema, error recovery, monitor patterns, prompt
  writing, and orchestration flow diagrams.

---

## Adding an entry

Every PR that changes behavior — adds a subcommand, changes an envelope
field, renames a config key, introduces or resolves an observation, etc. —
must touch this file.

1. **During development**, append a bullet under the `## [Unreleased]`
   section. Use one of five categories in this exact order:
   - `### Added` for new features / surfaces
   - `### Changed` for behavior changes to existing features
   - `### Deprecated` for soon-to-be-removed features (keep entry until
     removal release)
   - `### Removed` for features that were deprecated earlier and have now
     been removed
   - `### Fixed` for bug fixes
   - `### Security` for vulnerability mitigations
2. **Link each bullet** to the relevant commit SHA and, when applicable, the
   spec or observation it corresponds to (e.g.
   `gherkin-tests-v2/04-errors/03-review-empty-diff.md`,
   `unexpected-bridge-observations/07-cwd-config-yaml-is-ignored.md`).
3. **Keep voice consistent**: imperative, past-less. "Honor workspace
   config.yaml" — not "Honored" or "Now honors."
4. **When cutting a release**:
   - Decide major/minor/patch per semver:
     - MAJOR: breaking envelope / exit-code / config-key changes.
     - MINOR: new subcommands, new capabilities, new config keys.
     - PATCH: bug fixes, doc-only changes, internal refactors.
   - Rename the `[Unreleased]` heading to `[X.Y.Z] — YYYY-MM-DD`.
   - Add a fresh empty `## [Unreleased]` above it.
   - Bump `package.json` `version` and `src/codex-bridge.mjs`'s
     `BRIDGE_VERSION` in the same commit.
   - Commit as `chore(release): vX.Y.Z`, then tag and push:
     ```sh
     git tag vX.Y.Z
     git push origin main vX.Y.Z
     ```
   - The `release.yml` workflow auto-packages the tarball + zip +
     SHA256SUMS and attaches them to the GitHub release.
5. **Keep it truthful**: if a feature shipped only behind a flag or was
   reverted before release, note that explicitly. A changelog that overstates
   coverage is worse than no changelog.

Do NOT edit historical entries below `[Unreleased]`. Once a release is
tagged, its entry is frozen — subsequent fixes that affect it belong in a
new release section, not a retroactive edit.
