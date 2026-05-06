---
description: Package a Codex Bridge job's forensic artifacts into a tarball
argument-hint: "<task-id> [--output <path>] [--no-include-rollout] [--json]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" bundle $ARGUMENTS
```
