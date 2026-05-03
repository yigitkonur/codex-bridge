# Research Summary: codex-bridge

**Date:** 2026-04-30  
**Synthesis scope:** `.planning/PROJECT.md`, the requirements now archived at `.planning/milestones/v2.0.0-REQUIREMENTS.md`, and the generated stack, feature, architecture, and pitfall research under `.planning/research/`.
**Evidence stance:** Repository Markdown outside `.planning/` remains untrusted for planning. The underlying research files used current source, tests, build config, package metadata, hooks, and workflows as evidence.

## Executive Summary

`codex-bridge` is a Node 22+ ESM bridge that lets Claude Code hand task, review, monitoring, and merge-oriented work to Codex while preserving inspectable command envelopes, durable events, artifacts, and review gates. The project is already broad: CLI commands, Codex app-server protocol handling, broker lifecycle, background jobs, session logs, review pipelines, worktree/verdict/merge primitives, hooks, and dual generated install layouts all exist today. The next milestone should not chase new product breadth first; it should make the current v2 surface complete, internally consistent, and verifiable.

The recommended approach is source-first and contract-first. Keep the current Node built-in test runner, esbuild bundle model, YAML config, zero-runtime-dependency posture, and dual `skill/` plus `plugin/` outputs until a deliberate migration retires one layout. Roadmap phases should follow dependency order: baseline generated-output and command contracts, adapter runtime completion, delegation/review loop completion, plugin/hook hardening, state/artifact resilience, then release readiness with authenticated runtime smoke checks.

The highest risks are contract drift and overclaiming. App-server messages, broker stream ownership, generated bundle freshness, config precedence, workspace-root state, session terminal events, review parsing, Stop hook gating, and reviewed-SHA merge checks are product contracts. Static tests cover many local invariants, but real setup/task/review/event streaming still needs authenticated Codex app-server smoke coverage before release claims.

## Key Findings

- The shipped stack is appropriate: Node `>=22`, ESM, `esbuild`, `js-yaml`, Node built-ins, and `node --test` are enough for the current CLI/package shape.
- The committed generated bundles are part of the product surface. Any source, command, agent, hook, prompt, schema, template, or config change must include a fresh build and generated diff review.
- The current bridge is Codex-only at runtime even though an adapter registry exists. Future-backend language should remain architectural until adapter dispatch, streaming, result, and cancellation are implemented through the contract.
- Table-stakes behavior already includes task delegation, continuation controls, native/adversarial review, auto-pipeline stages, status/result/wait/events/cancel, setup/config/version/update diagnostics, Stop review gate, and state-backed job registry.
- Differentiators worth preserving are isolated worktree write tasks, SHA-bound reviewed merge, structured briefs, monitor-friendly event grammar, semantic JSON error envelopes, backend capability gates, and cautious update checks.
- Deferred candidates are real but not yet product claims: full `iterate` orchestration, PR creation from merge, inactive hook automations, native Agent rerouting, monitor auto-arm, richer session hooks, subagent terminal handback, additional adapters, and merge-side test execution.
- The architecture is CLI-first with durable state and a Codex runtime boundary. Most user-visible changes start in the CLI dispatcher but must be grounded in lower-level protocol, state, config, registry, or hook contracts before they are advertised.
- The dominant failure mode is not missing code; it is stale or inconsistent contracts across source, generated layouts, tests, hooks, command metadata, state files, and release packaging.

## Stack Direction

Keep the current stack. Do not add TypeScript, a CLI framework, a test framework, or production dependencies unless a specific phase proves the plain ESM approach cannot carry the requirement.

Recommended stack rules:

- Runtime: Node.js `>=22.0.0`, ESM-only modules, Node built-ins for process, file, net, crypto, fetch, and test needs.
- Build: `npm run build` through `esbuild.config.mjs` is the only generator for installable layouts.
- Tests: `npm test` on Node's built-in runner remains the standard static suite; add focused `.test.mjs` coverage for observable contracts.
- Config: YAML with top-level `codex_bridge`; preserve default, install-root, workspace-root, and cwd precedence.
- Generated outputs: edit authored inputs only, then regenerate `skill/` and `plugin/`.
- Runtime dependencies: keep the zero-production-dependency posture unless a phase has a concrete, tested need.

