# Phase 1 — Analysis

| Case | Validity | Priority | Problem |
|---|---|---:|---|
| `24-P1-checkpoint-default-filter-mismatch.md` | Real | P1 | The bridge had one mid-run semantic progress event, verbose `[CHECKPOINT]`, but Monitor needed a concise live signal by default. Including `[CHECKPOINT]` flooded orchestrators; excluding it made long jobs look silent. |

## What The Problem Actually Is

`[CHECKPOINT]` was doing two jobs at once:

- Live orchestration: tell the parent thread that a long task is moving and what it is roughly doing.
- Forensics: preserve the last assistant message, all interval tool calls, commits, and diff details for later inspection.

Those audiences need different density. A live Monitor stream needs one short line. A forensic log can keep a multi-line body. The old default Monitor hint exposed only the verbose shape, so users either accepted a noisy stream or hand-authored narrow filters that accidentally removed the only semantic progress signal.

## Root Cause

The event model had no audience split for checkpoints. `formatCheckpointEvent` emitted only `[CHECKPOINT]`, and `buildMonitorHint` used the global `DEFAULT_MONITOR_EXCLUDE`. When that exclude list omitted `CHECKPOINT`, the default Monitor command passed through the full multi-line body. When users switched to inclusion filters that did not name `CHECKPOINT`, the bridge had no smaller checkpoint tag to survive the filter.

The root cause is not the line-filter implementation; continuation-line inheritance is correct and should remain. The defect is the single event shape plus default hint contract.

## Is It A Real Problem?

Yes. It is not P0 because terminal events, heartbeats, result inspection, and raw event files still exist. It is a P1 because the failure mode appears during normal long-running background jobs:

- At small scale, verbose checkpoints consume attention and context.
- At fan-out scale, every job emits dense checkpoint bodies on the same cadence.
- If users react by excluding checkpoint bodies or using narrow inclusion filters, live progress visibility collapses.

The claim that default Monitor should include a mid-stage progress signal is correct. The claim that full `[CHECKPOINT]` is too verbose for the default stream is also correct. The right fix is a summary variant, not choosing one side.

## Blast Radius

| Surface | What Breaks | Who Notices | When |
|---|---|---|---|
| `result.monitor.tool_hint` | Default command produces too much or too little checkpoint signal | Orchestrators managing background jobs | Any long task, especially N > 1 |
| `events --follow` | Excluding verbose checkpoint also removes semantic checkpoint progress | Users hand-running Monitor-equivalent commands | Long-running task monitoring |
| `skill/references/monitor-patterns.md` | Docs recommend the wrong density | Agents following packaged instructions | Dispatch and monitor setup |
| Generated `skill/scripts` / `plugin/scripts` | Installed surfaces drift from source | Runtime users | After build/package if not regenerated |

## Dependencies / Overlaps

| Overlap | Relationship |
|---|---|
| Stall-warning visibility | Adjacent but not required. `[STALL_WARNING]` handles barren progress; `[CHECKPOINT_SUMMARY]` handles normal progress. |
| Event-noise cluster | Same audience-density theme, but this case should not redesign all events. |
| Monitor filter defaults | Direct fix surface. Must remain exclusion-based for forward compatibility. |
| `DIRECTIVES` default filtering | Same Monitor noise surface: startup/runtime echoes are useful in raw `.events` files but too repetitive for default LLM Monitor context. |

# Phase 2 — GSD Implementation Plan

## Cluster Map

| Cluster | Shared Root Cause / Surface | Files |
|---|---|---|
| Checkpoint event shape | Single verbose checkpoint event | `src/lib/session-log.mjs`, `src/lib/task-runtime.mjs`, `src/adapters/index.d.ts` |
| Monitor default contract | Default hint must hide verbose body while showing summary | `src/lib/session-log.mjs`, `src/lib/envelope-helpers.mjs`, `src/commands-meta.mjs` |
| Documentation surfaces | Skill/plugin guidance must match runtime | `skill/SKILL.md`, `skill/references/*`, `plugin/commands/*`, `plugin/skills/codex-bridge/references/*`, `.planning/codebase/ADAPTERS.md` |
| Verification | Pin output shape and filter behavior | `test/session-log.test.mjs`, `test/events-exclude-heartbeat.test.mjs`, `test/plugin-surfaces.test.mjs` |

