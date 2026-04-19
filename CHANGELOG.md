# Changelog

All notable changes to `codex-bridge` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Unreleased changes live under the `Unreleased` section until a release is cut —
see the "Adding an entry" section at the bottom for the workflow.

## [Unreleased]

## [1.2.2] — 2026-04-19

Circuit-breaker behavioral upgrade. The v1.2.0 "3 strictly consecutive
same-family fails" threshold survived the v1.2.1 regression retest only
in spec; a live retest (T4) showed Codex routinely bypasses the
threshold by wrapping failing commands in `& sleep N; kill -TERM $!`
constructs that exit 0 — the consecutive counter reset on every wrapper
and never reached 3. v1.2.2 upgrades the detector.

### Changed

- **`command_failure_circuit_breaker` now uses a sliding window + wrapper
  detection.** Same-family failures are counted within a window of the
  last 5 commandExecutions; `[WARNING]` fires when 3 of those 5 are
  failures. Successful commands DO enter the window (not ignored), so
  interleaved successes no longer shield flailing. In addition,
  monitored-family commands that exit 0 but contain a known
  failure-hiding construct (`& kill`, `|| true`, `|| exit 0`,
  `; true` at end) are counted as failed regardless of exit code.
- NDJSON `CIRCUIT_BREAKER` record now carries `failsInWindow` (3-5),
  `windowSize` (5), and `wrapperDetected` (bool) so downstream tooling
  can distinguish raw structural failure from masked-by-wrapper failure.

### Docs

- `skill/references/config-reference.md` `command_failure_circuit_breaker`
  section rewritten to describe the sliding-window + wrapper semantics
  and reference the v1.2.2 behavior upgrade.
- `sandbox_policy` section gains a **macOS caveat** documenting that
  Apple seatbelt's `workspace-write` enforcement is best-effort: on some
  OS+Codex combinations `.git/` writes succeed, so the `workspace-dirty`
  phase is not guaranteed triggerable on macOS. Linux sandboxes are more
  consistently restrictive. This addresses the T3 "inconclusive" finding
  from the v1.2.1 retest.
- `07-orchestration/07-circuit-breaker-trips-on-repeated-family.md`
  rewritten: 6 scenarios → 9, covering sliding window, wrapper
  detection, window age-out, and the existing regression guards.
  Predicate 9/9 passes offline.



Hot-fix release. v1.2.0 introduced three opt-out-by-config defenses driven
by `runBridgeTask` (session-logging hooks, `skip_meta_skills` directive,
`sandbox_policy` resolution, `command_failure_circuit_breaker`). Live
retesting discovered that the detached `task-worker` on the background
path called `executeTaskRun` directly, bypassing `runBridgeTask` entirely
— so `task --background` completed turns successfully (assistant output
captured, job record transitioned to `completed`) but produced **zero
session artifacts**. `wait $jobId` timed out with `WAIT_TIMEOUT`, `events
--follow` had nothing to tail, and the async+Monitor contract documented
in `skill/SKILL.md` silently broke for every background caller.

### Fixed

- **`task --background` now produces `.events`, `.ndjson`, and `.diff`
  session files.** `handleTaskWorker` at `src/codex-bridge.mjs:2054` now
  calls `runBridgeTask` instead of `executeTaskRun` — identical contract
  to the foreground path, including `onTurnStart`/`onItemCompleted`/
  `onServerRequest` hooks, prompt decoration (`skip_meta_skills`,
  `prompt_footer`), config-aware sandbox-policy resolution, `[QUESTION]`
  handling, and the auto-pipeline. The foreground path was always
  correct; only the detached worker was stripped.
- **`onTurnStart` no longer swallows exceptions silently.** The empty
  `catch {}` at `src/lib/codex.mjs:1140` is replaced with
  `emitProgress(options.onProgress, …)` so any throw from
  `findSession` / `initSession` / `logNdjson` lands in the per-job `.log`
  and the job record instead of vanishing. This is the observability
  primitive that would have caught the v1.2.0 regression in testing.
- **Detached worker stderr is now captured.** `spawnDetachedTaskWorker`
  used `stdio: "ignore"` which swallowed every uncaught exception in the
  detached child. v1.2.1 redirects fd 2 to `${logFile}.worker.err` — an
  empty file on the happy path, a readable stacktrace on crashes.

### Docs

- New gherkin spec: `07-orchestration/08-background-path-produces-session-files.md`
  pinning the foreground/background parity invariant live. This test
  would have failed on v1.2.0 and caught the regression pre-ship.



Session-derailment defenses release. Closes the full five-bug user report
covering a swift-vibescroll session where Codex (a) flailed on sandbox-
blocked `.git/` writes, (b) looped on `osascript` / `display dialog`
probes against a headless environment, (c) had upstream WebSocket drops
misclassified as non-retryable, (d) burned ~10 min on internal meta-skill
ceremony producing spec/plan files that were not part of the deliverable,
and (e) produced committable diffs but could not finalize them.