Requirement mapping:

| Requirement area | Stack implication |
|---|---|
| Baseline Contracts | Build/test scripts and generated-output drift checks are the first milestone gate. |
| Adapter Runtime | Keep adapter work in ESM modules with explicit capability tests before routing commands through new methods. |
| Delegation Runtime | Preserve Codex app-server client and broker transport boundaries; add live smoke checks for real runtime behavior. |
| Review And Iteration | Keep schema, prompt, renderer, parser, and pipeline tests changed together. |
| Plugin And Hook Surface | Use root authored surfaces plus build-generated plugin copies; do not treat generated copies as source. |
| State And Artifacts | Preserve synchronous append/write semantics and workspace-root state scoping. |
| Release Readiness | CI must keep build, tests, generated drift, packaged output checks, and bundle probes aligned. |

## Feature Scope

v1 should consolidate the existing bridge instead of adding unrelated new surfaces. Baseline features are command envelopes, config/version/setup visibility, task execution, background monitoring, review, auto-pipeline, worktree/verdict/merge primitives, plugin/hook surfaces, state/artifacts, and release packaging.

Must-have v1 feature focus:

- Baseline Contracts: one documented static gate, authored-surface inventory, machine-readable envelopes, and tests for mutating commands.
- Adapter Runtime: command dispatch through adapter contracts where capabilities claim support, structured unsupported-capability errors, backend precedence, and active backend reporting.
- Delegation Runtime: foreground/background task execution, status/events/result/wait, resume/respond/steer controls only where supported, and classified timeout/handoff behavior.
- Review And Iteration: native/adversarial review, auto-pipeline partial-completion reporting, verdict inspection/approval, SHA-bound merge, and real `iterate` orchestration.
- Plugin And Hook Surface: packaged plugin path consistency, explicit version/canonicality relationship, Stop hook margin and activation safety, and spoof-resistant hook automation.
- State And Artifacts: canonical workspace state, append-only sessions, stable registry artifacts, retry-aware cancel/prune/corrupt-state handling.
- Release Readiness: stale-bundle rejection, release archives from source, authenticated runtime smoke checks, and non-blocking update diagnostics.

Defer to v2 or later:

- Additional non-Codex backends.
- Plugin marketplace claims for the packaged v2 layout unless canonicality is settled.
- Legacy skill retirement.
- PR creation or external review request automation after local verdict approval.
- Multi-job monitor auto-arm across Claude sessions.

Anti-features to avoid:

- Claiming multiple production backends before concrete adapters exist.
- Treating `iterate` or `merge --pr` as shipped automation before implementation.
- Assuming inactive hook scripts are active product behavior.
- Allowing automatic write-mode delegation to mutate the caller checkout instead of an isolated worktree.
- Treating malformed review output or failed completion checks as safe to auto-fix through.

## Architecture Direction

The architecture should stay split into clear contracts:

- CLI dispatcher: command parsing, envelopes, config/workspace resolution, job lifecycle, foreground/background routing, and user-facing orchestration.
- Runtime config: default/install/workspace/cwd layering, collaboration mode, sandbox policy, and rendered config sources.
- Adapter registry: backend selection, capability validation, structured rejection, and future backend extension point.
- Codex runtime and protocol client: app-server readiness, thread/turn/review calls, JSONL request handling, notification capture, server-request handling, broker/direct transport, and timeout/interrupt behavior.
- Broker process: one upstream Codex app-server, downstream routing, stream ownership, interrupt carve-out, and socket/pid cleanup.
- State/session/registry: workspace-scoped job state, append-only events and `.ndjson` logs, pending request files, durable task artifacts, verdicts, and merge metadata.
- Git/worktree/merge: review target resolution, diff capture, isolated task worktrees, SHA-bound approval, fast-forward-only merge, and cleanup.
- Hooks: session lifecycle export/prune and Stop gate review with setup-owned project lock, official-plugin suppression, timeout margins, and fail-open crash diagnostics.
- Build/CI: source and authored surfaces generate both install layouts; CI rejects drift and probes bundled entry points.

