# Domain Pitfalls

**Domain:** codex-bridge brownfield GSD initialization
**Researched:** 2026-04-30
**Overall confidence:** HIGH for code-backed pitfalls; MEDIUM for phase ordering implications because future roadmap scope is not yet fixed.

This research uses current source, tests, workflow YAML, and build configuration as evidence. Repository Markdown was not used as evidence.

## Critical Pitfalls

### Pitfall 1: Breaking the Codex app-server wire contract
**Affected phase area:** Codex protocol adapter, shared broker, app-server integration.
**File-path evidence:** `src/adapters/codex/protocol.mjs:161-207`, `src/adapters/codex/protocol.mjs:252-304`, `src/adapters/codex/broker.mjs:218-223`, `src/adapters/codex/broker.mjs:370-400`.
**What goes wrong:** The client and broker exchange newline-delimited JSON objects shaped as `{ id, method, params }`. Adding JSON-RPC fields, renaming methods, or treating server requests as normal responses can break every turn, review, and interrupt flow.
**Warning signs:** New aliases for method names, custom envelope fields, tests that stub only success responses, or app-server notifications being ignored as "unknown" noise.
**Prevention:** Keep protocol method names centralized in the adapter contract, preserve the current request/response/notification classifier, and test server-initiated requests separately from client-initiated requests.
**Detection:** `node --test test/app-server-client.test.mjs test/app-server-abort.test.mjs test/broker-stream-release-ordering.test.mjs`.

### Pitfall 2: Deadlocking the broker by mishandling stream ownership
**Affected phase area:** Broker lifecycle, turn streaming, interrupts, subagent delegation.
**File-path evidence:** `src/adapters/codex/broker.mjs:51-212`, `src/adapters/codex/broker.mjs:474-505`, `src/adapters/codex/broker.mjs:545-552`, `src/adapters/codex/broker.mjs:575-595`.
**What goes wrong:** The broker allows one active stream and special-cases `turn/interrupt`. If ownership is cleared too early, a second stream can corrupt routing. If it is not cleared after failure, later work gets false busy errors.
**Warning signs:** Flaky `BROKER_BUSY` responses, interrupts that do nothing, sessions that finish but leave later commands blocked, or broker logs showing a request id with no matching cleanup.
**Prevention:** Treat stream ownership as a state machine: acquire before forwarding, release only after the app-server completion path, and keep interrupt routing narrow.
**Detection:** `node --test test/broker-stream-release-ordering.test.mjs test/broker-shared.test.mjs test/app-server-abort.test.mjs`.

### Pitfall 3: Losing runtime compatibility when the broker moves between source, skill, and plugin layouts
**Affected phase area:** Packaging, install layout migration, broker startup.
**File-path evidence:** `src/lib/broker-lifecycle.mjs:149-228`, `src/adapters/codex/protocol.mjs:530-579`, `esbuild.config.mjs:21-34`, `esbuild.config.mjs:77-125`.
**What goes wrong:** Source execution, legacy skill installs, and plugin installs resolve different broker script paths. A change that works in `src/` can fail after packaging if bundled broker paths are stale or readiness output changes.
**Warning signs:** `BROKER_START_FAILED`, saved broker endpoints falling back to direct mode, plugin commands invoking missing scripts, or packaged artifacts passing local source tests only.
**Prevention:** Update source and generated layouts together through the build, keep readiness output stable, and verify both legacy skill and plugin script locations after broker edits.
**Detection:** `npm run build && node --test test/broker-lifecycle.test.mjs test/plugin-surfaces.test.mjs`.