### Added

- **`sandbox_policy` config key** — `"danger-full-access"` (new shipped
  default), `"workspace-write"`, `"read-only"`. `"danger-full-access"`
  maps to upstream `SandboxPolicy::DangerFullAccess` and mirrors
  `codex --dangerously-bypass-approvals-and-sandbox`, lifting the
  workspace-write restriction on `.git/` metadata. Users who want a
  stricter profile opt into `"workspace-write"` or `"read-only"`.
  Unknown values silently fall back to the mode-derived default so a
  typo cannot widen permissions.
- **`workspace-dirty` phase** for `task --json` envelopes. Emitted when
  Codex produced file changes but the turn ended with
  `codexErrorInfo: "SandboxError"`. Returns a success envelope (exit 0)
  with a ready-to-run `git -C <cwd> add -A && git commit` next-action
  instead of the previous misleading `phase:"error"` with
  "retry with adjusted prompt" guidance.
- **`skip_meta_skills` config key** (default `true`). Prepends a
  mode-aware `[ORCHESTRATOR DIRECTIVE]` to every prompt instructing
  Codex to skip its internal planning/ceremony skills
  (`using-superpowers`, `brainstorming`, `writing-plans`,
  `using-git-worktrees`). Plan-mode turns get "produce a concise inline
  [PLAN] and stop"; execute-mode turns get "execute it directly".
- **`command_failure_circuit_breaker` config key** (default `true`).
  Counts consecutive same-family command failures across
  `osascript`, `applescript-dialog`, `applescript-system`, `open-app`,
  `computer-use`. Emits a `[WARNING]` event to `.events` after `N=3`
  consecutive failures so an orchestrator tailing via Monitor can
  cancel/steer. Logging-only today; auto-interrupt is documented as
  an enhancement candidate.
- **`[WARNING]` notification tag** — first non-terminal info tag in the
  emitted vocabulary. `events --follow` does NOT self-terminate on it
  (the TERMINAL regex at `src/codex-bridge.mjs` still matches only
  `DONE|ERROR|INCOMPLETE`). Matching NDJSON writer: `CIRCUIT_BREAKER`.
- **`formatWarningEvent`** in `src/lib/session-log.mjs`.
- Gherkin specs: `03-config/04` (sandbox), `03-config/05` (skip_meta_skills),
  `03-config/06` (circuit-breaker config), `04-errors/05` (upstream
  disconnect classifier), `07-orchestration/06` (workspace-dirty),
  `07-orchestration/07` (circuit-breaker behavior). Each ships with an
  offline pass/fail predicate — no Codex spawn required.

### Fixed

- Upstream WebSocket drops mid-turn now classify as
  `{class:"network", code:"UPSTREAM_STREAM_DISCONNECTED", retryable:true,
  exit:7}`, unblocking the orchestrator's automatic retry for this
  textbook transient. Two layers: (a) the `turn/completed` handler in
  `src/lib/codex.mjs` now merges `turn.error` into `state.error` when
  the turn didn't complete, so `codexErrorInfo` tags reach
  `classifyError`; (b) `src/lib/cli-errors.mjs` gains a regex fallback
  for transport drops that never produce a terminal `turn/completed`
  (`stream disconnected | websocket closed | no close frame |
  ECONNRESET | ETIMEDOUT | socket hang up`). The typed
  `CODEX_ERROR_INFO` table runs first so correctly-tagged errors
  (`Unauthorized`, `SandboxError`, etc.) keep their specific
  classification.
- **`executeTaskRun` no longer drops seven `runBridgeTask`-built fields**.
  Pre-fix, `sandboxPolicy`, `collaborationMode`, `turnTimeoutMs`,
  `idleTimeoutMs`, `onTurnStart`, `onItemCompleted`, and
  `onServerRequest` were silently discarded at `executeTaskRun`'s
  `runAppServerTurn` call site — defeating `config.sandbox_policy`,
  plan-mode developer instructions, the 120 s idle watchdog, NDJSON
  logging hooks, and the `[QUESTION]` pipeline on the `task` path.
  Forward all fields explicitly.
- `handleSend` without `--mode` now honors `config.sandbox_policy`.
  Previously `sandboxPolicy` was only set inside the
  `if (modeOverride)` block, so a plain `send <tid> "prompt"` silently
  ignored the config.
- `workspace-dirty` `next_action.command` shell-quotes `request.cwd`
  via `JSON.stringify()` (matches the `buildMonitorHint` pattern). Paths
  with spaces no longer break the suggested git command.
- `detectCommandFamily` reordered so content-based patterns
  (`display dialog`, `System Events`, `tell application`) run before
  invocation umbrellas (`osascript`, `open -a`). `osascript -e 'display
  dialog "…"'` — the most common invocation form — now correctly
  classifies as `applescript-dialog` instead of the broad `osascript`.
  Pre-fix, the `applescript-dialog` and `applescript-system` families
  were unreachable for AppleScript run via `osascript -e`.
