# Changelog

All notable changes to `codex-bridge` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Unreleased changes live under the `Unreleased` section until a release is cut —
see the "Adding an entry" section at the bottom for the workflow.

## [Unreleased]

## [1.2.5] — 2026-04-19

Round-2 follow-ups after 1.2.4 landed in production. The acute bridge
bugs in 1.2.4 are gone (no more orphaned foreground jobs, no more false
120s stalls, no more JOB_NOT_FOUND on thread UUIDs for live jobs), but
three more derailment classes showed up under real use:

  1. release hygiene — 1.2.4 itself shipped with a hard-coded
     `BRIDGE_VERSION = "1.2.3"` and a SKILL.md frontmatter reading
     "1.2.3", so `version --json` reported a stale number and three
     doc sites still taught the old 120s watchdog;
  2. UX steering — agents reading stderr `[codex] Thread ready (…)`
     progress lines grabbed the thread UUID as a job handle and hit
     JOB_NOT_FOUND on Monitor; the canonical SKILL.md example did
     nothing to discourage this;
  3. pipeline visibility — `[PIPELINE:*]` only had start-tags, so an
     orchestrator seeing `[DONE]` couldn't tell whether the auto-fix
     stage was still writing to the repo; round-3 spent 15 min blindly
     reconciling a phantom "pipeline rewrote my files" diff.

### Fixed

- **Version drift (R1/R2/R3):** single source of truth — `BRIDGE_VERSION`
  is imported from `package.json` at build time via
  `import … with { type: "json" }` and esbuild inlines it. Pre-1.2.5
  the constant was hard-coded in `src/codex-bridge.mjs:620` and drifted
  whenever `package.json` was bumped without a corresponding src edit.
  `skill/SKILL.md` frontmatter and doc references to "120 s watchdog"
  are swept.
- **`[PIPELINE:*]` start-tags had no matching done-tags (P1/P3):** every
  pipeline stage (`diff`, `review`, `fix`, `check`) now emits both
  `[PIPELINE:<stage>]` (start) and `[PIPELINE:<stage>:done]` (end) to
  the events file. The fix stage's done-tag carries a
  `files=[…]` detail listing exactly which files the pipeline wrote
  (computed from a `git diff --name-only HEAD` before/after snapshot).
  Terminal `[PIPELINE:done]` / `[PIPELINE:failed]` closes out the
  whole pipeline. `result.pipeline.touchedFiles` surfaces the fix list
  on `task --json` for scripted consumers.
- **`kindLabel: "rescue"` for every user task (U3):** misleading — the
  historical "rescue" label was stop-gate-review-only and made
  orchestrators think every `status` entry was an auto-recovery job.
  `buildTaskRunMetadata` now sets `kindLabel: "task"` for user tasks
  and `kindLabel: "rescue-review"` for stop-gate jobs; legacy state
  records without an explicit `kindLabel` fall through to `"task"`
  instead of `"rescue"`.

### Added

- **Foreground-task footer (U2):** non-JSON `task`/`send` rendered
  output ends with `Job: <id> · Events: <path> · Monitor: <command>`.
  Single line, canonical jobId — orchestrators no longer need to run
  `--json | jq` or pattern-match the threadId from stderr to get the
  handle that `status`/`result`/`events` accept.
- **`--no-pipeline` flag (P2)** on `task` / `send` — per-invocation
  override for `auto_review:false` + `post_task_prompt:""`. Agents
  orchestrating their own completion checks no longer have to edit
  `config.yaml`.
- **Configurable turn / pipeline / question timeouts (T1–T4):**
  `--turn-plan-ms`, `--turn-default-ms`, `--pipeline-stage-timeout-ms`,
  `--pipeline-total-timeout-ms`, `--question-timeout-ms` on `task`
  (plus a single `--turn-timeout-ms` on `send`). All five new config
  keys in `DEFAULT_CONFIG`: `turn_plan_ms`, `turn_default_ms`,
  `pipeline_stage_ms`, `pipeline_total_ms`, `question_answer_ms`.
  Resolution flag → config → default; malformed values throw usage
  (exit 2). Same pattern as the 1.2.4 `--idle-timeout-ms` fix.
