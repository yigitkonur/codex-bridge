---
description: Print a merged forensic timeline for a Codex Bridge task
argument-hint: "<task-id> [--format text|json|html] [--since <ts>] [--source events,ndjson,log,worker_err] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" timeline "$ARGUMENTS"
```

Use the default text format for incident review, `--format json` for scripts, and `--format html` when the timeline is long enough to benefit from source filtering.
