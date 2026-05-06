# Phase 1 — Analysis

| Case | Validity | Priority | Precise problem |
|---|---|---:|---|
| 14.23 status JSON shape/progress | Real, partly already mitigated | P1 | List-mode `status --json` exposes human grouping fields but no canonical `jobs: []` list contract, no explicit `--session`/`--since` list filters, and running jobs expose only preview text instead of a bounded structured progress digest. |

## What The Problem Actually Is

`status <job-id> --json` is a single-resource query and returns `result.job`. List-mode `status --json` / `status --all --json` is a collection query, but the durable collection fields are `running`, `latestFinished`, and `recent`. That is useful for rendering, but it is not a symmetric machine contract: consumers cannot rely on `result.jobs` always being an array.

Job lifecycle naming is less severe than reported in the current code: job records use `status` as the canonical field. The `state` naming appears in attention/result subdocuments, not as the primary job lifecycle field. The correct fix is to document and preserve `status` on job objects, not to add another alias.

The progress complaint is valid. `enrichJob` already derives `progressPreview` for human output from the job log, but there is no structured `job.progress` object with elapsed time, last action, command/file-change counts, and event count. Orchestrators polling 10-20 jobs get "running" plus some unstructured lines.

Cross-session noise is partly mitigated in the current branch: `buildStatusSnapshot` already scopes to `CODEX_COMPANION_SESSION_ID` by default and `--all` disables that implicit scope. The remaining gap is explicit machine filters: `--session <id>` and `--since <timestamp>`.

## Root Cause

The status implementation grew from a human-rendered dashboard shape. `buildStatusSnapshot` builds presentation buckets (`running`, `latestFinished`, `recent`) and `renderStatusReport` consumes those buckets directly. The JSON envelope currently reuses that render model instead of projecting a stable resource/list API shape.

Progress data exists in fragments but is not normalized:

- job log lines hold progress messages and timestamps;
- job state records hold `status`, `phase`, `threadId`, timestamps, and sometimes worktree/session paths;
- events files hold bounded status/event tags;
- result payloads hold terminal touched files only after completion.

No single helper composes those into a small status-safe digest.

Filtering has the same presentation-origin issue. Implicit session scoping exists for Claude hook context, while explicit query filters were never added to the CLI parser or status snapshot contract.

## Is It A Real Problem?

Yes, but the file overstates two points:

- `result.jobs: null` is not the current code shape; the current issue is absence of `result.jobs`, not a live null emission path found in source.
- `status` vs `state` is not primary-job ambiguity in the current code. `status` is canonical on job objects; `state` is used for attention/result states.

The P1 classification still holds because the remaining failure affects every programmatic list-mode status poll and compounds in parallel orchestration.

## Blast Radius

| Surface | Who notices | Manifestation |
|---|---|---|
| `status --json` / `status --all --json` | Orchestrators and slash-command wrappers | Consumers must parse render buckets instead of a stable `jobs` array. |
| Long-running background jobs | Parent agent/orchestrator | Polls show active status without a structured answer to "what changed since launch?" |
| Parallel batches | Multi-agent workflows | N running jobs look identical unless each events/log file is inspected. |
| Long-lived workspaces | Users with many historical jobs | `--all` can include old sessions; explicit `--session` / `--since` is needed for deterministic filters. |

## Dependencies / Overlaps

| Overlap | Relationship | Sequencing decision |
|---|---|---|
| 14.19 status summary visibility | Shared `buildStatusSnapshot` surface; current dirty branch already adds `summary` / `needs_attention`. | Build on it; do not rework event-terminal classification. |
| 15.4 schema asymmetry | Same core issue as 14.23 Fix A/B. | Implement here through `jobs` list and docs. |
| 15.5 progress block | Same core issue as 14.23 Fix C. | Implement status-level progress only; defer heartbeat/PROGRESS event tags. |
| Event stream redesign docs | Larger architecture change. | Out of scope. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Cases covered | Fix surface | Contract |
|---|---|---|---|
| A. List JSON shape | 14.23 Fix A/B, 15.4 | `src/lib/job-control.mjs`, `src/handlers/inspect.mjs`, tests, docs | List-mode status includes `result.jobs` as an array and `result.as_of`; single-job status keeps only `result.job`. Job lifecycle field is `status`. |
| B. Structured progress | 14.23 Fix C, 15.5 | `src/lib/job-control.mjs`, tests, docs | Active jobs expose `job.progress` with bounded fields derived from existing log/event/state data. |
| C. Explicit filters | 14.23 Fix D | `src/lib/job-control.mjs`, `src/handlers/inspect.mjs`, `src/commands-meta.mjs`, plugin command docs | `status --session <id>` and `status --since <iso>` filter list/watch views without requiring consumers to post-filter. |
| D. Documentation | 14.23 Fix E | `skill/references/command-reference.md`, `plugin/commands/status.md`, command metadata | Runtime help and user reference describe the JSON contract and filters. |

