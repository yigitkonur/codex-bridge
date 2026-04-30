---
description: Run a Codex Bridge code review against local git state
argument-hint: "[--wait|--background] [--backend <name>] [--base <ref>] [--scope auto|working-tree|branch]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Codex review through the bundled bridge script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:

- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode rules:

- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, launch the review with `Bash` in the background.
- Otherwise, estimate review size with `git status --short --untracked-files=all`, `git diff --shortstat --cached`, and `git diff --shortstat`; recommend foreground only for a tiny 1-2 file change and background for anything broader or unclear.
- If you ask, use `AskUserQuestion` exactly once with `Wait for results` and `Run in background`, putting the recommended option first.

Foreground flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" review "$ARGUMENTS"
```

Return stdout verbatim. Do not fix review findings.

Background flow:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" review "$ARGUMENTS"`,
  description: "Codex Bridge review",
  run_in_background: true
})
```

Do not call `BashOutput` or wait in this turn. Tell the user: `Codex Bridge review started in the background. Check /codex-bridge:status for progress.`
