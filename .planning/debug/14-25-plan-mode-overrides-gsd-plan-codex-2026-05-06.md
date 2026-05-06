# Phase 1 — Analysis

## Focus Case

| Case | Validity | Priority | Summary |
|---|---|---:|---|
| `14.25` — plan-mode silently forced, `--effort` bumped, plan model switched | Real pre-fix, with one mitigation already present | P1 | The current runtime documents `mode: "plan"` as the shipped default in several surfaces, so that sub-claim is no longer fully silent. Pre-fix, explicit `--effort` and `--model` overrides were still real: plan turns forced `xhigh`, and the plan collaboration settings resolved model from config instead of the CLI request. |

## What The Problem Actually Is

`task --write --model X --effort Y ...` does not reliably run the first Codex turn with `X` and `Y`.

- `config.mode` defaults to `plan`, so a task without `--mode default` starts in plan collaboration mode. This is now documented in `src/commands-meta.mjs`, `skill/SKILL.md`, `skill/config.yaml`, and command references, but the queued JSON payload still does not show the resolved mode before the worker starts.
- `src/lib/task-runtime.mjs` sets first-turn `effort` to `"xhigh"` whenever `isPlanMode` is true, ignoring `request.effort`.
- Pre-fix, `src/lib/runtime-options.mjs::buildCollaborationMode("plan", ...)` also forced `reasoning_effort: "xhigh"`, so even callers that passed an effort into the collaboration settings lost it.
- `runBridgeTask` passes the CLI model as the top-level turn model, but builds `collaborationMode.settings.model` from `config.model`. With `--model gpt-5.5-codex` and default config `model: gpt-5.4`, the same turn carries two model values.
- Auto-pipeline stages use `config.model`, so a user-specified task model is not attributable across review/fix/check unless surfaced or propagated.

## Root Cause

Runtime option resolution is split across three locations with no single resolved-runtime contract:

| Surface | Current behavior | Defect |
|---|---|---|
| CLI handler (`src/handlers/task.mjs`) | Parses `--model` and `--effort`, then passes only raw request overrides into `buildTaskRequest`. | Does not resolve effective runtime values for the dispatch envelope. |
| Task runtime (`src/lib/task-runtime.mjs`) | Resolves mode from request/config, then hardcodes plan effort to `xhigh`; passes request model to top-level turn but config model to collaboration settings. | Explicit flags can be overwritten inside the final app-server params. |
| Collaboration helper (`src/lib/runtime-options.mjs`) | For any plan mode, `reasoning_effort` is always `xhigh`; model is `options.model ?? config.model`. | Helper makes caller intent impossible unless caller can bypass plan mode. |

There is also an observability gap: `[DIRECTIVES]` currently shows `mode`, `effort`, `sandbox`, `pipeline`, and one `model`, but not per-stage models or warnings. Background `task --json` returns only queued job metadata, so users cannot see the resolved runtime until the worker emits events.

## Is It A Real Problem?

Yes, but scoped:

- **Plan default**: partially overstated. The default is visible in current command metadata and skill docs. It is still insufficiently visible in the dispatch payload, especially for background jobs.
- **Effort override**: real. `--effort high` becomes `xhigh` for plan turns because both task runtime and collaboration helper hardcode it.
- **Model split**: real. A task can send `model: X` and `collaborationMode.settings.model: config.model` in the same `turn/start` params.
- **Priority**: P1 is justified. This does not corrupt data by itself, but it breaks user intent, reproducibility, and forensics on every plan-mode task using explicit flags.

## Blast Radius

| Impact | Who notices | When |
|---|---|---|
| Prompt conflict (`--write` task starts with plan instructions) | Orchestrators expecting direct edits | On tasks missing `--mode default`; mitigated by docs and plan approval flow |
| Cost/latency surprise from effort bump | Users deliberately lowering effort | Any plan-mode task with `--effort` |
| Model attribution failure | Users comparing model quality or costs | Any plan-mode task with `--model`; auto-pipeline adds another hidden stage model |
| Debugging friction | Anyone reading `task --json` rather than NDJSON | Background dispatch before events exist; foreground JSON without a resolved runtime block |

## Dependencies / Overlaps

