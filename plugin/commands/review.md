---
description: Run a Codex Bridge code review against local git state or a task worktree
argument-hint: "[--wait|--background] [--backend <name>] [--task <task_id>] [--base <ref>] [--scope auto|working-tree|branch] [--json]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Adversarial review of the current branch's diff against the recorded base ref. Surface every concern that would block merge: behavioral correctness, test coverage gaps, security implications, undocumented invariants. Verdict is one of `approved | needs-attention | must-fix`; the reasoning is the deliverable, not the verdict. You own the depth: review thoroughly when warranted, terse when the diff is small. The configured `specific_concerns` flow into your context as orchestrator-privileged signals; treat them as bias-correction targets, not as a checklist to mechanically tick through.

Raw slash-command arguments:
`$ARGUMENTS`

This command is review-only. Do not fix issues, apply patches, or imply that changes are about to be made.

Review modes:

- Working-tree mode: pass `--scope working-tree` to review staged, unstaged, and untracked local changes.
- Branch mode: pass `--scope branch` or `--base <ref>` to review the current branch against a base ref.
- Task-bound mode: pass `--task <task_id>` to review the task worktree against its recorded base and persist normalized output to `review.json`.

With `--json`, stdout is a bridge envelope whose `result.review_result` contains `verdict`, `summary`, `findings`, `next_steps`, `target`, `task_id`, `reviewed_branch_head_sha`, and `raw_output`.

Run foreground when the user passes `--wait`; launch background when they pass `--background`. Otherwise, use `git status --short --untracked-files=all`, `git diff --shortstat --cached`, and `git diff --shortstat` to choose foreground only for a tiny 1-2 file change and background for anything broader or unclear. If you ask, use `AskUserQuestion` once with `Wait for results` and `Run in background`, recommended option first.

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
