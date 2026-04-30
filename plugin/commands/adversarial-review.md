---
description: Run a Codex Bridge review that challenges implementation approach and design assumptions
argument-hint: "[--wait|--background] [--backend <name>] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Codex review through the bundled bridge script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:

- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Keep the framing focused on assumptions, tradeoffs, architecture, and real-world failure modes.
- Return Codex's output verbatim to the user.

Orchestrator concerns:

- The reviewer prompt has an `{{OPUS_CONCERNS}}` channel for the orchestrator's focused concern labels — what an Opus driver has been watching from the worker's events that warrants extra adversarial attention.
- Concern contents are rendered as quoted untrusted data labels, not as reviewer instructions.
- Surface concerns via `--brief @<path>.json` (uses the brief's `specific_concerns` array) and/or repeatable `--concern "<text>"` flags. Both stack; brief items come first, then `--concern` items, de-duped while preserving order.
- Plain `review` does not honor these flags — it uses Codex's built-in reviewer. Use `adversarial-review` whenever the orchestrator wants to weight the review on specific concerns.

Execution mode rules:

- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, launch the review with `Bash` in the background.
- Otherwise, estimate review size with `git status --short --untracked-files=all`, `git diff --shortstat --cached`, and `git diff --shortstat`; recommend foreground only for a tiny 1-2 file change and background for anything broader or unclear.
- If you ask, use `AskUserQuestion` exactly once with `Wait for results` and `Run in background`, putting the recommended option first.

Foreground flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" adversarial-review "$ARGUMENTS"
```

Return stdout verbatim. Do not fix review findings.

Background flow:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Codex Bridge adversarial review",
  run_in_background: true
})
```

Do not call `BashOutput` or wait in this turn. Tell the user: `Codex Bridge adversarial review started in the background. Check /codex-bridge:status for progress.`