## Sequencing

| Wave | Work | Prerequisite | Verification |
|---|---|---|---|
| 1 | Add `formatCheckpointSummaryEvent` and emit it before verbose `[CHECKPOINT]` when checkpoint content exists | None | Unit test summary one-line shape |
| 2 | Change `DEFAULT_MONITOR_EXCLUDE` to `["HEARTBEAT", "DIRECTIVES", "CHECKPOINT"]` and let `buildMonitorHint` inherit it | Wave 1 | Unit test default exclude and tail commands |
| 3 | Update docs and command examples to describe summary-default / verbose-opt-in | Wave 2 | `rg` for stale `DIRECTIVES,CHECKPOINT` and stale default-only `--exclude HEARTBEAT` claims |
| 4 | Rebuild generated skill/plugin scripts | Waves 1-3 | `npm run build` and generated output grep |
| 5 | Run targeted then full test suite | Wave 4 | `node --test ...` and `npm test` |

## Per-Cluster Work Items

| Cluster | Behavior Change | Contract Fixed | Verification |
|---|---|---|---|
| Checkpoint event shape | Emit `[CHECKPOINT_SUMMARY] ... tools=N (...) ... last="..."` before existing verbose `[CHECKPOINT]` | Live progress has a concise tag; forensic detail remains available | `formatCheckpointSummaryEvent` unit test; event fixture keeps summary while dropping verbose body |
| Monitor default contract | Default Monitor command becomes `events <id> --follow --exclude HEARTBEAT,DIRECTIVES,CHECKPOINT --timeout-ms 1800000` | Default stream includes `[CHECKPOINT_SUMMARY]` and excludes heartbeat liveness, startup directives, and verbose `[CHECKPOINT]` | `DEFAULT_MONITOR_EXCLUDE` assertion; plugin surface expected hint |
| Documentation | References explain default-visible summary and verbose opt-in by relaxing the default exclude list | Agents stop hand-authoring brittle inclusion filters or noisy defaults | `rg` stale-string scan |
| Generated outputs | Bundled scripts reflect source constants and examples | Installed skill/plugin behave like source checkout | `npm run build`; grep generated `DEFAULT_MONITOR_EXCLUDE` |

## Risk And Rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Existing users expected verbose checkpoint in default Monitor stream | Verbose `[CHECKPOINT]` is still written and visible with `--exclude HEARTBEAT` | Revert `DEFAULT_MONITOR_EXCLUDE` only; keep summary event harmless |
| Summary line accidentally grows too large | Cap `last` with `compactPreview`; keep focus/tool breakdown bounded | Reduce summary fields to phase/tools/last |
| Docs drift from generated scripts | Run build after source/docs edits | Re-run build from source of truth |
| Existing users expected `[DIRECTIVES]` in the default live stream | `.events` still persists `[DIRECTIVES]`; Monitor users can opt in with `--exclude HEARTBEAT,CHECKPOINT` or no exclude | Revert only the `DIRECTIVES` entry and related docs/tests if this proves too quiet |

## Acceptance Criteria

| Case | Check |
|---|---|
| 14.24 | A fixture containing `[DIRECTIVES]`, `[CHECKPOINT_SUMMARY]`, verbose `[CHECKPOINT]`, and terminal tags streamed with `--exclude HEARTBEAT,DIRECTIVES,CHECKPOINT` shows summary and terminal tags, and hides directives plus the verbose checkpoint body. |
| 14.24 | `DEFAULT_MONITOR_EXCLUDE` equals `["HEARTBEAT", "DIRECTIVES", "CHECKPOINT"]`. |
| 14.24 | `result.monitor.tool_hint.command` contains `--exclude HEARTBEAT,DIRECTIVES,CHECKPOINT`. |
| 14.24 | Generated `skill/scripts/codex-bridge.mjs` and `plugin/scripts/codex-bridge.mjs` contain the same default exclude list. |

## Out Of Scope

- Global event taxonomy redesign beyond the checkpoint pair.
- Stall detector semantics beyond ensuring `[STALL_WARNING]` remains default-visible.
- Redesigning the full event vocabulary beyond the Monitor default noise filter.
- Multi-job fan-in UX beyond preserving a concise per-job checkpoint line.
- Any broader issues from feedback docs `00-13`, `15`, or other per-issue files.
