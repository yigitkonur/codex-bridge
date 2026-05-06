# Phase 1 — Analysis

| Case | Validated priority | Verdict |
|---|---:|---|
| `14-P1-monitor-on-n-jobs-anti-pattern.md` | P1 docs/UX | Real discoverability bug; not a core runtime correctness bug |

## Problem

The bridge teaches the single-job Monitor handoff before it states the boundary condition. A first-time user sees `task --background --json` returning `result.monitor.tool_hint` and naturally repeats that pattern for N parallel jobs. That creates N separate event streams, noisy parent-thread output, and confusing completion labels when wrapper agents are involved.

The actual contract is narrower: `result.monitor.tool_hint` is for one job. For N > 1 jobs, the orchestrator should use `wait --any --predicate both` to wake on the next actionable job, `wait --all` as the wave barrier, `status --watch` for a live table, or `await-artifact` when each job has a known output file.

## Root Cause

This is a first-use documentation and help-ordering failure:

| Surface | Current failure mode | Fix role |
|---|---|---|
| `skill/SKILL.md` Quick Start | Async Monitor pattern appears before the N-job warning much later in the file | Put the N > 1 caveat next to the async pattern |
| `plugin/skills/codex-bridge/SKILL.md` | Monitor handoff is explained, but the parallel caveat lives only in a reference pointer | Put the caveat in the main plugin skill body |
| `plugin/commands/task.md` | Slash command tells Claude how to attach Monitor, with no fan-out warning | Add the caveat at the command execution surface |
| `src/commands-meta.mjs` task help | `task --help` advertises background jobs but not the single-job Monitor boundary | Add the caveat to help text |
| `skill/references/monitor-patterns.md` | Legacy reference contradicted the intended rule by saying each parallel task gets its own Monitor | Replace with the fan-in pattern |

The runtime already has usable fan-in primitives: `wait --any --predicate both`, `wait --all`, `status --watch`, and `await-artifact`. The missing piece is surfacing them before users copy the wrong pattern.

## Is It Real?

Yes, as P1 documentation/UX. Multiple agents independently fell into the same pattern, which means the warning was not visible at decision time.

The original report is partly overstated:

| Claim | Assessment |
|---|---|
| “Missing fan-in primitive” | Stale for this checkout: `wait --any --predicate both`, `wait --all`, `status --watch`, and `await-artifact` exist. |
| “Runner agent docs lack warning” | Already mitigated: runner docs now forbid parallel dispatch through the runner. |
| “Resource exhaustion” | Plausible at high N, but not evidenced enough to drive the fix. |
| “Need runtime monitor-attached detection” | Not selected: current state tracks jobs, not whether a Monitor is attached or whether `status --watch` is running. A heuristic would be noisy. |
| “Need `monitor-fanout.sh`” | Not selected first: existing CLI primitives are simpler and already tested. |

## Blast Radius

| Who notices | When | Observable failure |
|---|---|---|
| First-time fan-out orchestrators | After launching 2+ background jobs | Parent thread fills with per-job event streams |
| Users relying on wrapper agents | During Monitor returns | Agent/tool completion labels can be mistaken for job completion |
| Multi-job reviewers/auditors | At N=5+ | Status synthesis becomes manual and noisy |

Single-job Monitor use is unaffected. Job execution integrity is not the main risk; the damage is orchestration noise, wasted time, and wrong mental model.

## Dependencies / Overlaps

| Related area | Relationship |
|---|---|
| Event noise cases | Stacked Monitor amplifies noise, but does not cause incorrect event emission by itself. |
| Runner false-completion cases | Wrapper agents can make stacked Monitor output look like completed work; current runner docs already reduce this. |
| Multi-job primitives | `wait --any --predicate both`, `wait --all`, `status --watch`, and `await-artifact` are the replacement path and should be referenced, not reinvented. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Cases | Root cause | Fix surface |
|---|---|---|---|
| First-use fan-out guardrail | 14.14 | Single-job Monitor boundary is documented too late and inconsistently | Main skill docs, plugin skill, slash command, CLI help, legacy monitor reference |

## Sequencing

1. Add the fan-out warning to first-use docs → verify with static text tests.
2. Fix the contradictory legacy monitor reference → verify the old “each task gets its own Monitor” text is absent.
3. Add CLI help coverage → verify `task --help` includes `wait --any --predicate both`, `wait --all`, and `status --watch`.
4. Rebuild generated bundles because `src/commands-meta.mjs` changed.
5. Run targeted static tests, then the full standard check if the shared dirty branch permits it.

## Per-Cluster Work Items

| Work item | Files/modules | Behavior/contract fixed | Verification |
|---|---|---|---|
| Quick Start warning | `skill/SKILL.md` | Async Monitor pattern now states it is single-job before users fan out | Static regex test |
| Packaged plugin warning | `plugin/skills/codex-bridge/SKILL.md` | Plugin users see the N > 1 caveat in the main skill body | Static regex test |
| Slash command warning | `plugin/commands/task.md` | `/codex-bridge:task` instructs Claude not to arm one Monitor per job | Existing command-surface test expanded |
| CLI help warning | `src/commands-meta.mjs` | `task --help` warns at invocation time | Spawn `node src/codex-bridge.mjs task --help` in test |
| Reference correction | `skill/references/monitor-patterns.md` | Legacy monitor reference no longer recommends stacked Monitors | Static negative assertion |

## Risk + Rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Over-warning single-job users | Keep wording short and scoped to “N > 1” only | Revert doc hunks only |
| Stale generated CLI bundles | Run `npm run build` after `src/commands-meta.mjs` change | Re-run build from source |
| Confusion between `status --watch`, `wait --any`, and `wait --all` | Name each primitive by use case: live table vs next actionable job vs wave barrier | Keep only `status --watch` in docs if needed |
| Runtime heuristic false positives | Do not implement runtime detection in this wave | Future design can add explicit monitor/fan-in state |

## Acceptance Criteria

| Case | Proof |
|---|---|
| 14.14 | A reader of Quick Start, plugin skill, `/codex-bridge:task`, or `task --help` sees “Monitor is single-job; for N > 1 use `wait --any --predicate both`, `wait --all`, or `status --watch`” before needing the deep reference. |

## Out of Scope

- New `monitor-fanout.sh` script.
- Runtime detection of “stacked Monitors”.
- New job grouping or pending-question primitives.
- Broader event-noise filtering changes.
- Any P0/P1 cases outside `14-P1-monitor-on-n-jobs-anti-pattern.md`.
