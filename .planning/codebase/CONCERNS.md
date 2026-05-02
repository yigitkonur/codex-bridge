---
last_mapped_commit: 6b3a78a98eb5396798d0ed2ee3d8f7451f204652
---

# Codebase Concerns

**Analysis Date:** 2026-05-02

## Tech Debt

**Closed-loop iterate command is a staged envelope:**
- Issue: `iterate` validates task and verdict state, but returns `status: "not-yet-orchestrated"` instead of launching the next mutation/fix turn.
- Files: `src/codex-bridge.mjs`, `scripts/baseline-contracts.mjs`, `.planning/STATE.md`
- Impact: The package exposes a review-to-iterate loop surface, but callers must manually run the suggested task command to continue the loop. Automation built on `iterate --json` cannot depend on an actual mutation pass.
- Fix approach: Move the manual `next_action.argv` path into a real orchestration call, persist the child job/session metadata, and update `scripts/baseline-contracts.mjs` so the command has mutation coverage instead of a staged-only contract.

**Monolithic CLI dispatcher concentrates unrelated behavior:**
- Issue: `src/codex-bridge.mjs` contains command metadata, parsing, update checks, setup, task orchestration, review orchestration, session heartbeat handling, verdict handling, merge handling, stop-gate setup, and status rendering in one 5,000+ line module.
- Files: `src/codex-bridge.mjs`
- Impact: Small command changes have a wide review surface. Dead or disconnected pieces are easy to keep, including `readVerdictPayloadFromStdin`, the unused `renderBriefAsMarkdown` task path, and the advertised but unenforced `allow_questions` setting.
- Fix approach: Split command handlers into focused modules under `src/lib/` or `src/commands/`, keep shared runtime orchestration in a separate module, and add static checks for unused command options/imports/helpers.

**Structured task briefs are validated but not persisted:**
- Issue: `--brief` accepts and validates a structured JSON brief, but the task metadata writer only stores backend, capabilities, worktree, base, phase, and backend options. The rendered brief helper is imported but not used in the task execution path.
- Files: `src/codex-bridge.mjs`, `src/lib/brief.mjs`
- Impact: Acceptance criteria, constraints, and original structured intent are not available to later status, review, verdict, merge, or iterate steps. Recovery after interruption depends on the free-form prompt and session logs instead of a stable brief artifact.
- Fix approach: Persist `brief.json`, a rendered `brief.md`, and `brief_hash` in the task session directory before the Codex turn starts. Include those artifacts in status and review context.

**Dual generated distribution has a high drift burden:**
- Issue: Runtime source and static assets are emitted into both the legacy skill layout and packaged plugin layout. The generated surfaces include scripts, prompts, schemas, templates, config, and hook copies.
- Files: `esbuild.config.mjs`, `scripts/baseline-contracts.mjs`, `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs`, `plugin/hooks/`
- Impact: Runtime, hook, prompt, schema, config, command, or agent changes require a fresh build and generated diff. The CI drift checks reduce risk, but any local change that skips `npm run build` leaves installable artifacts inconsistent.
- Fix approach: Keep `esbuild.config.mjs` as the only generator source, keep generated directories read-only by convention, and treat `npm run build` plus `npm test` as mandatory for any source or plugin-surface change.

**Configuration failures can silently fall back to defaults:**
- Issue: Config file read/YAML parse errors return `{}` without surfacing a warning, and unknown sandbox policy values fall through to mode-derived defaults.
- Files: `src/lib/config.mjs`, `src/lib/runtime-options.mjs`
- Impact: A typo in `config.yaml` can silently change model, effort, sandbox, session directory, or review behavior. Operators may believe a safety or routing setting is active when the runtime uses defaults.
- Fix approach: Add config validation with warnings in `config`/`setup --json`, include the config source path in resolved runtime options, and emit a startup event when a config file cannot be read or contains unknown keys/values.

## Known Bugs

**Verdict `--payload-stdin` is documented but not wired:**
- Symptoms: The packaged reviewer agent and command documentation instruct `codex-bridge verdict <task_id> --payload-stdin --json`, but the verdict command parser does not define `payload-stdin` and the handler does not call the stdin payload reader.
- Files: `src/codex-bridge.mjs`, `plugin/agents/codex-bridge-reviewer.md`, `plugin/commands/verdict.md`
- Trigger: Run the reviewer-agent handoff command or invoke `verdict` with `--payload-stdin`.
- Workaround: Use `verdict <task_id> --set <approved|changes_requested|blocked> --summary ... --finding ... --json` manually, but that path still cannot attach a branch head SHA.