- `skip_meta_skills` directive is mode-aware. The original wording
  included "execute it directly" in **every** mode, which contradicted
  plan mode's "plan first, don't execute yet" intent.

### Changed

- **Default sandbox is now `danger-full-access`** (was mode-derived
  `workspace-write`). This is the practical fix for the reported
  derailment where Codex misinterpreted `.git/` write denials as puzzles
  to solve (attempting `osascript` / `display dialog` to reach a
  human-operated Terminal). Users who relied on the pre-v1.2.0 strict
  default can set `sandbox_policy: "workspace-write"` in their
  `config.yaml`.
- `src/lib/AGENTS.md` sandbox-policy table updated to reflect the new
  default. The prior "we do not use `dangerFullAccess`" invariant was a
  reflection of then-current behavior, not a permanent architectural
  constraint.

### Docs

- `skill/references/config-reference.md` — three new config keys
  documented with their full matrices.
- `skill/references/notification-format.md` — `[WARNING]` tag added
  with format template, emission conditions, non-terminal semantics.
- `skill/references/orchestration-flows.md` — `workspace-dirty` phase
  row added to the phase table.



Audit-driven cleanup release. Resolves `unexpected-bridge-observations/`
entries 06 and 08 end-to-end, completes the remaining 2 of 5 fixes for
obs 07, updates specs + reports to reflect the post-fix reality. No
breaking changes.

### Added

- **`bridge config show [--json]`** — prints the effective merged config
  along with each of the four source files (and whether each exists).
  `*` markers in rendered output flag keys that differ from
  `DEFAULT_CONFIG`. Closes obs 07 fix #4.
- **Workspace-root config layer**. `loadConfig` now reads four layers
  instead of three: `DEFAULT_CONFIG < skill-dir < workspaceRoot < cwd`.
  A user running a command from a subdir of a git repo now picks up
  `$(git rev-parse --show-toplevel)/config.yaml` between the skill
  defaults and any cwd-level override. Closes obs 07 fix #5.
- **`initSession` in the review handlers** — both `review` and
  `adversarial-review` now create `.events` + `.ndjson` files for their
  thread and write a `TURN_COMPLETED` record. `adversarial-review`
  additionally calls `writeReview` to persist its findings to
  `{threadId}.review.json` (the previously-phantom function now has a
  real caller). `bridge summary <review-tid>` and Monitor tooling can
  now inspect review threads. Closes obs 08.

### Changed

- **`loadState` is now self-reaping** — on every state read, walks the
  job list, probes each `status ∈ {running, queued}` job's pid with
  `process.kill(pid, 0)`, and transitions ESRCH entries to `orphaned`
  with a dated `errorMessage`. Idempotent + cheap + writes-back only
  when something actually changed. Closes obs 06. Empirically verified:
  inject a job with `pid: 999999`, run `bridge status`, the job flips to
  `orphaned`.

### Fixed

- Update-check now honors `GITHUB_TOKEN` / `GH_TOKEN` env vars. Without
  auth, unauthenticated requests against a private repository return 404
  and the check silently skips (`check_skip_reason:
  "fetch-failed-no-cache"`). With a token set, the check succeeds and
  returns the real `latest_version`. GH Actions workflows and developers
  running `gh auth login` get working checks for free; nothing else
  breaks if the token is absent.

### Docs

- `gherkin-tests-v2/07-orchestration/04-cancel-interrupts-running-turn.md`
  scenario 3 split into 3a (zero active → `NO_ACTIVE_JOBS`), 3b (exactly
  one → cancels it), 3c (multiple → `AMBIGUOUS_CANCEL`, observed live).
- `gherkin-tests-v2/LIVE_RUN_REPORT.md` promotes `03-config/01` and
  `03-config/02` from FAIL to PASS with the commit ref that landed the
  fix.
- `unexpected-bridge-observations/README.md` marks obs 06, 07, 08 as
  resolved with dates + mechanism notes.
- `skill/references/config-reference.md` documents the new 4-layer
  resolution order (was 3-layer).
- `README.md` grows a "staying up to date" section documenting
  `bridge update`, `bridge update --force`, the silent-notice opt-out
  env var, and the "re-run `skills add`" upgrade recipe. Also grows a
  "seeing what config is in effect" section pointing at `bridge config
  show` as the authoritative debug tool for config drift.
- `README.md` "what you get" bullets gain the self-healing-state
  reaper and the built-in update check as first-class features.
- `.github/workflows/release.yml` now builds the GitHub Release body
  from the matching `## [X.Y.Z]` section in `CHANGELOG.md`, prepended
  with an `## Install` snippet so users landing on the Release page
  see the install command at the top. The commit-based auto-summary
  still appends below for completeness.

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