### Pitfall 4: Letting generated skill/plugin artifacts drift from source
**Affected phase area:** Build pipeline, plugin surfaces, release packaging.
**File-path evidence:** `esbuild.config.mjs:36-75`, `esbuild.config.mjs:77-125`, `.github/workflows/build.yml:39-89`, `test/plugin-surfaces.test.mjs:253-327`, `test/plugin-surfaces.test.mjs:386-413`.
**What goes wrong:** Runtime source, commands, agents, hooks, prompts, schemas, templates, and config are copied into two installable layouts. Manual edits to generated outputs or missed build steps can ship different behavior than source tests exercised.
**Warning signs:** Source diffs without corresponding `skill/` or `plugin/` diffs, plugin hook scripts pointing at legacy skill paths, CI drift checks failing after `npm run build`, or command metadata mismatching plugin manifests.
**Prevention:** Treat `esbuild.config.mjs` as the packaging source of truth, edit authored inputs only, run the build after source or plugin-surface changes, and include generated diffs in phase work.
**Detection:** `npm run build && git diff --exit-code -- skill plugin && node --test test/plugin-surfaces.test.mjs`.

### Pitfall 5: Accidentally changing config precedence or plan-mode safety defaults
**Affected phase area:** CLI config, workspace scoping, runtime options.
**File-path evidence:** `src/lib/config.mjs:41-80`, `src/lib/runtime-options.mjs:1-30`, `src/lib/runtime-options.mjs:101-148`, `src/codex-bridge.mjs:1170-1220`, `src/codex-bridge.mjs:2435-2589`.
**What goes wrong:** The package merges defaults, install-root config, workspace config, and cwd config. Plan mode also forces high reasoning effort. A seemingly local config change can alter sandbox policy, model choice, review behavior, or execution effort across unrelated workspaces.
**Warning signs:** `config show --json` lists unexpected sources, plan tasks use execute-mode effort, read-only runs obtain write permissions, or workspace config stops overriding install defaults.
**Prevention:** Add new config keys in defaults, merge/render code, shipped config, and tests together. Verify the source list and effective values from the CLI before relying on behavior.
**Detection:** `node src/codex-bridge.mjs config show --json` and `node --test test/adapter-routing.test.mjs test/args.test.mjs`.

### Pitfall 6: Corrupting background job or session state by mixing workspace root and process cwd
**Affected phase area:** Background jobs, state persistence, worktree execution, resume/status commands.
**File-path evidence:** `src/lib/state.mjs:41-55`, `src/lib/state.mjs:79-129`, `src/lib/state.mjs:247-299`, `src/codex-bridge.mjs:2213-2318`, `src/codex-bridge.mjs:3809-3869`.
**What goes wrong:** State is keyed by canonical workspace root while commands can execute in a requested cwd or isolated worktree. Writing state under the process cwd or spawning before job records exist can orphan running jobs and make status/resume lie.
**Warning signs:** `status` cannot find an active task, `.worker.err` exists without a job record, stale locks persist after crashes, or worktree tasks report against the wrong root.
**Prevention:** Keep stateCwd and execution cwd distinct, create queued job records before spawning detached workers, preserve atomic state writes, and keep stale-lock cleanup guarded by inode checks.
**Detection:** `node --test test/state.test.mjs test/state-stale-lock-toctou.test.mjs test/state-tmp-sweep-on-rename-failure.test.mjs test/job-control.test.mjs`.

### Pitfall 7: Making session logs non-terminal or non-append-only
**Affected phase area:** Session observability, monitor/status UI, auto-pipeline completion.
**File-path evidence:** `src/lib/session-log.mjs:14-53`, `src/lib/session-log.mjs:707-722`, `src/codex-bridge.mjs:2765-2817`, `src/codex-bridge.mjs:2888-2919`, `src/codex-bridge.mjs:3505-3566`.
**What goes wrong:** Session `.events` and `.ndjson` files are append-only observability contracts. Missing terminal tags, duplicate terminal events, async competing writers, or removed heartbeat/backstop events make monitors hang or report incomplete work incorrectly.
**Warning signs:** Monitor output never exits, completed jobs remain "running", event files have reordered terminal records, or failures produce no final `UnhandledExit`/pipeline terminal event.
**Prevention:** Keep synchronous append-only writes, preserve the terminal tag set, and update event rendering/tests whenever adding or renaming events.
**Detection:** `node --test test/events-json.test.mjs test/session-log.test.mjs test/auto-pipeline-turn-watchdog.test.mjs test/cli-status-spawn-memoization.test.mjs`.