**Approved verdicts written by the CLI cannot satisfy merge SHA binding:**
- Symptoms: `merge` refuses approved verdicts that lack `branch_head_sha`, but `verdict --set` writes no branch head SHA and the stdin helper drops any branch head value.
- Files: `src/codex-bridge.mjs`, `src/lib/git.mjs`, `plugin/commands/merge.md`
- Trigger: Approve a task with the shipped `verdict` command, then run `merge <task_id>`.
- Workaround: Use lower-level state manipulation outside the public command surface, or update the verdict file manually with the reviewed branch head SHA before merge.

**Relative `session_dir` resolves against process cwd instead of command cwd:**
- Symptoms: A workspace `config.yaml` with `session_dir: "./sessions"` is loaded from `--cwd`, but `resolveSessionDir` returns the relative path unchanged. Later commands read or write sessions relative to the shell process cwd.
- Files: `src/lib/session-log.mjs`, `src/lib/config.mjs`, `src/codex-bridge.mjs`
- Trigger: Invoke `node src/codex-bridge.mjs respond --cwd <workspace> ...` or another session command from outside `<workspace>` while that workspace config uses a relative `session_dir`.
- Workaround: Use an absolute `session_dir` or invoke all session commands from the same directory that owns the config file.

**Malformed `respond --json-payload` reports as an internal error:**
- Symptoms: With an existing pending request, invalid JSON passed to `respond --json-payload` throws a raw `JSON.parse` exception and exits through the internal-error envelope instead of a usage/config error.
- Files: `src/codex-bridge.mjs`, `src/lib/pending-requests.mjs`
- Trigger: Run `respond <request_id> --json-payload '{' --json` for a real pending request.
- Workaround: Validate JSON before calling the command, or use plain text response flags where possible.

**`allow_questions` is advertised but not enforced:**
- Symptoms: The default config and generated config comments expose `allow_questions`, but task and send paths still attach the bridge server request handler.
- Files: `src/lib/runtime-options.mjs`, `skill/config.yaml`, `plugin/config.yaml`, `src/codex-bridge.mjs`
- Trigger: Set `allow_questions: false` and run a task/send flow that asks the bridge server for user input.
- Workaround: Avoid workflows that trigger bridge questions, or add command-specific handling before relying on the config key.

## Security Considerations

**Detached auto-update can execute `skills@latest` with inherited environment:**
- Risk: Normal hot-path invocations can spawn a detached `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y` process after a release check. The child inherits `process.env` and uses the latest installer package.
- Files: `src/codex-bridge.mjs`, `package.json`
- Current mitigation: Auto-update is skipped for JSON output, `update`, `version`, and `--help` flows; `CODEX_BRIDGE_NO_UPDATE_CHECK=1` disables the check; release lookup uses the public GitHub releases API.
- Recommendations: Make auto-apply opt-in or notify-only by default, pin the installer package/version, verify release integrity, and pass a minimal environment to the detached process.

**Default sandbox policy grants full filesystem access:**
- Risk: The shipped default config sets `sandbox_policy: "danger-full-access"`, and runtime option resolution maps that value to unrestricted tool access for regular task/send flows.
- Files: `src/lib/runtime-options.mjs`, `skill/config.yaml`, `plugin/config.yaml`
- Current mitigation: Some internal review/stop-gate paths pass explicit read-only sandbox overrides, and users can override sandbox policy in config.
- Recommendations: Prefer `workspace-write` as the shipped default, require an explicit per-command or config opt-in for full access, and show the resolved sandbox in every task/review startup event.

**Unauthenticated local broker socket must stay strictly local:**
- Risk: The app-server broker communicates through local Unix sockets or Windows named pipes without an application-level authentication token. Filesystem permissions and endpoint path isolation are the main boundary.
- Files: `src/adapters/codex/broker.mjs`, `src/lib/broker-endpoint.mjs`, `src/lib/broker-lifecycle.mjs`
- Current mitigation: Broker endpoints are created under user-specific temp/plugin data locations, stale endpoints are cleaned, and request handling is local IPC rather than a network listener.
- Recommendations: Keep endpoint paths under private user-controlled directories, set restrictive socket file permissions where supported, and add tests around endpoint ownership/cleanup behavior.

