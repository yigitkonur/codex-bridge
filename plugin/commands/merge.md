---
description: Fast-forward merge an approved codex-bridge task back into its base branch
argument-hint: "<task_id> [--no-tests] [--pr]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), Bash(gh:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" merge "$ARGUMENTS"`

The bridge:

1. Reads `~/.codex-bridge/jobs/<task_id>/verdict.json` and refuses unless `verdict === "approved"` and the normalized `branch_head_sha` (or compatibility alias `reviewed_branch_head_sha`) matches the current branch tip. If you have not reviewed the task yet, run `/codex-bridge:iterate <task_id>` or `/codex-bridge:adversarial-review --task <task_id> --json`, then write the approved verdict with `/codex-bridge:verdict <task_id> --payload-stdin`.
2. Reads `~/.codex-bridge/jobs/<task_id>/meta.json` to find the branch (`subagent/codex/<task_id>`) and base ref captured at dispatch time.
3. `git fetch origin <base_ref>`, then `git checkout <base_ref>` (refuses if the working tree is dirty), then `git merge --ff-only <branch>`. If the branch isn't a linear descendant of base, the merge fails and the worktree is left intact — rebase or rerun `/codex-bridge:iterate <task_id>` to refresh.
4. Refuses to prune a dirty task worktree, then on success prunes the clean worktree (`git worktree remove --force` + `git branch -D`) and returns `result.merge.{strategy, commit_sha, base_ref, branch, tests_passed}`.

Present the bridge's stdout verbatim. Do NOT retry through this command after `MERGE_SHA_DRIFT`; rerun review or iterate so the approval is bound to the new branch head.

`--no-tests` skips the future test-gate when meta.json carries an acceptance_criteria.tests_command (currently informational; v1 always records `tests_passed: null`).

`--pr` (push branch + `gh pr create`) is deferred to a follow-up; passing it returns `MERGE_PR_NOT_IMPLEMENTED`.