### Pitfall 8: Misdetecting turn completion during app-server conversations
**Affected phase area:** Codex adapter turn capture, review capture, server-request handling.
**File-path evidence:** `src/adapters/codex/codex.mjs:377-403`, `src/adapters/codex/codex.mjs:641-755`, `src/adapters/codex/codex.mjs:755-857`, `src/adapters/codex/codex.mjs:1247-1260`.
**What goes wrong:** Completion can be explicit, inferred from final-answer notifications, or delayed by pending server requests. Incorrect idle timers or turn-id buffering can abort valid work, drop final output, or attribute a response to the wrong session.
**Warning signs:** Final answers missing from captured turns, idle timeouts while the user-question path is active, mismatched turn ids, or process exits treated as success without final content.
**Prevention:** Preserve buffered-notification handling until turn ids are known, mark server-request activity for idle logic, and keep timeout behavior covered by app-server tests.
**Detection:** `node --test test/codex-capture*.test.mjs test/auto-pipeline-turn-watchdog.test.mjs test/app-server-abort.test.mjs`.

### Pitfall 9: Treating auto-review or auto-fix pipeline text as a reliable machine contract
**Affected phase area:** Review pipeline, fixing loop, completion audit.
**File-path evidence:** `src/adapters/codex/pipeline.mjs:111-177`, `src/adapters/codex/pipeline.mjs:184-274`, `src/adapters/codex/pipeline.mjs:293-459`, `src/adapters/codex/pipeline.mjs:471-547`, `src/adapters/codex/pipeline.mjs:657-738`.
**What goes wrong:** The pipeline parses review text, tracks touched files, performs a completion check, and emits final status. If new prompts or renderers change expected language without parser/test updates, valid findings can be dropped or incomplete fixes can be marked done.
**Warning signs:** Review says findings exist but fix stage is skipped, completion checks return no final message, pipeline emits DONE after an error, or finding validity rendering diverges from schema expectations.
**Prevention:** Keep review-output schema, adversarial prompt, parser, renderer, and tests changed together. Prefer structured fields where possible and treat failed/no-message completion checks as incomplete.
**Detection:** `node --test test/auto-pipeline-turn-watchdog.test.mjs test/render-finding-validity.test.mjs`.

### Pitfall 10: Taking ownership of the Stop review gate incorrectly
**Affected phase area:** Claude Code plugin hooks, setup command, review-gate lifecycle.
**File-path evidence:** `src/codex-bridge.mjs:859-953`, `src/codex-bridge.mjs:1002-1099`, `hooks/hooks.json:26-33`, `hooks/stop-gate.mjs:49-64`, `hooks/stop-gate.mjs:136-153`, `hooks/stop-gate.mjs:333-369`, `hooks/stop-gate.mjs:451-520`, `hooks/stop-gate.mjs:533-553`, `test/plugin-surfaces.test.mjs:577-804`.
**What goes wrong:** The Stop hook is project-scoped and must not block when the official plugin owns review gating or when setup has not established the lock. A hook change can either fail open silently or block every Stop event for the wrong project.
**Warning signs:** Hook blocks without a workspace lock, setup reports suppression but the hook still runs a pipeline, Stop events time out near Claude's hook limit, or legacy hook config gets rewritten without setup-owned state.
**Prevention:** Keep setup as the lock owner, preserve official-plugin suppression checks, maintain the hook timeout margin, and log hook errors without leaking them into normal output.
**Detection:** `node --test test/plugin-surfaces.test.mjs` and manual `node src/codex-bridge.mjs setup --json` in a disposable workspace.

## Moderate Pitfalls