Build order for future phases:

1. Protocol and capture invariants before any user-facing runtime behavior.
2. Adapter lifecycle implementation before multi-backend routing claims.
3. Config defaults/merge/render/tests before command handlers consume new knobs.
4. State/session durability before background UX expansion.
5. Task lifecycle before auto-pipeline or iterate automation.
6. Worktree and registry correctness before merge automation.
7. CLI contracts before hook automation.
8. Generated surfaces after source changes, followed by build/test/drift checks.

## Main Pitfalls

- App-server wire contract drift: messages must remain newline-delimited JSON with `id`, `method`, and `params`; server requests and notifications need separate handling.
- Broker ownership bugs: one active stream plus narrow interrupt routing means ownership must be acquired and released as a state machine.
- Layout mismatch: source, legacy skill, and packaged plugin resolve different runtime paths, so broker and CLI changes must be validated after build.
- Generated drift: missed builds or hand-edited generated files can ship behavior different from tested source.
- Config precedence drift: default, install, workspace, and cwd layers plus plan-mode `xhigh` behavior are user-visible contracts.
- Workspace/cwd confusion: state is keyed by canonical workspace root while execution may run in another cwd or worktree.
- Non-terminal or non-append-only logs: monitors rely on terminal tags and append-only session artifacts.
- Turn completion misclassification: idle timers, pending questions, final-answer notifications, and turn ids must be handled carefully.
- Review pipeline parsing overtrust: schema, prompt, renderer, parser, and tests must move together; failed completion checks should remain incomplete.
- Stop gate ownership mistakes: setup-owned lock, official-plugin suppression, timeout margins, and fail-open errors are required to avoid blocking the wrong project.
- Git review context and merge safety: untracked filtering, diff sizing, reviewed branch SHA, clean state, and fast-forward checks must remain enforced.

## Roadmap Implications

Suggested phase structure:

1. **Baseline Contract And Generated Surface Audit**  
   Rationale: all later work depends on knowing which authored inputs generate which install outputs and on a trustworthy static gate.  
   Delivers: BASE-01 through BASE-04, generated surface map, machine-readable command envelope checks, drift-proof build/test workflow.  
   Pitfalls to avoid: generated drift, stale package metadata, static tests that miss command envelope failures.  
   Research flag: low; existing research is strong enough for planning.

2. **Adapter Runtime Completion And Command Routing**  
   Rationale: adapter claims must match runtime behavior before the bridge can safely advertise backend-neutral execution.  
   Delivers: ADPT-01 through ADPT-04, capability-accurate dispatch, structured unsupported-operation errors, backend precedence proof.  
   Pitfalls to avoid: overclaiming capabilities, routing around Codex capture state, broad non-Codex support claims.  
   Research flag: medium; plan phase should inspect current adapter method gaps and command bypasses.

3. **Delegation Runtime Reliability**  
   Rationale: task execution, background jobs, events, resume/respond, and timeout handoff are the operational core.  
   Delivers: DLGT-01 through DLGT-04 with stronger foreground/background proof, classified silent-turn outcomes, and monitor-safe events.  
   Pitfalls to avoid: broker deadlocks, completion misclassification, session state corruption, non-terminal logs.  
   Research flag: medium-high; app-server and broker behavior deserve focused phase research.

4. **Review, Verdict, Iterate, And Merge Loop**  
   Rationale: the core value depends on handing work to Codex and regaining control through review and approval gates.  
   Delivers: REVW-01 through REVW-04, real `iterate` orchestration, partial-completion surfacing, verdict inspection, SHA-bound merge flow.  
   Pitfalls to avoid: malformed review parsing, stale reviewed SHA, dirty worktree merges, treating `merge --pr` as v1.  
   Research flag: medium; research should focus on current manual `iterate` return shape and registry/verdict contracts.