**Git diff capture can include sensitive untracked file contents:**
- Risk: Session logging captures tracked diffs and limited untracked file content for text-like files. If a secret file is untracked and not excluded, it can be copied into session artifacts.
- Files: `src/lib/session-log.mjs`, `src/lib/git.mjs`
- Current mitigation: Untracked capture is size-limited and the repository instructions forbid reading/quoting secret files.
- Recommendations: Exclude common secret patterns from untracked capture, respect `.gitignore` for all untracked content capture, and add a redaction layer before writing session artifacts.

## Performance Bottlenecks

**Synchronous full diff capture runs on session paths:**
- Problem: Session artifact creation invokes Git synchronously and captures `git diff HEAD` plus selected untracked content.
- Files: `src/lib/session-log.mjs`, `src/lib/git.mjs`
- Cause: The capture path favors complete local evidence, but it runs in-process and can traverse large diffs or many untracked files.
- Improvement path: Add explicit byte/time limits for tracked diffs, include truncation metadata, and move large diff capture to an optional artifact path.

**Shared app-server broker serializes active streaming work:**
- Problem: The broker tracks a single active streaming socket/request path and rejects or defers overlapping work when it is busy.
- Files: `src/adapters/codex/broker.mjs`, `src/lib/broker-lifecycle.mjs`
- Cause: One shared Codex app-server connection/broker lifecycle is simpler to supervise, but parallel task/review workloads contend for the same IPC stream.
- Improvement path: Add per-workspace or per-job broker allocation, or add an explicit queue with status visibility and cancellation semantics.

**Large status/watch output can repeatedly scan session state:**
- Problem: Status and watch flows read state, tasks, pending requests, event logs, and process metadata on an interval.
- Files: `src/codex-bridge.mjs`, `src/lib/state.mjs`, `src/lib/pending-requests.mjs`
- Cause: The watch implementation favors fresh filesystem state over an indexed process model.
- Improvement path: Cache stable job metadata, index session directories by task id, and bound event-tail reads for long-running sessions.

## Fragile Areas

**Verdict, review, and merge state contract spans several unrelated files:**
- Files: `src/codex-bridge.mjs`, `src/lib/git.mjs`, `plugin/agents/codex-bridge-reviewer.md`, `plugin/commands/verdict.md`, `plugin/commands/merge.md`
- Why fragile: Review output, verdict persistence, branch head binding, and merge eligibility are enforced in different places. The command documentation, agent instruction, and handler options are already inconsistent around `--payload-stdin` and branch head SHA.
- Safe modification: Change verdict schema, command options, agent instructions, and merge validation together. Add an integration test that approves a task through the public CLI and verifies merge reaches the expected pre-merge checks.
- Test coverage: Unit tests cover pieces of git/merge behavior, but the shipped reviewer-agent verdict handoff is not covered end to end.

**Native review parsing depends on text formatting heuristics:**
- Files: `src/adapters/codex/pipeline.mjs`, `src/prompts/adversarial-review.md`, `src/schemas/review-output.schema.json`
- Why fragile: Auto-review verdict extraction parses native review text with regular expressions and bullet-line conventions. A format change can downgrade structured findings to unstructured attention text.
- Safe modification: Prefer schema-backed adversarial review output for automation, keep native parsing as a display fallback, and add fixtures for the exact review text formats accepted by the parser.
- Test coverage: Pipeline tests cover selected behaviors, but there is no authoritative upstream native-review format contract in CI.

**Stop review gate depends on lock, official plugin detection, and workspace state:**
- Files: `hooks/stop-review-gate-hook.mjs`, `hooks/stop-gate.mjs`, `src/codex-bridge.mjs`, `src/lib/state.mjs`
- Why fragile: The hook blocks only when a project lock exists, the official OpenAI Codex plugin is absent, and workspace state indicates a relevant pending review condition.
- Safe modification: Treat setup JSON, hook behavior, and state transitions as one contract. Keep hook tests focused on lock presence, official plugin suppression, and project-root resolution.
- Test coverage: Hook and setup behavior have static tests, but live Claude Code hook invocation is not exercised in CI.

