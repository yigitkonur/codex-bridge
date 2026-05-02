---
description: Run a Codex Bridge code review against local git state or a task worktree
argument-hint: "[--wait|--background] [--backend <name>] [--task <task_id>] [--base <ref>] [--scope auto|working-tree|branch] [--json]"
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

Review modes:

- Working-tree mode: pass `--scope working-tree` to review staged, unstaged, and untracked local changes.
- Branch mode: pass `--scope branch` or `--base <ref>` to review the current branch against a base ref.
- Task-bound mode: pass `--task <task_id>` to read the task registry, switch the review cwd to the task worktree, default the scope to `branch`, resolve the reviewed worktree `HEAD`, and persist normalized output to `review.json`.

JSON contract:

- With `--json`, stdout is a bridge envelope whose `result.review_result` contains `schema_version`, `review_kind`, `verdict`, `summary`, `findings`, `next_steps`, `target`, `task_id`, `reviewed_branch_head_sha`, and `raw_output`.
- In task-bound mode, `result.review_result.task_id` is the requested task and `result.review_result.reviewed_branch_head_sha` is the exact task worktree commit reviewed.
- In task-bound mode, `--cwd` is only valid if it points to the same task worktree recorded in `meta.json`.

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
