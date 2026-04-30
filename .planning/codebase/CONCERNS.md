---
analysis_date: 2026-04-30
last_mapped_commit: 16f4fd188f47160bdaddabb9813c6fe67e486d5d
evidence_scope: current non-Markdown source, tests, and CI workflows only
---

# Codebase Concerns

**Analysis Date:** 2026-04-30

## Evidence Boundary

- Evidence is from current code, tests, and workflow files such as `src/codex-bridge.mjs`, `src/adapters/codex/*.mjs`, `src/lib/*.mjs`, `hooks/*.mjs`, `esbuild.config.mjs`, `.github/workflows/*.yml`, and `test/*.test.mjs`.
- Repository Markdown files are excluded as evidence. Some tests mention Markdown paths as fixtures or generated surfaces; those tests are treated only as executable contract evidence.
- Current risks are separated from invariants already covered by tests. Do not file new phases for tested invariants unless changing the underlying contract.

## Tech Debt

**Backend adapter registry is not the runtime abstraction yet:**
- Issue: `src/adapters/index.mjs:18-27` loads only the `codex` adapter, while `src/adapters/codex/index.mjs:14-51` exposes lifecycle methods that throw `NOT_IMPLEMENTED`. Main CLI flows still call `src/adapters/codex/codex.mjs` directly.
- Files: `src/adapters/index.mjs`, `src/adapters/codex/index.mjs`, `src/adapters/codex/codex.mjs`, `src/codex-bridge.mjs`
- Impact: Adding another backend is not a small config change. New backends must implement dispatch, event streaming, result lookup, cancellation, capability validation, error mapping, and CLI routing, or they will pass selection but fail at runtime.
- Fix approach: Treat multi-adapter support as a dedicated phase. First wire the Codex adapter through the registry for one user-facing command, then migrate remaining direct `codex.mjs` call sites.
- Detection/verification: Extend `test/adapter-registry.test.mjs` with a fake fully implemented adapter and a command-level test that proves `CODEX_BRIDGE_BACKEND` routes real CLI execution.
- Phase relevance: Any backend, routing, resume, steering, or questions phase.

**Artifact registry writes are partially transactional but not locked:**
- Issue: `src/lib/registry.mjs:21-25` defines the registry as a minimum v1 API. `writeMeta` and `writeVerdict` use temp files plus rename (`src/lib/registry.mjs:95-112`, `src/lib/registry.mjs:173-193`), but there is no cross-process lock or fsync. `appendEvent` explicitly notes cross-process or oversized payload interleaving risk (`src/lib/registry.mjs:196-205`).
- Files: `src/lib/registry.mjs`, `src/codex-bridge.mjs`
- Impact: Concurrent review, verdict, merge, and event writers can lose ordering or overwrite metadata. Forensics can become inconsistent exactly when several agents operate on the same task.
- Fix approach: Add per-task lock helpers before expanding registry consumers. Reuse the stale-lock discipline from `src/lib/state.mjs:79-170` rather than adding a second ad hoc lock style.
- Detection/verification: Add tests that run concurrent `writeMeta`, `writeVerdict`, and `appendEvent` calls from separate Node processes and verify readable final JSON plus ordered event lines.
- Phase relevance: Review loops, merge automation, verdict tracking, artifact retention, cancellation.

**Worktree dispatch can continue after registry metadata fails:**
- Issue: `--worktree-auto` creates an isolated worktree and writes registry metadata, but metadata failures are swallowed at `src/codex-bridge.mjs:3726-3737` before execution moves to the worktree.
- Files: `src/codex-bridge.mjs`, `src/lib/registry.mjs`, `src/lib/git.mjs`
- Impact: A task can run and modify a branch while later `review`, `verdict`, or `merge` cannot find `meta.json`. That leaves recovery dependent on manual branch/worktree inspection.
- Fix approach: Make registry persistence a hard precondition for `--worktree-auto`, or add a recovery command that reconstructs `meta.json` from `git worktree list` and branch naming.
- Detection/verification: Inject a `writeMeta` failure in a CLI-level `task --worktree-auto --write` test and assert the worktree is pruned or the command fails before dispatch.
- Phase relevance: Worktree isolation, merge gates, background jobs, multi-agent dispatch.