## Sequencing

1. Contract tests first: add a focused `test/status-json-shape-progress.test.mjs` that fails on missing `jobs`, missing active-job `progress`, and unsupported filters.
2. Snapshot projection: update `buildStatusSnapshot` to select jobs with explicit filters, enrich all selected jobs once, and return `jobs`, `summary`, `as_of`, plus existing render buckets.
3. Progress digest: add log/event readers that compute bounded active-job progress without tailing transcripts or persisting caller state.
4. CLI wiring: parse/pass `--session` and `--since` through normal status and watch modes.
5. Docs/help: update status synopsis/reference with list schema and explicit filters.
6. Verification: run focused tests, `npm test`, and `npm run build`; inspect generated drift because this repository has concurrent dirty work.

## Per-Cluster Work Items

| Cluster | Likely files | Behavior change | Verification |
|---|---|---|---|
| A | `src/lib/job-control.mjs`, `test/status-json-shape-progress.test.mjs` | List snapshots include `jobs: []` even when empty; populated list contains enriched job objects using `status`. | Test empty/list populated status snapshot and CLI JSON envelope. |
| B | `src/lib/job-control.mjs`, `test/status-json-shape-progress.test.mjs` | Active job object includes `progress.elapsed_seconds`, `artifacts_written`, `shell_commands_run`, `last_action`, `last_action_at_seconds`, `tokens_consumed_estimate`, `events_since_last_status`. | Seed a running job log/events file and assert bounded structured progress fields. |
| C | `src/handlers/inspect.mjs`, `src/lib/job-control.mjs`, `src/commands-meta.mjs` | `--session` overrides implicit session scoping; `--since` keeps jobs updated/created at or after the timestamp; filters apply to watch/list mode. | CLI tests spawn `status --all --session ... --json` and `status --since ... --json`. |
| D | `skill/references/command-reference.md`, `plugin/commands/status.md` | Users can discover the stable JSON shape and filters from shipped command surfaces. | `node src/codex-bridge.mjs status --help` includes flags; docs cite implemented fields only. |

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Existing consumers rely on `running` / `recent` / `latestFinished`. | Keep existing fields; add `jobs` rather than replacing buckets. | Revert snapshot additions; render paths remain unchanged. |
| Progress computation could make status slow. | Use existing job log and events file only; no recursive filesystem scan or full transcript tail. | Drop `progress` builder and retain `progressPreview`. |
| `--since` semantics can be ambiguous. | Define it as updated/created/completed timestamp at or after the supplied timestamp. | Remove CLI filter while preserving session filter. |
| Concurrent dirty generated bundles can mix unrelated changes. | Stage only issue-owned source/tests/docs where possible; call out any build-generated files that could not be isolated. | Re-run build after other agents land their changes. |

## Acceptance Criteria

| Case | Check |
|---|---|
| 14.23 shape | `status --all --json` returns `result.jobs` as an array; empty state returns `[]`, never `null`. |
| 14.23 canonical status | Every job in `result.job` / `result.jobs[]` has `status`; no plan depends on `job.state`. |
| 14.23 progress | A running seeded job returns `result.job.progress` and `result.jobs[0].progress` with elapsed, action, command/file-change counts, and event count. |
| 14.23 session filter | `status --all --session current --json` excludes jobs from other sessions. |
| 14.23 since filter | `status --since <timestamp> --json` excludes older jobs while preserving newer matching jobs. |

## Out Of Scope

- Adding a new `[PROGRESS]` event tag or changing `[HEARTBEAT]` bodies.
- Replacing `running` / `recent` / `latestFinished` legacy JSON fields.
- Redesigning the full status/event schema from documents 00-13 or 15.
- Any non-focus cases under `14-real-world-failure-cases/`.
- Broader job-label, mode-name, wait-primitive, or worktree lifecycle changes.