### Pitfall 11: Introducing network/update side effects into hot paths
**Affected phase area:** Version checks, auto-apply updates, command startup behavior.
**File-path evidence:** `src/codex-bridge.mjs:150-241`, `src/codex-bridge.mjs:1246-1363`, `src/lib/update-check.mjs:25-35`, `src/lib/update-check.mjs:95-198`, `src/lib/update-check.mjs:228-315`.
**What goes wrong:** Normal invocations can start detached update checks and installer application unless disabled. Poor gating can make startup slow, noisy, or dependent on network availability.
**Warning signs:** JSON commands emit update chatter, hot-path commands wait on GitHub, repeated installer runs ignore cache locks, or network failures mask the original command result.
**Prevention:** Keep update checks detached and rate-limited, honor opt-out environment flags, keep JSON output clean, and make synchronous apply explicit.
**Detection:** `CODEX_BRIDGE_NO_UPDATE_CHECK=1 node src/codex-bridge.mjs version --json` and `node --test test/update-check.test.mjs test/update-command.test.mjs test/auto-apply.test.mjs`.

### Pitfall 12: Overclaiming adapter capabilities before runtime support exists
**Affected phase area:** Adapter registry, non-Codex runtime expansion, command routing.
**File-path evidence:** `src/adapters/codex/index.mjs:22-52`, `src/adapters/index.mjs:44-90`, `src/adapters/index.mjs:110-155`, `src/adapters/index.mjs:201-217`, `src/codex-bridge.mjs:329-335`.
**What goes wrong:** The adapter metadata advertises capabilities that route command behavior. Marking an optional feature as supported before its method exists can route users into unimplemented code paths; rejecting non-Codex paths too broadly can block future adapters.
**Warning signs:** Capability flags change without implementation methods, runtime selection accepts a new adapter but command dispatch still calls Codex-specific helpers, or registry validation starts throwing at startup.
**Prevention:** Change capabilities, method implementations, registry validation, and command routing in one phase. Add adapter-specific tests before exposing new runtime choices.
**Detection:** `node --test test/adapter-registry.test.mjs test/adapter-routing.test.mjs test/adapter-selection.test.mjs`.

### Pitfall 13: Capturing the wrong review context from Git state
**Affected phase area:** Review prompts, diff collection, untracked file handling.
**File-path evidence:** `src/lib/git.mjs:150-160`, `src/lib/git.mjs:253-319`, `src/lib/git.mjs:397-443`, `test/bridge-static.test.mjs:174-185`.
**What goes wrong:** Review context includes staged, unstaged, and safe untracked files, then switches between inline diff and self-collect mode based on size. Ignoring untracked files or size thresholds can make review prompts incomplete or too large.
**Warning signs:** Review says clean while untracked source files exist, symlinked untracked files are read outside the repo, binary/large files enter prompts, or self-collect mode omits the target branch.
**Prevention:** Preserve safe untracked-file filtering, keep byte/file-count thresholds explicit, and make target/base selection visible in review status.
**Detection:** `node --test test/git.test.mjs test/bridge-static.test.mjs`.

### Pitfall 14: Breaking isolated worktree review or merge safety
**Affected phase area:** Subagent worktrees, reviewed-SHA enforcement, merge-back automation.
**File-path evidence:** `src/lib/git.mjs:523-622`, `src/lib/git.mjs:711-831`, `src/codex-bridge.mjs:3702-3739`, `test/git-worktree.test.mjs:120-145`, `test/git-worktree.test.mjs:260-318`.
**What goes wrong:** Worktree tasks must not fall back to mutating the parent branch, and merge-back must verify the branch SHA that was actually reviewed. Relaxing these checks can merge unreviewed changes or dirty unrelated work.
**Warning signs:** Worktree creation falls back to branch switching, merge succeeds after the task branch moved, parent worktree is dirty during merge, or failed cleanup leaves duplicate task branches.
**Prevention:** Keep `allowBranchFallback` disabled for automatic worktrees, persist reviewed branch metadata, require clean repos before merge, and use fast-forward merge validation.
**Detection:** `node --test test/git-worktree.test.mjs`.