| Overlap | Relationship |
|---|---|
| Event-stream truth cases | Same principle: user-visible surfaces must reflect what actually happened. Fix by adding resolved runtime to payload/events, not by relying on deep NDJSON. |
| Pipeline cases | Auto-pipeline already has separate stage behavior; model propagation must avoid hiding review/fix/check model choice. |
| CLI/docs cases | Help/docs are part of the fix only where they describe mode/model/effort. Broader CLI redesign is out of scope. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Cases | Root cause | Fix surface |
|---|---|---|---|
| Runtime resolution | `14.25` effort + model overrides | Plan-mode helper and task runtime override explicit request values | `src/lib/runtime-options.mjs`, `src/lib/task-runtime.mjs`, `src/handlers/task.mjs` |
| Observability contract | `14.25` hidden effective params | Dispatch/event surfaces omit resolved per-stage runtime | `src/lib/task-runtime.mjs`, `src/lib/session-log.mjs`, docs |
| Documentation alignment | `14.25` plan default and flag semantics | Some docs still said plan always forced `xhigh` | `src/commands-meta.mjs`, `skill/**`, generated `plugin/**`, `src/lib/AGENTS.md` |

## Sequencing

1. Runtime contract first: make explicit `--effort` and `--model` survive final turn params.
2. Observability second: attach a compact `runtime` block to task payloads and expand `[DIRECTIVES]` with per-stage models.
3. Documentation third: update only references that describe the changed mode/model/effort behavior.
4. Verification last: add regression tests, run `npm run build`, `npm test`, and fresh-context review.

## Per-Cluster Work Items

| Cluster | Files/modules likely touched | Behavior change | Contract fixed | Verification |
|---|---|---|---|---|
| Runtime resolution | `src/lib/runtime-options.mjs`, `src/lib/task-runtime.mjs`, `src/handlers/task.mjs` | Plan turns use explicit `request.effort` when present; collaboration settings use explicit/resolved task model; main task and auto-pipeline model resolve consistently from CLI > config > default. | CLI flags are canonical unless rejected. | Unit test captures fake plan-mode `turnParams` and asserts top-level + collaboration model/effort equal explicit flags. |
| Observability contract | `src/lib/task-runtime.mjs`, `src/lib/session-log.mjs` | `task --json` payloads include `runtime.requested`, `runtime.effective`, `runtime.models`, `runtime.pipeline`, `runtime.warnings`; `[DIRECTIVES]` includes compact `models=stage:model` and warning count. | Users can inspect effective params without NDJSON archaeology. | Tests assert runtime block and directives event include explicit values. |
| Documentation alignment | `src/commands-meta.mjs`, `skill/config.yaml`, `skill/SKILL.md`, `skill/references/*`, `plugin/skills/codex-bridge/references/notification-format.md`, `src/lib/AGENTS.md`; generated bundle/config after build | Docs say plan default remains `plan`; plan effort defaults to `xhigh` but explicit `--effort` wins; `--model` applies to the task turn and auto-pipeline for that run; runtime payload/events surface effective values. | Help/docs match source behavior. | `npm run build` updates generated files; `npm test` catches drift/static contracts. |

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Changing default model resolution may alter tasks that previously relied on upstream Codex config despite bridge default `gpt-5.4`. | This aligns runtime with existing `DEFAULT_CONFIG.model`; JSON/event runtime block makes it visible. | Revert only the resolved top-level model assignment while keeping explicit `--model` propagation. |
| Auto-pipeline using the requested model may increase cost if a user passes a premium model. | Explicit model should mean the run uses that model; runtime block lists pipeline models. | Limit pipeline model propagation to explicit request only, leaving config model for unset requests. |
| `[DIRECTIVES]` parsers expecting only old keys could be brittle. | Existing docs already require key-value parsing split on ` | `; append optional `models`/`warnings` fields. | Remove optional fields while retaining JSON payload `runtime`. |
| Existing local dirty worktree has many unrelated edits. | Touch only files required for this focus case; do not revert unrelated changes. | Revert this commit only; it should be semantically isolated. |

## Acceptance Criteria

| Case | Acceptance check |
|---|---|
| `14.25` plan default visibility | `task --background --json ...` includes `result.runtime.effective.mode: "plan"` when config/default selects plan. |
| `14.25` effort override | A plan-mode task dispatched with `--effort high` sends top-level `effort: "high"` and `collaborationMode.settings.reasoning_effort: "high"`. |
| `14.25` model override | A plan-mode task dispatched with `--model gpt-5.5-codex` sends top-level `model: "gpt-5.5-codex"` and `collaborationMode.settings.model: "gpt-5.5-codex"`. |
| `14.25` attribution | The task payload and `[DIRECTIVES]` event list stage models without reading raw NDJSON. |
| `14.25` docs | Help/skill/config docs no longer claim explicit `--effort` is ignored in plan mode. |

## Out Of Scope

- Changing the shipped default from `mode: "plan"` to `mode: "default"`.
- Adding new stage-specific flags such as `--plan-model`, `--review-model`, or `--model.plan`.
- Reworking the broader auto-pipeline architecture, review semantics, or event taxonomy beyond the runtime fields needed here.
- Any issue from feedback files `00–13`, `15`, flat `14-real-world-failure-cases.md`, or other per-issue files not marked `YOUR FOCUS`.