**Closed-loop iterate is a command stub:**
- Issue: `handleIterate` returns `status: "not-yet-orchestrated"` and a manual next-action argv (`src/codex-bridge.mjs:4794-4860`).
- Files: `src/codex-bridge.mjs`, `src/lib/registry.mjs`, `src/lib/git.mjs`
- Impact: Slash commands can present an iterate surface, but the CLI does not yet run task -> review -> verdict -> redispatch automatically. Future automation must not assume loop completion exists.
- Fix approach: Implement orchestration around background task state, review execution, verdict persistence, and bounded iteration count. Keep the current structured argv behavior as a compatibility fallback.
- Detection/verification: Add an end-to-end fake-adapter iterate test that reaches approved, reaches iteration max, and preserves failed intermediate artifacts.
- Phase relevance: Review convergence, autonomous repair loops, merge automation.

**Release packaging and plugin packaging are separate surfaces:**
- Issue: The build workflow validates both `skill/` and `plugin/` generated outputs (`.github/workflows/build.yml:39-88`), but the release workflow stages only `skill/` into `dist/codex-bridge/` (`.github/workflows/release.yml:30-46`).
- Files: `.github/workflows/build.yml`, `.github/workflows/release.yml`, `esbuild.config.mjs`
- Impact: Plugin layout can be correct in CI while the tagged release artifact still distributes only the legacy skill payload. A phase that changes canonical plugin installation must update release packaging, not just build checks.
- Fix approach: Decide whether releases must include plugin layout. If yes, add a plugin artifact and release smoke checks for `.claude-plugin/plugin.json`, `plugin/scripts/codex-bridge.mjs`, and hook paths.
- Detection/verification: Add release-dry-run tests or a workflow step that inspects generated release archives for both intended install layouts.
- Phase relevance: Distribution, marketplace/plugin migration, install/update flows.

## Known Bugs

**Completion-check prose can mark a pipeline complete:**
- Symptoms: If the completion-check turn succeeds but returns non-JSON text, the parser treats it as `complete: true` with no missing items (`src/adapters/codex/pipeline.mjs:336-345`).
- Files: `src/adapters/codex/pipeline.mjs`, `test/auto-pipeline-turn-watchdog.test.mjs`
- Trigger: A completion-check model response that describes unresolved work in prose but is not valid JSON.
- Impact: The auto pipeline can emit a completed result even when the checker did not follow the schema. Tests cover failed checks, unstructured review attention, and timeout paths, but this fallback remains a false-positive risk.
- Workaround: Keep completion-check prompts/schema strict and inspect final output when the check summary is plain prose.
- Fix approach: Treat invalid completion-check JSON as incomplete unless there is an explicit allowlist phrase and no issue language.
- Detection/verification: Add a test where `finalMessage` is prose containing missing work and assert `completionResult.complete === false`.
- Phase relevance: Pipeline reliability, completion verification, autonomous fixes.

**Legacy stop-review hook behavior can diverge from the canonical hook:**
- Symptoms: `hooks/stop-review-gate-hook.mjs` hardcodes a bridge script path through `skill/scripts` (`hooks/stop-review-gate-hook.mjs:15-16`), has its own legacy gate migration path (`hooks/stop-review-gate-hook.mjs:237-287`), and returns inert on setup failure or not-ready Codex (`hooks/stop-review-gate-hook.mjs:305-329`).
- Files: `hooks/stop-review-gate-hook.mjs`, `hooks/stop-gate.mjs`, `.github/workflows/build.yml`, `test/plugin-surfaces.test.mjs`
- Trigger: A generated or legacy hook surface invokes `stop-review-gate-hook.mjs` instead of the newer `stop-gate.mjs` behavior.
- Impact: The newer Stop gate blocks on setup failure, readiness failure, review timeout, and failed review command, while the legacy hook can fail open in setup/readiness cases. CI only checks that generated hook files exist and plugin hooks avoid stale script paths.
- Workaround: Prefer the canonical Stop hook surface configured through `hooks/hooks.json` and generated plugin hooks.
- Fix approach: Delete, replace, or route the legacy hook through the canonical implementation after confirming all install layouts.
- Detection/verification: Add a test proving no shipped hook entry references `stop-review-gate-hook.mjs`, or update its behavior to match `hooks/stop-gate.mjs`.
- Phase relevance: Stop gate reliability, generated hook migration, plugin/skill compatibility.

## Security Considerations