## Minor Pitfalls

### Pitfall 15: Treating Windows pipe constants as validated cross-platform support
**Affected phase area:** Broker endpoint portability, install support claims.
**File-path evidence:** `src/lib/broker-endpoint.mjs:1-77`, `src/lib/broker-lifecycle.mjs:190-228`, `src/adapters/codex/protocol.mjs:561-579`.
**What goes wrong:** Endpoint helpers define platform-specific socket or pipe paths, but most lifecycle tests and operational assumptions center on local Unix-style process behavior. Claiming unsupported Windows readiness can create untested release promises.
**Warning signs:** Documentation or command output expands support claims without Windows broker tests, endpoint paths are changed without lifecycle coverage, or pipe cleanup behavior is assumed from Unix sockets.
**Prevention:** Keep support claims conservative until broker lifecycle, cleanup, and app-server round trips are tested on the target platform.
**Detection:** Add platform-specific broker lifecycle tests before advertising expanded support.

### Pitfall 16: Making process spawning less deterministic
**Affected phase area:** Detached workers, Codex CLI invocation, child process cleanup.
**File-path evidence:** `src/lib/process.mjs:9-57`, `src/lib/process.mjs:59-110`, `src/codex-bridge.mjs:2213-2251`.
**What goes wrong:** Runtime commands rely on bounded process execution, captured output, and detached worker cleanup. Changing spawn defaults can leak workers, lose stderr diagnostics, or hang setup/status commands.
**Warning signs:** Commands never return on missing binaries, child processes remain after timeout, worker stderr is not captured, or detached jobs inherit interactive stdio.
**Prevention:** Keep explicit timeout handling, controlled stdio, and diagnostic file capture for detached workers.
**Detection:** `node --test test/setup-command.test.mjs test/job-control.test.mjs`.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation | Detection |
|-------------|----------------|------------|-----------|
| Protocol or app-server adapter work | Wire contract drift or completion misclassification | Change protocol classifier, request routing, and capture tests together | `node --test test/app-server-client.test.mjs test/codex-capture*.test.mjs` |
| Broker relocation or packaging | Source works but packaged plugin cannot start broker | Run build and plugin-surface tests before handoff | `npm run build && node --test test/broker-lifecycle.test.mjs test/plugin-surfaces.test.mjs` |
| Config or defaults | Workspace/cwd precedence changes behavior globally | Inspect `config show --json` and add precedence tests | `node src/codex-bridge.mjs config show --json` |
| Background jobs or worktrees | State roots and execution cwd diverge | Preserve canonical workspace state and reviewed-SHA checks | `node --test test/state.test.mjs test/git-worktree.test.mjs` |
| Stop review gate | Hook blocks the wrong project or fails open silently | Keep setup-owned lock, suppression, and timeout-margin tests | `node --test test/plugin-surfaces.test.mjs` |
| Release/update work | Hot-path network side effects or stale bundles | Disable update checks during deterministic tests and verify drift checks | `CODEX_BRIDGE_NO_UPDATE_CHECK=1 npm test` |

## Research Gaps

- App-server round-trip behavior still depends on an authenticated Codex install; static tests do not prove live protocol compatibility.
- Windows named-pipe behavior is visible in endpoint code but not sufficiently proven by the reviewed local tests.
- Future non-Codex adapters need phase-specific research before advertised capability flags are expanded.

## Source Files Reviewed

- `src/codex-bridge.mjs`
- `src/adapters/codex/*.mjs`
- `src/adapters/index.mjs`
- `src/lib/*.mjs`
- `hooks/*.mjs`
- `hooks/hooks.json`
- `esbuild.config.mjs`
- `.github/workflows/build.yml`
- `.github/workflows/release.yml`
- `test/plugin-surfaces.test.mjs`
- `test/bridge-static.test.mjs`
- `test/git-worktree.test.mjs`
