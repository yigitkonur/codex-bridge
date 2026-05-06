# Phase 1 — Analysis

| Case | Validity | Priority | Summary |
|---|---|---:|---|
| `14.09 — Absolute paths in prompts silently break --worktree-auto isolation` | Valid | P0 for write-mode orchestration | `--worktree-auto` moves execution to a sibling git worktree, but prompt absolute paths that point at the launch checkout still resolve to the launch checkout under `danger-full-access`. That silently defeats the isolation contract. |

## Problem

The user asks for isolated work by dispatching `task --write --worktree-auto`, then includes prompt paths like `/Users/me/dev/repo/src/file.ts`. The bridge creates the task worktree at `<parent-of-repo>/.codex-bridge-worktrees/<task_id>`, so that absolute path does not point into the task worktree. With the shipped `danger-full-access` sandbox, Codex can write the absolute path successfully in the main checkout while the task worktree stays unchanged.

## Root Cause

The current architecture treats worktree isolation as an execution `cwd` change plus later git diff/merge workflow. It does not also validate the semantic contract of the prompt. Absolute paths are outside the `cwd` resolution model, and `danger-full-access` intentionally does not constrain them. Existing diff/pipeline logic observes the task worktree, not all filesystem writes the Codex process may have performed.

## Is It Real?

Yes. The claim is not just a documentation gap:

- `src/lib/git.mjs` places worktrees at a sibling root by default.
- `task --worktree-auto` switches execution `cwd` to that sibling worktree.
- `sandbox_policy: danger-full-access` allows writes outside that `cwd`.
- No runtime or active hook rejected absolute workspace paths before this fix.

The P0 label is justified for parallel write-mode orchestration because it can silently pollute the launch checkout and report an empty task worktree diff. It is lower impact for read-only tasks or users already operating inside a manually managed worktree.

## Blast Radius

| Surface | Failure |
|---|---|
| Main checkout | Unexpected created/modified files appear outside the isolated task branch. |
| Task worktree | Diff may be empty or incomplete, so review/merge sees the wrong state. |
| Parallel dispatch | N tasks can all bypass isolation into the same checkout. |
| Orchestrator state | Queued job ids become misleading if the task worktree stays clean while the main checkout changed. |
| Forensics | The bridge records task-worktree diff, not leaked absolute-path writes. |

## Dependencies / Overlaps

| Related item | Relationship |
|---|---|
| `08-P0-cwd-flag-leaky-and-positional.md` | Same contract family: launch cwd/workspace semantics must be parsed before dispatch. |
| `11-P0-base-ref-silently-defaults-to-current-branch.md` | Same worktree trust boundary: users must know which checkout/ref worker state is tied to. |
| `21-P1-worktree-auto-should-be-default-for-write.md` | If write mode later defaults to worktree isolation, this guard must apply to the effective worktree behavior, not only explicit flags. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Cases | Root cause | Fix surface |
|---|---|---|---|
| Worktree prompt path contract | `14.09` | Prompt absolute paths bypass execution `cwd` and target the launch checkout. | Runtime validation in task dispatch plus Claude Bash PreToolUse guard. |
| Operator guidance | `14.09` | Existing docs describe worktree isolation but not prompt path constraints. | CLI help and skill docs. |

## Sequencing

| Wave | Prerequisite | Work |
|---:|---|---|
| 1 | None | Add pure path-conflict detector and formatter in task runtime. |
| 2 | Wave 1 | Invoke detector before adapter resolution, job creation, registry writes, or worktree creation. Include inline prompts, `--prompt-file`, rendered structured brief text, and configured `prompt_footer` text. |
| 3 | Wave 1 | Add Bash PreToolUse guard so Claude Code denies common unsafe dispatches before invoking the bridge. |
| 4 | Waves 2-3 | Update help/docs and generated plugin surfaces. |
| 5 | Waves 2-4 | Run targeted tests, build, full static verification, fresh review, commit, push, and PR. |

## Per-Cluster Work Items

| Cluster | Files/modules | Behavior contract | Verification |
|---|---|---|---|
| Worktree prompt path contract | `src/lib/task-runtime.mjs`, `src/handlers/task.mjs` | `task --write --worktree-auto` rejects prompt content that names absolute paths inside the launch workspace before any job/worktree state is created. Absolute paths outside the workspace are allowed. Workspace roots containing spaces are still recognized. | Unit tests for detector; CLI tests assert exit code 6 with `WORKTREE_ABSOLUTE_PATH_CONFLICT` and empty plugin state. |
| Bash guard | `hooks/pre-tool-bash.mjs`, `hooks/hooks.json`, generated `plugin/hooks/*` | Claude Code Bash invocations of `codex-bridge task --write --worktree-auto` are denied when prompt text or prompt-file content names launch-workspace absolute paths. Missing `--worktree-auto` remains denied for write tasks. | Hook subprocess tests for inline prompt, simple `cd repo && ...` wrapper, `-C`/subdir git-root resolution, prompt-file, outside absolute paths, paths with spaces, and quoted flag text. |
| Operator guidance | `src/commands-meta.mjs`, `skill/SKILL.md`, `plugin/skills/codex-bridge/SKILL.md` | Users are told to use repo-relative paths with worktree-auto. | Help/static surface tests plus generated-output drift check. |

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| False positives on external absolute paths like `/tmp/file` | Detector only rejects paths inside `workspaceRoot` or its realpath aliases. | Revert runtime detector call; hook still provides advisory safety if kept. |
| Missing exotic shell forms in hook parsing | Runtime guard is authoritative; hook only catches common Bash dispatches. | Disable via `CODEX_BRIDGE_HOOK_DISABLE=pre-tool-bash` or remove the hook wiring. |
| Blocking legitimate intentional main-checkout edits | User can drop `--worktree-auto` when intentionally targeting the launch checkout. | Revert the validation call. |

## Acceptance Criteria

| Case | Acceptance check |
|---|---|
| `14.09` | `codex-bridge task --json --write --worktree-auto "edit /path/to/launch/repo/src/file.ts"` exits 6 with `WORKTREE_ABSOLUTE_PATH_CONFLICT` before creating registry/job/worktree state. |
| `14.09` | The same command using `src/file.ts` or `/tmp/outside.txt` is not rejected by this guard. |
| `14.09` | `--prompt-file` and `--brief` content with launch-workspace absolute paths trigger the same rejection. |
| `14.09` | Configured `prompt_footer` content and workspace paths containing spaces trigger the same rejection. |
| `14.09` | Claude Code Bash hook rejects unsafe worktree-auto invocations and includes repo-relative remediation text. |

## Out of Scope

- Changing the default for all `task --write` invocations to imply `--worktree-auto`.
- Redesigning worktree base-ref selection.
- Tracking or recovering arbitrary filesystem writes outside the task worktree after a run.
- Reworking Monitor lifecycle, event truth, result rendering, cancel cleanup, wait primitives, status shape, or other non-focus cases from `00-13`, `15`, or the flat `14-real-world-failure-cases.md`.