**Auto-update executes a global installer from normal command hot paths:**
- Risk: `maybeTriggerAutoApply` asynchronously checks GitHub releases and can spawn `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y` outside the caller's lifecycle (`src/codex-bridge.mjs:169-241`).
- Files: `src/codex-bridge.mjs`, `src/lib/update-check.mjs`, `test/auto-apply.test.mjs`, `test/update-check.test.mjs`
- Current mitigation: `--json`, help/version/update subcommands, and `CODEX_BRIDGE_NO_UPDATE_CHECK=1` skip the hot-path update (`src/codex-bridge.mjs:171-175`). Apply attempts are rate-limited through cache markers (`src/lib/update-check.mjs:156-198`). Tests cover spawn-error logging and apply-claim behavior.
- Recommendations: Keep update output detached from command stdout/stderr. Add a dry-run or explicit opt-in path before expanding install behavior. Verify installer failure, cache corruption, and concurrent invocations.
- Phase relevance: Update UX, enterprise installs, reproducibility, CI-safe command behavior.

**Review and session artifacts can contain repository content:**
- Risk: Review context can inline branch or working-tree diffs (`src/lib/git.mjs:397-443`), session logging writes diffs to the session directory (`src/lib/session-log.mjs:150-163`), and tracked file diffs are not redacted.
- Files: `src/lib/git.mjs`, `src/lib/session-log.mjs`, `src/adapters/codex/codex.mjs`
- Current mitigation: Untracked files are represented as metadata markers rather than full content in session diffs (`src/lib/session-log.mjs:242-265`), and untracked path/content handling is bounded and path-checked (`src/lib/session-log.mjs:185-223`, `src/lib/git.mjs:253-319`).
- Recommendations: Any phase that broadens context capture should add explicit redaction tests and document which artifacts may leave the local machine through Codex app-server calls.
- Phase relevance: Privacy-sensitive review, artifact retention, telemetry, context collection.

**Hook transcript hydration has shutdown-time access to recent assistant output:**
- Risk: Stop hooks read Claude transcript JSONL and embed the latest assistant text into a temporary prompt (`hooks/stop-gate.mjs:164-238`, `hooks/stop-gate.mjs:465-501`; legacy path `hooks/stop-review-gate-hook.mjs:101-160`, `hooks/stop-review-gate-hook.mjs:345-357`).
- Files: `hooks/stop-gate.mjs`, `hooks/stop-review-gate-hook.mjs`, `test/plugin-surfaces.test.mjs`
- Current mitigation: The canonical hook writes the prompt to a temp file for argv safety and removes it after the review; the legacy hook uses file mode `0o600` for the temp prompt (`hooks/stop-review-gate-hook.mjs:345-360`).
- Recommendations: Keep prompt temp files permission-restricted, avoid logging prompt bodies, and add tests for cleanup on review timeout and spawn failure.
- Phase relevance: Hook hardening, Stop gate changes, audit logging.

## Performance Bottlenecks

**Broker serializes long streaming work:**
- Problem: The broker rejects new non-interrupt work while `activeRequestSocket` or `activeStreamSocket` is set (`src/adapters/codex/broker.mjs:483-491`).
- Files: `src/adapters/codex/broker.mjs`, `test/broker-stream-release-ordering.test.mjs`
- Cause: A single shared app-server session has one active stream/request owner. Stream release depends on receiving upstream terminal notifications for root and sub-threads (`src/adapters/codex/broker.mjs:51-212`).
- Improvement path: Keep the single-stream contract unless app-server supports multiplexing. If adding new streaming methods, update `STREAMING_METHODS` and stream tracker tests before shipping.
- Phase relevance: Parallel agents, background jobs, broker throughput.

**Large diffs push review context into self-collect mode:**
- Problem: `collectReviewContext` measures file count and diff bytes before deciding whether to inline diffs (`src/lib/git.mjs:397-443`).
- Files: `src/lib/git.mjs`, `src/adapters/codex/pipeline.mjs`, `src/codex-bridge.mjs`
- Cause: Inline diff safety caps protect prompt size, but large changes require the reviewer to run its own read-only git commands.
- Improvement path: Add chunked diff summaries or per-file selection instead of all-or-self-collect.
- Phase relevance: Large PR reviews, generated bundle changes, release migrations.