**Config precedence lacks source-aware normalization:**
- Files: `src/lib/config.mjs`, `src/lib/session-log.mjs`, `src/codex-bridge.mjs`
- Why fragile: Config values merge from install root, workspace root, and cwd, but path-like values are not normalized relative to the file that supplied them.
- Safe modification: Return `{ config, sources }` from config loading, normalize path fields after merge, and preserve display of both original and resolved paths.
- Test coverage: Config loading tests cover merge behavior, but relative path behavior across process cwd and command cwd needs direct coverage.

**Generated plugin surfaces depend on authored root hooks and packaged command files:**
- Files: `hooks/`, `plugin/hooks/`, `plugin/commands/`, `plugin/agents/`, `esbuild.config.mjs`
- Why fragile: `plugin/commands/` and `plugin/agents/` are the packaged surfaces in this checkout, while hooks are authored at root and copied to `plugin/hooks/`. If root `commands/` or `agents/` are restored, the edit source changes.
- Safe modification: Check `esbuild.config.mjs` before editing plugin surfaces. Edit root hook sources under `hooks/`, then run `npm run build` and include generated hook diffs.
- Test coverage: Plugin surface tests validate presence and selected content, but they do not prove every command example invokes an implemented option.

## Scaling Limits

**Workspace state is filesystem-backed without a concurrency lock layer:**
- Current capacity: Local single-user workflows with append-only session logs and state files.
- Limit: Multiple concurrent bridge commands in the same workspace can race on task metadata, verdict files, pending request files, or broker lifecycle artifacts.
- Files: `src/lib/state.mjs`, `src/lib/session-log.mjs`, `src/lib/pending-requests.mjs`, `src/lib/broker-lifecycle.mjs`
- Scaling path: Add file locks or atomic compare-and-swap writes around mutable task/verdict/pending-request records, and report lock contention in JSON responses.

**Broker lifecycle is optimized for one local Codex app-server lane:**
- Current capacity: One shared local broker connection per configured endpoint namespace.
- Limit: Parallel branch review or task farms can bottleneck on a single broker and active stream.
- Files: `src/adapters/codex/broker.mjs`, `src/lib/broker-endpoint.mjs`, `src/lib/broker-lifecycle.mjs`
- Scaling path: Add per-job broker namespaces, expose broker queue depth in `status --json`, and allow explicit broker pool sizing.

**Session artifacts can grow without retention controls:**
- Current capacity: Local append-only `.events` and `.ndjson` files plus task metadata under the resolved session directory.
- Limit: Long-running or high-volume workspaces can accumulate large session directories and slow status/watch operations.
- Files: `src/lib/session-log.mjs`, `src/lib/state.mjs`, `src/codex-bridge.mjs`
- Scaling path: Add `sessions prune`, retention config, event compaction, and bounded default event tails.

## Dependencies at Risk

**Codex app-server protocol is an external moving contract:**
- Risk: The package depends on method names, notification shapes, streaming behavior, and Codex CLI/app-server availability that are not validated by live CI.
- Impact: Changes in Codex app-server behavior can break task, review, send, steer, respond, cancel, or broker behavior while static tests continue to pass.
- Files: `src/adapters/codex/protocol.mjs`, `src/adapters/codex/codex.mjs`, `scripts/baseline-contracts.mjs`, `.github/workflows/build.yml`
- Migration plan: Add a gated live smoke job for authenticated Codex installs, version-detect app-server capabilities, and fail closed when required methods are unavailable.

**Auto-update relies on network, GitHub releases, npx, and `skills@latest`:**
- Risk: Update discovery and application depend on GitHub release availability and the latest published `skills` installer behavior.
- Impact: Network failures, rate limits, registry changes, or installer regressions can create noisy background failures or unexpected global install changes.
- Files: `src/codex-bridge.mjs`, `package.json`
- Migration plan: Make the hot-path check read-only, expose `update --apply` as the explicit mutation path, and pin installer semantics.

**Package has a narrow dev dependency set but a broad runtime toolchain:**
- Risk: `package.json` declares only `esbuild` and `js-yaml` as dev dependencies, while real runtime flows require Node 22+, Git, Codex CLI, Codex app-server support, and local IPC support.
- Impact: `npm test` can pass in environments where real bridge commands cannot run.
- Files: `package.json`, `src/codex-bridge.mjs`, `src/lib/process.mjs`, `.github/workflows/build.yml`
- Migration plan: Keep `setup --json` as the runtime readiness contract, add explicit CI smoke tests where tools are available, and document unsupported runtime combinations in generated config/help.

