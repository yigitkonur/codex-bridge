# Monitor — Preset A only

The hooks auto-arm Monitor on background dispatches; you almost never derive the invocation by hand. The runtime emits the canonical payload at `result.monitor.tool_hint` and the PostToolUse hook surfaces it as `additionalContext`.

## Preset A — the only pattern that ships in v2.x

Use the literal `tool_hint` from the envelope. Default shape:

```json
{
  "description": "codex-bridge events for <task_id>",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs\" events <task_id> --follow --exclude HEARTBEAT --timeout-ms 1800000",
  "timeout_ms": 1800000,
  "persistent": false
}
```

Why these defaults:

- `--exclude HEARTBEAT` — heartbeats are 60-s liveness pulses; useful in raw-tail mode but flood Monitor's window. Excluded by default; future tags pass through (forward-compat).
- `--timeout-ms 1800000` (30 min) — covers most write-mode tasks; adjust manually for unusually long runs.
- `persistent: false` — Monitor self-terminates on `[DONE]`/`[ERROR]`/`[INCOMPLETE]`/`[PLAN]` and shouldn't keep running.

## Event tags you'll see

The bridge emits a fixed vocabulary on the `.events` stream. Treat unknown tags as forward-compat — pass them through, don't filter on assumed vocabulary. Canonical source: `.planning/codebase/ADAPTERS.md`.

| Tag | Category | Cadence / trigger | What to do |
|---|---|---|---|
| `[DONE]` | terminal | Task finished successfully | Monitor self-closes; inspect result/diff |
| `[ERROR]` | terminal | Non-recoverable failure | Read `origin:` line; see `error-recovery.md` |
| `[INCOMPLETE]` | terminal | Partial completion | Check `[PIPELINE:check:done] missing_items=…` for the failing criteria |
| `[PLAN]` | interrupt | Plan-mode produced a plan | `respond` approve or revise |
| `[QUESTION]` | interrupt | Backend asked a clarifier | `respond` with the answer |
| `[CONFIRMED]` | interrupt | Echo after a `respond` | Informational |
| `[CHECKPOINT]` | progress | Every ~5 min | Read for "what is Codex doing"; act if drifting |
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

Continuation lines (indented under a header) inherit the header's filter decision, so an included `[CHECKPOINT]` ships with its `assistant:`, `tools:`, and `diff-since-last-checkpoint:` body.

## When Monitor is the wrong tool

- Watching `xcodebuild`, `npm test`, `cargo build`, etc. — those don't write `.events` files. Use `Bash --run-in-background`.
- Polling a file for content — plain shell loop (`until [ -s path ]; do sleep 1; done`).
- Watching N parallel Codex jobs — Monitor is single-job. Use `status --watch` for the fan-in view.

If you see a foreign tail (anything not a codex-bridge `.events` file), Monitor's tag filter will never match and you'll waste the full timeout. Reach for the right tool instead.