**Synchronous filesystem and git work are on command/hook paths:**
- Problem: State, registry, session logging, git context, and hooks use synchronous writes/spawns (`src/lib/state.mjs`, `src/lib/registry.mjs`, `src/lib/session-log.mjs`, `hooks/stop-gate.mjs`).
- Files: `src/lib/state.mjs`, `src/lib/registry.mjs`, `src/lib/session-log.mjs`, `hooks/stop-gate.mjs`
- Cause: Synchronous work simplifies process-exit and hook behavior, but can stall CLI invocations under slow disk, locked git metadata, or long transcript files.
- Improvement path: Keep synchronous writes for append-only critical event paths, but add timeouts and diagnostics around heavier git/transcript operations.
- Phase relevance: Hook responsiveness, large repos, multi-agent background runs.

## Fragile Areas

**Broker stream-release ordering is a high-risk contract:**
- Files: `src/adapters/codex/broker.mjs`, `test/broker-stream-release-ordering.test.mjs`
- Why fragile: Release depends on correlating `turn/start`, `review/start`, and `thread/compact/start` with notification shapes and thread IDs. Early sub-thread completions are buffered until the broker learns about the thread (`src/adapters/codex/broker.mjs:176-186`).
- Safe modification: Do not add or rename streaming methods without adding broker tests for downstream disconnect, same-chunk response/completion, early sub-thread completion, root completion, and clear-all behavior.
- Test coverage: Strong targeted tests exist in `test/broker-stream-release-ordering.test.mjs`. Remaining gap is live app-server protocol drift.

**Stop review gate spans setup, state, lock files, hooks, and generated plugin surfaces:**
- Files: `src/codex-bridge.mjs`, `hooks/stop-gate.mjs`, `hooks/hooks.json`, `test/plugin-surfaces.test.mjs`
- Why fragile: Setup migrates legacy state to a project lock, suppresses the gate when the official plugin is present, and the hook blocks or allows shutdown based on setup readiness and review output (`src/codex-bridge.mjs:859-953`, `src/codex-bridge.mjs:1048-1099`, `hooks/stop-gate.mjs:414-527`).
- Safe modification: Update setup JSON fields, hook behavior, generated hooks, and tests in one phase. Preserve the kill switch and active-lock diagnostic behavior.
- Test coverage: Tests cover hook path wiring, readiness blocking, timeout margins, kill-switch diagnostics, and hook error handling. A legacy migration test is skipped in `test/plugin-surfaces.test.mjs`, so do not treat that path as fully protected.

**Generated bundles can drift from source across multiple layouts:**
- Files: `esbuild.config.mjs`, `.github/workflows/build.yml`, `skill/`, `plugin/`, `commands/`, `agents/`, `hooks/`
- Why fragile: One source edit can require generated changes in `skill/` and `plugin/`; commands, agents, config, prompts, schemas, templates, scripts, and hooks all have copied outputs (`esbuild.config.mjs:21-75`, `esbuild.config.mjs:107-123`).
- Safe modification: After touching runtime source, prompts, schemas, templates, root commands/agents/hooks, or `skill/config.yaml`, run `npm run build` and inspect generated drift.
- Test coverage: CI checks committed generated paths and basic bundle sanity (`.github/workflows/build.yml:39-151`). It does not run live Codex app-server round trips.

**App-server protocol assumptions are narrow and literal:**
- Files: `src/adapters/codex/protocol.mjs`, `src/adapters/codex/codex.mjs`, `test/app-server-client.test.mjs`, `test/app-server-abort.test.mjs`, `test/codex-capture.test.mjs`
- Why fragile: Outbound messages are newline JSON objects with `id`, `method`, and `params`, client info is fixed, and server requests are rejected unless a handler resolves them (`src/adapters/codex/protocol.mjs:25-41`, `src/adapters/codex/protocol.mjs:206`, `src/adapters/codex/protocol.mjs:277-303`).
- Safe modification: Treat every method or notification shape change as a protocol migration. Update code, `.d.ts` declarations, capture logic, and tests together.
- Test coverage: Tests cover unsupported server-request rejection, same-client request resolution, transport exit rejection, broker fallback rules, abort cleanup, and idle/turn timeout cleanup. Remaining gap is upstream app-server schema drift.

