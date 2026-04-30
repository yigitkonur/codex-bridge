# Monitor — Preset A only

The hooks auto-arm Monitor on background dispatches; you almost never derive the invocation by hand. The runtime emits the canonical payload at `result.monitor.tool_hint` and the PostToolUse hook surfaces it as `additionalContext`.

## Preset A — the only pattern that ships in v2.0

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
- `persistent: false` — Monitor self-terminates on `[DONE]`/`[ERROR]`/`[INCOMPLETE]` and shouldn't keep running.

## When Monitor is the wrong tool

- Watching `xcodebuild`, `npm test`, `cargo build`, etc. — those don't write `.events` files. Use `Bash --run-in-background`.
- Polling a file for content — plain shell loop (`until [ -s path ]; do sleep 1; done`).
- Watching N parallel Codex jobs — Monitor is single-job. Use `status --watch` for the fan-in view.

If you see a foreign tail (anything not a codex-bridge `.events` file), Monitor's tag filter will never match and you'll waste the full timeout. Reach for the right tool instead.
