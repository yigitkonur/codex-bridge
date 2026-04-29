# Canonical Event Vocabulary

Single source of truth for the tags adapters emit. SKILL.md and references must link here, never duplicate.

## Lifecycle (terminal — Monitor self-closes)

| Tag | When | Effect |
|---|---|---|
| `[DONE]` | Task completed successfully | Monitor stops; `phase=done` |
| `[ERROR]` | Task failed (non-recoverable) | Monitor stops; `phase=error` |
| `[INCOMPLETE]` | Task partially completed | Monitor stops; `phase=incomplete` |

## Interrupts (act-now)

| Tag | When | Action |
|---|---|---|
| `[PLAN]` | Plan-mode produced a plan needing approval | Orchestrator calls `respond` with approve/revise |
| `[QUESTION]` | Backend asks a clarifying question | Orchestrator calls `respond` with the answer |
| `[CONFIRMED]` | Confirmation echo after a `respond` | Informational |

## Progress (periodic)

| Tag | Frequency | Purpose |
|---|---|---|
| `[CHECKPOINT]` | Every ~5 min | Snapshot of current state for resume / observation |
| `[HEARTBEAT]` | Every ~60 s | Liveness only; default Monitor `--exclude HEARTBEAT` |

## Pipeline (bridge-emitted)

| Tag | Meaning |
|---|---|
| `[PIPELINE:<stage>]` | Stage entered (`diff`, `plan`, `execute`, `review`, `fix`, `check`) |
| `[PIPELINE:<stage>:done]` | Stage completed |
| `[PIPELINE:done]` | All stages complete |
| `[PIPELINE:failed]` | A stage failed; pipeline halted |

## Recovery (bridge-emitted)

| Tag | Meaning |
|---|---|
| `[RETRYING]` | Bridge is retrying a transient failure |
| `[PARTIAL]` | Partial progress saved; task incomplete but artifacts present |
| `[HANDOFF]` | Handing off to a different stage / backend |
| `[WARNING]` | Non-fatal anomaly worth surfacing |

## Bootstrap (bridge-emitted)

| Tag | Meaning |
|---|---|
| `[DIRECTIVES]` | Bridge injected directives at session start (e.g. orchestrator preamble) |

## Adapter-namespaced events

Events that don't map to any canonical tag use the namespace `[ADAPTER:<name>:<event>]`:

- `[ADAPTER:gemini:search-result]`
- `[ADAPTER:aider:apply-edit]`
- `[ADAPTER:codex:thread-ready]`

The registry rejects adapters whose `capabilities().reserved_tags` collide with the canonical set above.

Default Monitor filter excludes `HEARTBEAT` and reserves output volume for actionable signals. If you need a higher-fidelity stream for debugging, use `events --follow` directly.

## Phase mapping

The `result.phase` field in the envelope is derived from the most recent terminal tag plus state:

| Terminal tag / state | Phase |
|---|---|
| `[DONE]` | `done` |
| `[ERROR]` (after retries exhausted) | `error` |
| `[ERROR]` (recoverable) | `incomplete` |
| `[INCOMPLETE]` | `incomplete` |
| (in progress, no terminal yet) | `running` |
| (queued, not started) | `queued` |
| (worktree dirty before start) | `workspace-dirty` |
| (plan-mode awaiting approval) | `plan-pending` |
| (cancelled by user) | `cancelled` |