**Session artifacts are best-effort while job state is authoritative:**
- Files: `src/lib/session-log.mjs`, `src/lib/state.mjs`, `src/codex-bridge.mjs`, `test/session-log.test.mjs`
- Why fragile: `logNdjson`, `logEvent`, `writeDiff`, `writePlan`, and `writeReview` swallow write failures (`src/lib/session-log.mjs:32-83`). Commands such as wait/events rely on event files plus polling.
- Safe modification: Keep state transitions and event tags in sync. When adding terminal events, test both job state and `.events` behavior under missing or unwritable files.
- Test coverage: Tests cover command quoting and untracked file markers. There is no fault-injection coverage for unwritable session directories.

## Scaling Limits

**One broker session can become a queue choke point:**
- Current capacity: One active streaming request plus interrupt handling per shared broker process.
- Limit: Additional non-interrupt streaming or request work receives a busy error until the active owner releases (`src/adapters/codex/broker.mjs:483-491`).
- Scaling path: Add broker sharding by workspace/job or app-server multiplexing only after live app-server behavior is verified.

**State lock defaults favor short CLI invocations:**
- Current capacity: `src/lib/state.mjs` uses a 5 second lock timeout and 30 second stale-lock window (`src/lib/state.mjs:20-24`).
- Limit: A paused process, slow filesystem, or heavily concurrent background jobs can trip lock timeout even if state is not corrupted.
- Scaling path: Add backoff/diagnostics before increasing concurrency. Preserve inode-protected stale lock deletion tested in `test/state-stale-lock-toctou.test.mjs`.

**CI is static and short-running:**
- Current capacity: Build job timeout is 5 minutes and tests timeout after 2 minutes (`.github/workflows/build.yml:16-37`).
- Limit: CI validates bundles, unit tests, and CLI envelope probes, but accepts missing Codex CLI for version checks and does not exercise authenticated app-server sessions (`.github/workflows/build.yml:105-126`).
- Scaling path: Add an optional integration workflow for authenticated Codex environments rather than overloading the default PR gate.

## Dependencies at Risk

**Codex CLI and app-server protocol:**
- Risk: Runtime requires `codex --version` and `codex app-server --help`; protocol code spawns `codex app-server` directly and falls back from stale saved broker endpoints only in specific cases (`src/adapters/codex/protocol.mjs:345-386`, `src/adapters/codex/protocol.mjs:561-575`).
- Impact: Upstream CLI behavior, app-server method names, socket behavior, or auth state changes can break core commands without failing static tests.
- Migration plan: Keep unit tests for local invariants, then add live smoke tests for `setup --json`, one `turn/start`, one review, and broker reuse.

**Git and filesystem semantics:**
- Risk: Worktree creation, branch fallback, merge, pruning, lock files, temp directories, and session artifacts rely on local Git and POSIX-like filesystem behavior (`src/lib/git.mjs:527-861`, `src/lib/state.mjs`, `src/lib/broker-lifecycle.mjs`).
- Impact: Linked worktrees, dirty checkouts, restricted `.git` metadata, stale sockets, or Windows named pipes can block or misreport jobs.
- Migration plan: Add platform-specific integration tests for named pipes, stale worktree cleanup, dirty task worktree refusal, and broker session teardown.

**External update and release services:**
- Risk: Update checks call the public GitHub releases API anonymously and hot-path auto-apply shells out through `npx` (`src/lib/update-check.mjs:228-315`, `src/codex-bridge.mjs:217-224`).
- Impact: Rate limiting, network failures, package installer changes, or global install policy can cause stale installs or silent apply failures.
- Migration plan: Keep update checks non-blocking, add explicit status surfaces for last apply failure, and cover cache fallback behavior with tests.

## Missing Critical Features

**Merge does not run acceptance tests yet:**
- Problem: `mergeSubagentBranch` returns `tests_passed: null` when tests are requested, with comments saying follow-up execution will read acceptance criteria later (`src/lib/git.mjs:695-831`).
- Blocks: Treating `merge` as full verification for generated code. Merge currently proves verdict/branch SHA and fast-forward safety, not task-specific test success.
- Phase relevance: Merge automation, ship workflows, review convergence.

**PR mode is explicit but not implemented:**
- Problem: `merge --pr` throws `MERGE_PR_NOT_IMPLEMENTED` (`src/codex-bridge.mjs:5084-5090`).
- Blocks: Workflows that need branch push and pull request creation instead of local fast-forward merge.
- Phase relevance: GitHub integration, release workflows, team review.

