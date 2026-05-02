# Phase 2: Adapter And Delegation Runtime - Context

**Gathered:** 2026-05-01
**Status:** Complete
**Source:** Autonomous brownfield context from source, tests, generated bundles, static gate results, and authenticated Codex smoke probes.

<domain>
## Phase Boundary

Phase 2 closes the adapter/delegation runtime gap created by the v2 backend abstraction:

- Runtime task dispatch goes through the selected backend adapter instead of bypassing it.
- Backend capability reporting is visible in setup/version output and unsupported backends fail through structured validation errors.
- Foreground and background Codex tasks produce standard envelopes, artifacts, persisted job state, event logs, and retrievable results.
- Resume, respond, steer, cancel, result, and event reads are routed through adapter lifecycle methods.
- Timeout and handoff behavior remains classified through the existing Codex runtime and error mapping path.

This phase does not broaden beyond the Codex backend. It also does not complete review/verdict/iterate orchestration, plugin/hook hardening, or release packaging; those remain in later phases.
</domain>

<decisions>
## Implementation Decisions

### D-01 Codex Adapter Is The Shipping Runtime Adapter
- `src/adapters/codex/index.mjs` now owns the lifecycle methods that the CLI needs for supported Codex operations.
- Capability flags advertise implemented optional lifecycle verbs only after handlers exist.
- Test-only runtime injection helpers keep adapter lifecycle tests deterministic without spawning a live app-server.

### D-02 CLI Dispatch Uses Adapter Resolution
- Task, send, steer, respond, cancel, result, and setup paths resolve the active backend through `resolveCommandAdapter` / `resolveAdapterForRuntime`.
- Foreground and background task execution pass a concrete adapter to `executeTaskRun`.
- Unknown or incapable backends use existing `BACKEND_INCAPABLE` validation envelopes.

### D-03 Preserve Codex-Specific Runtime Internals
- The adapter wraps existing `runAppServerTurn`, `withAppServer`, `interruptAppServerTurn`, pending-request files, job-control helpers, and session logs.
- This avoids duplicating the app-server protocol while giving the CLI one backend-aware boundary.
- Generated `skill/` and `plugin/` CLI bundles are rebuilt from source instead of hand-edited.

### D-04 Result And Event Normalization
- `adapter.getResult` normalizes persisted job state into the backend result contract.
- `adapter.streamEvents` reads session `.events` files and maps terminal/generic tags into normalized event objects.
- The existing CLI event/result envelopes remain authoritative for user-facing output.

### D-05 Live Smoke Scope
- Authenticated smoke covers setup, foreground task, resume/send, background task, wait, result, and filtered event reads.
- Respond and steer are covered deterministically at the adapter and CLI routing level; forcing a live `requestUserInput` or racing an active turn would make the phase validation nondeterministic.
</decisions>

<canonical_refs>
## Canonical References

Downstream agents MUST read these before planning or implementing related work.

### Runtime Adapter Truth
- `src/adapters/codex/index.mjs` - Codex backend lifecycle implementation.
- `src/adapters/index.mjs` - backend selection, capability gates, and precedence.
- `src/adapters/index.d.ts` - adapter contract shape.
- `src/adapters/codex/codex.mjs` - Codex app-server turn/review runtime that the adapter wraps.

### CLI Runtime Truth
- `src/codex-bridge.mjs` - command handlers for task, send, steer, respond, cancel, result, setup, version, background worker, and worktree isolation.
- `src/lib/job-control.mjs` - job status/result/event helpers.
- `src/lib/session-log.mjs` - `.events` and `.ndjson` terminal tag semantics.
- `src/lib/pending-requests.mjs` - request/response files for `requestUserInput`.

### Test Truth
- `test/codex-adapter-lifecycle.test.mjs` - adapter dispatch/resume/respond/steer/cancel/result/events tests.
- `test/bridge-static.test.mjs` - CLI static routing checks for adapter lifecycle usage.
- `test/adapter-selection.test.mjs` - backend precedence and CLI `--backend` resolution.
- `test/adapter-registry.test.mjs` - capability validation and optional method consistency.
- `test/baseline-contracts.test.mjs` - machine-readable setup/version envelope probes.
</canonical_refs>

<specifics>
## Specific Outcomes

- `setup --json` now includes `active_backend` and `adapter_capabilities`.
- `task --backend unknown --json ...` returns `BACKEND_INCAPABLE` instead of falling into Codex-specific execution.
- `task` and background `task-worker` share the same adapter dispatch path.
- `send` uses `adapter.resume`; `respond` uses `adapter.respond`; `steer` uses `adapter.steer`; `cancel` uses `adapter.cancel`; `result` asks the selected adapter for normalized result metadata.
- `worktree-auto` exposes the returned job id as the registry task id and keeps job state anchored to the launch workspace.
</specifics>

<deferred>
## Deferred Ideas

- Non-Codex backend implementations remain v2 future work after the Codex adapter contract is stable.
- Full review/verdict/iterate orchestration is Phase 3.
- Hook spoof-resistance and packaged plugin canonicality are Phase 4.
- Release packaging and full release smoke, including authenticated review smoke, are Phase 6.
</deferred>

---

*Phase: 02-adapter-and-delegation-runtime*
*Context gathered: 2026-05-01 via autonomous source exploration and live Codex smoke*