- **`--quiet` flag (D1)** on `task` / `send` — suppresses the
  `[codex] …` stderr progress stream. Eliminates the threadId-grab
  vector entirely for agents that tail Monitor / `events --follow`.
- **`events --follow --json` final envelope adds `terminalTag`,
  `terminalLine`, `elapsedMs` (D3):** Monitor can now distinguish
  `[DONE]` close from timeout without re-reading the file.
- **`status --prune-orphans` / `--cleanup` subcommand (D4):** walks
  `state.jobs` for `status:"running"|"queued"` with dead PIDs
  (`process.kill(pid, 0) → ESRCH`), transitions each to
  `status:"orphaned"` with a reap-note. Idempotent. Closes the
  observation/06 fix list.
- **`result.eventsPath` and `result.jobId` at payload top level (D6):**
  previously agents had to regex `result.monitor.command` to extract
  the events path. Now they read a typed field.
- **Crash-log trap (A3):** `process.on("unhandledRejection")` and
  `process.on("uncaughtException")` handlers write a JSON dump to
  `~/.codex-bridge/crashes/<ts>-<pid>.log` and emit a single stderr
  pointer line before the process exits. Does not swallow the crash
  — exit code still non-zero — but closes the
  "launcher exit 1 with no explanation" observability gap (the
  reported circuit-breaker suspicion was incorrect: the breaker
  only logs `WARNING`/ndjson and leaves exit code alone).

### Changed

- **SKILL.md canonical example (U1):** rewritten to use `--json` and
  paste `result.monitor.tool_hint` into Claude Code's Monitor tool.
  Steers agents away from grabbing the thread UUID out of stderr
  progress lines — the single strongest derailment signal in the
  round-1 and round-2 logs.
- **"When NOT to use Monitor" section (S1)** in
  `skill/references/monitor-patterns.md` — Monitor is only for
  codex-bridge `.events` files. `xcodebuild` / `npm test` / `pytest`
  should use `Bash` with `run_in_background`. The transcript's 9
  Monitor invocations on a single `xcodebuild` run is the exact
  anti-pattern.
- **"Post-[DONE] checklist" (S2/S3)** in
  `skill/references/orchestration-flows.md` — don't edit files Codex
  just wrote; don't use a generator (xcodegen / protoc / prisma /
  etc.) as verification for its own output (ordering is
  non-deterministic); verify on the committed tree, not the working
  copy. Addresses round-3's regeneration-noise reconciliation.
- **DerivedData note (S4)** in
  `skill/references/error-recovery.md` — in Claude Code on macOS,
  Xcode's `build.db` fails if DerivedData lives inside the workspace.
  Use `-derivedDataPath /tmp/<project>-dd …`.

### Docs

- New gherkin scenarios under `gherkin-tests-v2/`:
  - `03-config/XX-version-source-of-truth.md`
  - `06-artifacts/XX-pipeline-done-tags-on-events.md`
  - `05-ambiguities/XX-task-kindlabel-not-rescue.md`
  - `01-lifecycle/XX-turn-timeout-configurable.md`
  - `07-orchestration/XX-status-prune-orphans.md`
  - `04-errors/XX-uncaught-exception-leaves-crash-log.md`
  - `07-orchestration/XX-events-json-final-envelope.md`
  - `06-artifacts/XX-foreground-task-footer.md`
  - `07-orchestration/XX-no-pipeline-flag.md`

### Pushback on A3 (circuit breaker → exit 1)

The user's suspicion that v1.2.3's `fix(wrapper-regex)` circuit breaker
trips exit 1 on some invocation pattern does not hold up against the
code. `src/codex-bridge.mjs:1706-1754` shows the breaker only writes
a `[WARNING]` event + `CIRCUIT_BREAKER` ndjson record, and sets
`turnInterrupted:false`. It never mutates exit code. Could not
reproduce the reported exit-1 in a live smoke (`task --write
--background 2>&1 | tee | head`, `task … > /tmp/log 2>&1`, etc., all
exit 0). Instead of a speculative pattern-tightening that would risk
false-negatives on the legitimate Codex-wrapper detection, 1.2.5
installs an uncaughtException / unhandledRejection trap that records
a crash log next time an unexplained exit-1 occurs. That trail will
identify the real source — whatever it turns out to be.