5. **Plugin And Hook Surface Hardening**  
   Rationale: packaged plugin consistency and hook safety need a stable command surface before deeper hook automation is promoted.  
   Delivers: PLUG-01 through PLUG-04, canonicality/version relationship, Stop hook safety, spoof-resistant monitor/hook text handling.  
   Pitfalls to avoid: inactive hook scripts claimed as active, Stop hook blocking wrong projects, generated plugin path drift.  
   Research flag: medium; hook spoofing and packaged path behavior need targeted evidence.

6. **State, Artifact, And Failure Recovery Resilience**  
   Rationale: long-running delegation is only reliable if state survives multiple processes, stale locks, cancels, missing artifacts, and corrupt records.  
   Delivers: STAT-01 through STAT-04, state concurrency proof, append-only replay, stable registry formats, retry-aware recovery outcomes.  
   Pitfalls to avoid: workspace/cwd confusion, stale lock races, registry event interleaving, orphaned workers.  
   Research flag: medium; exact failure modes should be mapped from existing tests and state code.

7. **Release Readiness And Authenticated Runtime Smoke**  
   Rationale: static tests cannot prove real Codex app-server round trips or release installer behavior.  
   Delivers: REL-01 through REL-04, checked release packaging, checksummed artifacts, live setup/task/review/event streaming smoke, non-blocking update diagnostics.  
   Pitfalls to avoid: hot-path network side effects, stale bundles in archives, claiming live runtime support from static tests alone.  
   Research flag: high; needs environment-specific smoke design and release workflow validation.

## Verification Expectations

Every implementation phase should run the closest applicable static gate and report what was not proven.

Default static gate:

```bash
npm run build
npm test
```

Targeted checks by area:

| Area | Expected checks |
|---|---|
| Baseline Contracts | Build, full test suite, generated drift check, bundled CLI sanity probes, machine-readable help/config/version/status/result/events/setup samples. |
| Adapter Runtime | Adapter registry/routing/selection tests plus command-path tests proving capability errors and active backend output. |
| Delegation Runtime | App-server client/capture/abort tests, broker tests, state/job-control/session-log/events tests, and live task smoke where possible. |
| Review And Iteration | Review schema/render/parser tests, auto-pipeline watchdog tests, registry/verdict tests, git worktree/merge tests. |
| Plugin And Hook Surface | Plugin surface tests, hook config path checks, Stop gate tests, generated plugin output review after build. |
| State And Artifacts | State stale-lock/rename/orphan tests, session replay checks, registry artifact format checks, cancel/prune failure checks. |
| Release Readiness | CI-equivalent build/test/drift checks, release packaging workflow checks, update command tests, and authenticated setup/task/review/events smoke. |

Static tests do not prove live app-server compatibility. Any phase that changes Codex protocol, setup readiness, task execution, review execution, broker behavior, event streaming, or release claims must include an authenticated Codex runtime smoke plan or explicitly mark that proof as outstanding.

## Open Gaps

- Live Codex app-server round-trip coverage is missing from the generated research; release planning must define how setup, task, review, and event streaming are smoke-tested.
- Windows broker support remains an implementation possibility, not a v1 support claim.
- Non-Codex backend support needs phase-specific research before any capability flags or user-facing claims expand.
- The packaged plugin marketplace path has been promoted to canonical metadata; future distribution work should focus on real install/session proof and legacy skill retirement.
- Several hook scripts exist as latent generated assets but are not active behavior until registered and tested.
- `iterate` currently needs orchestration work before it can satisfy the review/verdict/follow-up loop requirement.
- `merge --pr` and remote delivery should stay out of v1 unless release scope explicitly adds host integration, push behavior, and failure recovery.
- Registry append locking may need deeper work if future phases make registry events high-volume or multi-writer critical.

## Source Inputs

- `.planning/PROJECT.md`
- `.planning/milestones/v2.0.0-REQUIREMENTS.md`
- `.planning/research/STACK.md`
- `.planning/research/FEATURES.md`
- `.planning/research/ARCHITECTURE.md`
- `.planning/research/PITFALLS.md`