## Missing Critical Features

**End-to-end review verdict to merge flow is incomplete through public commands:**
- Problem: The public reviewer instruction path uses unsupported `--payload-stdin`, verdict persistence lacks branch head SHA, and merge requires branch head SHA.
- Blocks: Safe automated merge after review approval through the packaged plugin surface.
- Files: `src/codex-bridge.mjs`, `src/lib/git.mjs`, `plugin/agents/codex-bridge-reviewer.md`, `plugin/commands/verdict.md`, `plugin/commands/merge.md`

**Merge path has no real test execution gate:**
- Problem: `performTrustBudgetedMerge` accepts `runTests`, but the implementation records test state instead of running a configured command. The command surface includes `--no-tests`, but the positive path does not execute tests.
- Blocks: Trust-budgeted merge cannot prove the approved branch passes project checks before integration.
- Files: `src/lib/git.mjs`, `src/codex-bridge.mjs`, `plugin/commands/merge.md`

**Task/request question policy lacks enforcement:**
- Problem: `allow_questions` exists in default config and generated config files, but request handler attachment does not consult it.
- Blocks: Non-interactive workflows cannot reliably disable bridge questions through config.
- Files: `src/lib/runtime-options.mjs`, `skill/config.yaml`, `plugin/config.yaml`, `src/codex-bridge.mjs`

**Closed-loop mutation from review findings is not implemented:**
- Problem: Baseline contracts classify `iterate` as staged orchestration only, and the active planning state points at the review verdict and iterate-loop phase.
- Blocks: Fully automated review/fix/review loops from the bridge CLI/plugin surface.
- Files: `src/codex-bridge.mjs`, `scripts/baseline-contracts.mjs`, `.planning/STATE.md`

## Test Coverage Gaps

**Live Codex app-server round trips:**
- What's not tested: Authenticated `task`, `task-worker`, `review`, `adversarial-review`, `send`, `steer`, `respond`, `cancel`, and broker lifecycle behavior against a real Codex app-server.
- Files: `scripts/baseline-contracts.mjs`, `.github/workflows/build.yml`, `src/adapters/codex/`
- Risk: Protocol or CLI integration drift can ship with static tests passing.
- Priority: High

**Reviewer-agent verdict command contract:**
- What's not tested: The packaged reviewer instruction `verdict <task_id> --payload-stdin --json`, branch head SHA persistence, and merge eligibility from a public verdict write.
- Files: `plugin/agents/codex-bridge-reviewer.md`, `plugin/commands/verdict.md`, `src/codex-bridge.mjs`, `src/lib/git.mjs`
- Risk: The documented plugin review approval path cannot drive merge.
- Priority: High

**Relative config path behavior:**
- What's not tested: Relative `session_dir` under install-root, workspace-root, and cwd config files when the shell process cwd differs from command `--cwd`.
- Files: `src/lib/config.mjs`, `src/lib/session-log.mjs`, `src/codex-bridge.mjs`
- Risk: Session events, pending requests, and status lookups use different directories across commands.
- Priority: High

**Config validation and unknown setting warnings:**
- What's not tested: Malformed YAML, unknown config keys, invalid sandbox policy values, and user-visible diagnostics.
- Files: `src/lib/config.mjs`, `src/lib/runtime-options.mjs`, `skill/config.yaml`, `plugin/config.yaml`
- Risk: Safety and routing settings silently fail open or fall back.
- Priority: Medium

**Large diff/session artifact handling:**
- What's not tested: Behavior when tracked diffs exceed synchronous capture limits, untracked files are large, or session event files are very large.
- Files: `src/lib/session-log.mjs`, `src/lib/git.mjs`, `src/codex-bridge.mjs`
- Risk: Status/review context can truncate, slow down, or include unintended content.
- Priority: Medium

**Auto-update safety and opt-out behavior:**
- What's not tested: Detached update process spawning, inherited environment shape, opt-out coverage, release-cache behavior, and failure reporting.
- Files: `src/codex-bridge.mjs`
- Risk: Hot-path commands can trigger unexpected background mutation attempts.
- Priority: Medium

---

*Concerns audit: 2026-05-02*
