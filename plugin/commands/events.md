---
description: Stream a Codex Bridge job or thread events file
argument-hint: "<job-id-or-thread-id> [--follow] [--filter <tags> | --exclude <tags>] [--timeout-ms <ms>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Monitor
---

For a live background job, prefer the Monitor tool when the user wants progress in the main thread:

```json
{
  "description": "codex-bridge task events",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs\" events <job-id-or-thread-id> --follow --exclude HEARTBEAT,DIRECTIVES,CHECKPOINT --timeout-ms 1800000",
  "timeout_ms": 3600000,
  "persistent": false
}
```

Otherwise run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" events "$ARGUMENTS"
```

Do not fabricate completion while the stream is running. Treat `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, `[PLAN]`, and `[CANCELLED]` as terminal tags.
