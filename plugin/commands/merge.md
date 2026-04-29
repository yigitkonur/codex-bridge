---
description: Fast-forward merge an approved codex-bridge task back into its base branch
argument-hint: "<task_id> [--no-tests] [--pr]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), Bash(gh:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" merge "$ARGUMENTS"`

The bridge:

1. Reads `~/.codex-bridge/jobs/<task_id>/verdict.json` and refuses unless `verdict === "approved"`. If you haven't reviewed the task yet, run `/codex-bridge:review <task_id>` then `/codex-bridge:verdict <task_id> --set approved` first.
2. Reads `~/.codex-bridge/jobs/<task_id>/meta.json` to find the branch (`subagent/codex/<task_id>`) and base ref captured at dispatch time.
3. `git fetch origin <base_ref>`, then `git checkout <base_ref>` (refuses if the working tree is dirty), then `git merge --ff-only <branch>`. If the branch isn't a linear descendant of base, the merge fails and the worktree is left intact — rebase or rerun `/codex-bridge:iterate <task_id>` to refresh.
4. On success, prunes the worktree (`git worktree remove --force` + `git branch -D`) and returns `result.merge.{strategy, commit_sha, base_ref, branch, tests_passed}`.

Present the bridge's stdout verbatim. Do NOT call this command if the verdict isn't already approved — the bridge enforces this, but layering retry logic on top would mask review-loop bypasses.

`--no-tests` skips the future test-gate when meta.json carries an acceptance_criteria.tests_command (currently informational; v1 always records `tests_passed: null`).

`--pr` (push branch + `gh pr create`) is deferred to a follow-up; passing it returns `MERGE_PR_NOT_IMPLEMENTED`.