**Artifact registry lacks cleanup, compaction, and iteration-chain helpers:**
- Problem: `src/lib/registry.mjs:21-25` documents full helpers as follow-ups.
- Blocks: Long-running teams can accumulate stale task directories, orphaned events, and hard-to-query iteration history.
- Phase relevance: Job lifecycle, storage management, dashboard/status UX.

## Test Coverage Gaps

**Live Codex app-server round trips are not covered by default CI:**
- What's not tested: Authenticated `codex app-server` initialization, `turn/start`, `review/start`, broker reuse, and real notification streams.
- Files: `.github/workflows/build.yml`, `src/adapters/codex/protocol.mjs`, `src/adapters/codex/codex.mjs`, `src/lib/broker-lifecycle.mjs`
- Risk: Static protocol and fake-process tests can pass while real app-server behavior changes.
- Priority: High for protocol, broker, and review pipeline phases.

**Registry concurrency is not covered:**
- What's not tested: Cross-process `writeMeta`, `writeVerdict`, and `appendEvent` races.
- Files: `src/lib/registry.mjs`
- Risk: Multi-agent review/merge workflows lose artifact consistency.
- Priority: High before expanding registry consumers.

**Stop gate has a skipped legacy migration test and dual hook implementations:**
- What's not tested: Legacy stop-review hook migration behavior across generated install layouts.
- Files: `hooks/stop-gate.mjs`, `hooks/stop-review-gate-hook.mjs`, `test/plugin-surfaces.test.mjs`
- Risk: Some installed hooks fail open or call stale script paths.
- Priority: Medium-high for hook or plugin-surface phases.

**Auto-update path is only partially tested:**
- What's not tested: Detached installer success/failure lifecycle, installer stdout/stderr isolation across platforms, cache corruption, and update behavior under real network rate limiting.
- Files: `src/codex-bridge.mjs`, `src/lib/update-check.mjs`, `test/auto-apply.test.mjs`, `test/update-check.test.mjs`
- Risk: Background global install changes can be hard to diagnose or reproduce.
- Priority: Medium.

**Windows named-pipe broker behavior lacks end-to-end coverage:**
- What's not tested: Named pipe endpoint creation, stale endpoint probing, teardown, and explicit broker failure on Windows.
- Files: `src/lib/broker-endpoint.mjs`, `src/lib/broker-lifecycle.mjs`, `src/adapters/codex/protocol.mjs`
- Risk: Windows support exists at endpoint construction level but should not be claimed as fully tested.
- Priority: Medium unless Windows becomes a supported target.

**Release archives are not inspected for plugin layout:**
- What's not tested: Tagged release contents for canonical plugin installation.
- Files: `.github/workflows/release.yml`, `esbuild.config.mjs`, `.github/workflows/build.yml`
- Risk: Plugin layout can pass build checks but remain absent from release artifacts.
- Priority: Medium for distribution phases.

## Already-Tested Invariants

- `src/lib/state.mjs` state writes are protected against concurrent writer loss, stale lock inode races, temp-file stragglers, stale job reaping, and corrupt JSON quarantine by `test/state.test.mjs`, `test/state-stale-lock-toctou.test.mjs`, and `test/state-tmp-sweep-on-rename-failure.test.mjs`.
- `src/adapters/codex/broker.mjs` stream ownership release ordering is covered for downstream disconnects, same-chunk responses, early sub-thread completion, root completion, and clear-all behavior by `test/broker-stream-release-ordering.test.mjs`.
- `src/lib/git.mjs` worktree safety is covered for safe task IDs, shell metacharacter handling, branch clobber refusal, dirty parent fallback refusal, dirty task worktree merge refusal, reviewed SHA drift, custom worktree roots, and fast-forward merge/prune by `test/git-worktree.test.mjs`.
- `src/adapters/codex/protocol.mjs` request cleanup and broker fallback behavior is covered by `test/app-server-client.test.mjs` and `test/app-server-abort.test.mjs`.
- Generated bundle drift and basic CLI envelope behavior for both skill and plugin script layouts are covered in `.github/workflows/build.yml`.
- Stop gate command surfaces, timeout margins, kill-switch diagnostics, and readiness/block behavior are covered in `test/plugin-surfaces.test.mjs`, except for the skipped legacy migration path.

---

*Concerns audit: 2026-04-30*
