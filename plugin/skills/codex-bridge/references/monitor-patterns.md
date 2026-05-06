# Monitor — Preset A only

The PostToolUse hook attempts to surface the Monitor invocation for background dispatches as `additionalContext`. If you do not see that handoff in the next turn, arm Monitor manually with `result.monitor.tool_hint` from the dispatch envelope. Do not assume the hook fired or that Claude Code delivered the context; verify that Monitor starts streaming within a few seconds. `setup --install-monitor-hook` installs the user-settings mirror for Claude Code versions affected by plugin-bundled `additionalContext` delivery bugs.

## Preset A — the only pattern that ships in v2.x

Use the literal `tool_hint` from the envelope in the parent thread. Do not wrap Monitor in an Agent subagent; that reintroduces false `completed` notifications for non-terminal progress. Default shape:

```json
{
  "description": "codex-bridge events for <task_id>",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs\" events <task_id> --follow --exclude HEARTBEAT,DIRECTIVES,CHECKPOINT --timeout-ms 1800000",
  "timeout_ms": 1800000,
  "persistent": false
}
```

Why these defaults:

- `--exclude HEARTBEAT,DIRECTIVES,CHECKPOINT` — heartbeats are pure liveness, directives are startup/runtime echoes, and full checkpoints are verbose forensic blocks. `[CHECKPOINT_SUMMARY]` remains visible; future tags pass through (forward-compat).
- `--timeout-ms 1800000` (30 min) — covers most write-mode tasks; adjust manually for unusually long runs.
- `persistent: false` — Monitor self-terminates on `[DONE]`/`[ERROR]`/`[INCOMPLETE]`/`[PLAN]`/`[CANCELLED]` and shouldn't keep running.

## Event tags you'll see

The bridge emits a fixed vocabulary on the `.events` stream. Treat unknown tags as forward-compat — pass them through, don't filter on assumed vocabulary. Canonical source: `.planning/codebase/ADAPTERS.md`.

| Tag | Category | Cadence / trigger | What to do |
|---|---|---|---|
| `[DONE]` | terminal | Task finished successfully | Monitor self-closes; inspect result/diff |
| `[ERROR]` | terminal | Non-recoverable failure | Read `origin:` line; see `error-recovery.md` |
| `[INCOMPLETE]` | terminal | Partial completion | Check `[PIPELINE:check:done] missing_items=…` for the failing criteria |
| `[CANCELLED]` | terminal | Task was cancelled | Monitor self-closes; inspect cancel result |
| `[PLAN]` | interrupt | Plan-mode produced a plan | `respond` approve or revise |
| `[QUESTION]` | interrupt | Backend asked a clarifier | `respond` with the answer |
| `[CONFIRMED]` | interrupt | Echo after a `respond` | Informational |
| `[CHECKPOINT_SUMMARY]` | progress | Every ~5 min | Read for "what is Codex doing"; act if drifting |
| `[CHECKPOINT]` | progress | Every ~5 min | Verbose forensic block; excluded by default |
| `[STALL_WARNING]` | recovery | Barren checkpoint before terminal stall | Inspect, steer, or cancel before `[ERROR]` |
| `[HEARTBEAT]` | progress | Every ~60 s | Liveness pulse; **excluded by default Monitor** |
| `[DIRECTIVES]` | bootstrap | Once at session start | Records mode/effort/sandbox/pipeline; informational |
| `[PIPELINE:<stage>]` | pipeline | Stage entered | Stages: `diff`, `plan`, `execute`, `review`, `fix`, `check` |
| `[PIPELINE:<stage>:done]` | pipeline | Stage completed | `check:done` carries `complete=…`/`missing_items=[…]` |
| `[PIPELINE:review:failed]` | pipeline | Review stage failed (non-timeout) | Fix stage is skipped; inspect the review output |
| `[PIPELINE:check:failed]` | pipeline | Check stage failed (non-timeout) | Pipeline already halted; inspect the check output |
| `[PIPELINE:done]` / `[PIPELINE:failed]` | pipeline | Whole pipeline finished | Pair with the most recent terminal tag |
| `[RETRYING]` | recovery | Bridge retrying transient failure | Watch `[HANDOFF]` / `[ERROR]` for exhaustion |
| `[PARTIAL]` | recovery | Commits landed before failure | `error.partial.commits` lists shas |
| `[HANDOFF]` | recovery | Carries artifact paths + retry history | Use to reseed a fresh task |
| `[WARNING]` | recovery | Circuit-breaker fired | Cancel if env can't run that family |
| `[ADAPTER:<name>:<event>]` | adapter | Backend-specific event | Treat as informational unless adapter docs say otherwise |

Continuation lines (indented under a header) inherit the header's filter decision, so default-excluded `[CHECKPOINT]` drops its body too.

## When Monitor is the wrong tool

- Watching `xcodebuild`, `npm test`, `cargo build`, etc. — those don't write `.events` files. Use `Bash --run-in-background`.
- Polling a file for content — plain shell loop (`until [ -s path ]; do sleep 1; done`).
- Watching N parallel Codex jobs — Monitor is single-job. Use `wait --any --predicate both` for the next actionable job, `wait --all` as the wave barrier, or `status --watch` for a live table.

If you see a foreign tail (anything not a codex-bridge `.events` file), Monitor's tag filter will never match and you'll waste the full timeout. Reach for the right tool instead.