### Architectural follow-ups (still out of scope)

Still deferred (round-1 list still valid): fg/bg unification, broker-
socket liveness as the idle signal, typed JSON-RPC pushback replacing
tag-on-stdout, supervisor daemon.

## [1.2.4] — 2026-04-19

Three bugs surfaced during a live Claude→Codex delegation. All three
were bridge-side, not caller error.

### Fixed

- **Foreground `task` no longer dies on EPIPE.** Installing `task` output
  through a closed pipe (`bridge task … | tee … | head -N`) previously
  killed the wrapper Node process mid-turn and left the Codex-side job
  `orphaned` while the app-server was still healthy. `main()` now ignores
  `SIGPIPE` and swallows `EPIPE` / `ERR_STREAM_DESTROYED` on stdout and
  stderr (`src/codex-bridge.mjs` top-level guards). Background workers
  were already immune via `stdio:"ignore"`; this brings foreground paths
  to parity.
- **`events <thread-id>` now works for running jobs.** `resolveResultJob`
  previously checked `job.threadId` only in the terminal-status branch,
  so a thread UUID passed to `events`/`wait` for a still-running job
  fell through to `JOB_NOT_FOUND`. The active-match block now also
  compares `job.threadId`, restoring the "either id works" contract
  advertised in `SKILL.md:77` for all job states.

### Changed

- **Idle-timeout watchdog is now configurable; default raised from
  120s to 300s.** Reasoning-heavy Codex turns (e.g. planning across
  many files between `item.completed` notifications) could legitimately
  exceed the prior 120s gap and false-positive as "stuck." Three
  resolution layers now apply (most specific wins):
  - `--idle-timeout-ms <ms>` flag on `task` and `send`
  - `idle_timeout_ms` in any config.yaml layer
  - Built-in default `300_000` in `DEFAULT_CONFIG` (`src/lib/config.mjs`)
  A malformed flag value throws `usage` (exit 2) rather than silently
  falling back — callers notice the typo. Idle-timeout error message
  reworded from "(possible stuck)" to "(idle timeout)." — the regex
  in `src/lib/cli-errors.mjs:171` still matches both.

### Docs

- New gherkin scenarios:
  - `04-errors/06-foreground-task-survives-epipe.md`
  - `01-lifecycle/04-idle-timeout-configurable.md`
  - `07-orchestration/09-events-accepts-thread-id-for-running-job.md`

### Root-cause trace

Broader architectural follow-ups (fg/bg unification, broker-socket
liveness, typed identifier resolver, feature-flag orthogonalization)
are scoped for a separate release.

## [1.2.3] — 2026-04-19

Wrapper-regex widening. v1.2.2's `isFailureHidingWrapper` matched
`... & [optional sleep]; kill` but missed the real form observed in
Codex logs: `... & pid="$!"; sleep 2; kill -INT $pid; wait $pid` — the
`pid=` assignment between the `&` and the `kill` broke the old regex.
v1.2.3 widens the `&-kill` arm to `(?:^|[^&])&(?![&])[\s\S]{0,200}?\bkill\b`
which (a) catches the real Codex pattern and (b) correctly *excludes*
`foo && kill bar` where `&&` + `kill` is a legitimate "after success"
construct (bonus false-positive fix over v1.2.2).

### Fixed

- `isFailureHidingWrapper` regex widened to catch the observed real
  Codex wrapper form `... & pid="$!"; sleep N; kill -TERM $pid`. The
  v1.2.2 regex expected `kill` to directly follow the `&` (possibly
  after a `sleep`); the new single-`&`-then-anything-then-`kill` form
  catches any shell background-and-kill idiom within 200 chars.
- `foo && kill bar` no longer matches the wrapper detector (the v1.2.2
  version did — bonus false-positive elimination).

### Docs

- `07-orchestration/07` predicate gains two scenarios: `s10` pins the
  real-form wrapper detection, `s11` is the `&&` regression guard.
  Predicate 11/11 passes offline.



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
