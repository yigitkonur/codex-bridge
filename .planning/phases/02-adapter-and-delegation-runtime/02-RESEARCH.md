# Phase 2: Adapter And Delegation Runtime - Research

## Summary

Phase 2 needed to turn the existing backend abstraction from advertised scaffolding into the actual runtime path for Codex delegation. The safest route was to keep Codex app-server protocol code where it already worked, wrap it in the `codex` adapter, and migrate CLI command handlers to invoke adapter lifecycle methods through the established backend-resolution and capability-gate helpers.

## Source Evidence

- `src/adapters/index.mjs` already implemented backend selection, routing precedence, adapter loading, and `guardCapability`.
- `src/adapters/codex/index.mjs` previously declared capability flags while lifecycle methods were scaffolded or not wired through the CLI.
- `src/codex-bridge.mjs` directly called Codex runtime helpers for task dispatch, send/resume, steer, respond, cancel, and result paths.
- `src/adapters/codex/codex.mjs` already implemented the app-server turn, review, timeout, interrupt, pending-request, and event-capture behavior that must not be duplicated.
- Phase 1 static gate already enforced generated bundle drift, JSON envelopes, and mutating-command coverage metadata.

## Adapter Migration Strategy

| Runtime area | Existing source of truth | Phase 2 action |
|--------------|--------------------------|----------------|
| Capability flags | `adapter.capabilities()` | Mark questions/resume/steering true only after handlers exist |
| Task dispatch | `runAppServerTurn` | Wrap as `adapter.dispatch` |
| Send/resume | `runAppServerTurn` with `resumeThreadId` | Wrap as `adapter.resume` |
| Respond | pending-request response files | Wrap as `adapter.respond` |
| Steer | `turn/steer` app-server request | Wrap as `adapter.steer` |
| Cancel | `interruptAppServerTurn` | Wrap as `adapter.cancel` |
| Result | `resolveResultJob`, stored job state | Wrap as `adapter.getResult` |
| Events | session `.events` file | Wrap as `adapter.streamEvents` |

## Backend Precedence Proof

The existing adapter tests already exercised explicit flag, environment, task metadata, adapter routing, cwd config, workspace config, user/skill config, and default backend precedence. Phase 2 extended production CLI coverage so `task --backend ...` and setup/version reporting use those same paths.

## Risks And Mitigations

- Risk: Capability flags drift from implemented lifecycle methods.
  Mitigation: `test/adapter-registry.test.mjs` validates optional lifecycle methods against advertised support flags.
- Risk: CLI handlers keep bypassing the adapter.
  Mitigation: `test/bridge-static.test.mjs` asserts handler bodies call adapter lifecycle methods and no longer call direct Codex helpers in those paths.
- Risk: Generated install layouts drift after CLI source changes.
  Mitigation: `npm run verify:static` rebuilds and compares bundle outputs.
- Risk: Static tests falsely imply live Codex compatibility.
  Mitigation: Authenticated smoke probes covered setup, foreground task, send/resume, background task, wait, result, and filtered events.

## Verification Model

Use three layers:

1. Unit-level adapter lifecycle tests for deterministic dispatch/resume/respond/steer/cancel/result/event behavior.
2. Static CLI routing tests to prove user commands invoke adapter methods and capability gates.
3. Authenticated smoke probes for real setup, foreground, resume, background, wait, result, and event flows.

## RESEARCH COMPLETE
