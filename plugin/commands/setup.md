---
description: Check whether local Codex Bridge requirements are ready
argument-hint: "[--install-monitor-hook] [--enforce-sandbox|--disable-sandbox-enforcement] [--enable-review-gate|--disable-review-gate] [--json]"
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Plugin stop-review gate activation is visible and project-scoped:

- `--install-monitor-hook` mirrors the PostToolUse Monitor handoff hook into `~/.claude/settings.json`. Use it when plugin-bundled hook context is not reaching the parent thread.
- `--enforce-sandbox` installs Claude permission-layer deny rules in `~/.claude/settings.json` that block `codex-bridge task --read-only` and direct `codex --sandbox read-only|workspace-write` downgrades. Pair it with `sandbox_enforce: true` in `config.yaml` so the PreToolUse Bash hook also denies `--read-only`.
- `--disable-sandbox-enforcement` removes only Codex Bridge sandbox deny rules from `~/.claude/settings.json`.
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

Sandbox enforcement note: with `sandbox_enforce: true`, disable the stop-time review gate because that gate intentionally invokes Codex in read-only mode.

Output rules:

- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `codex login`.
