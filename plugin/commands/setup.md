---
description: Check whether local Codex Bridge requirements are ready
argument-hint: "[--enable-review-gate|--disable-review-gate] [--json]"
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Plugin stop-review gate activation is visible and project-scoped:

- `--enable-review-gate` creates `.codex-bridge-stop-review-gate.lock` in the git project root.
- `--disable-review-gate` removes `.codex-bridge-stop-review-gate.lock` from the git project root.
- Without that lock file, the Stop hook exits without running Codex, even though the hook file is installed.
- If the official OpenAI Codex plugin is enabled, the bridge refuses to enable its own stop-review gate and reports `reviewGateSuppressedByOfficialPlugin: true`.
- This gate is intentionally project-specific; do not use a global or environment-only activation path.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" setup --json "$ARGUMENTS"
```

The bridge CLI creates or removes the lock file itself. Do not create a second marker file in another directory. If the official OpenAI Codex plugin is enabled, leave stop-time review to that plugin and use this plugin only for `/codex-bridge:*` orchestration.

If the result says Codex is unavailable and npm is available:

- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put `Install Codex (Recommended)` first and `Skip for now` second.
- If the user chooses install, run `npm install -g @openai/codex`, then rerun setup.

If Codex is installed or npm is unavailable, do not ask about installation.

Output rules:

- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `codex login`.
