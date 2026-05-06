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
| Orchestrator state | Queued job ids become unusable if the user cancels and redispatches. |
| Forensics | The bridge records task-worktree diff, not leaked absolute-path writes. |

## Dependencies / Overlaps

| Related item | Relationship |
|---|---|
| `08-P0-cwd-flag-leaky-and-positional.md` | Same contract family: launch cwd/workspace semantics must be parsed before dispatch. |
| `10-P0-cancel-leaves-worktrees-and-branches.md` | Amplifies cleanup cost after the user catches this late and cancels. |
| `21-P1-worktree-auto-should-be-default-for-write.md` | This guard is prerequisite safety if `--worktree-auto` becomes more automatic. |
| Broad event-stream/forensics docs | Overlap only for future external-write detection; not required for the preflight fix. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Root cause | Fix surface | Status |
|---|---|---|---|
| Worktree path preflight | Prompt absolute paths can bypass `cwd` isolation | Runtime task handler, shared path detector, Bash PreToolUse hook, help/docs, tests | Implemented |

## Sequencing

1. Runtime fail-fast before state mutation.
   Verify: `task --json --write --worktree-auto "write /repo/path"` exits validation before job/worktree creation.
2. Hook fail-fast before Claude Bash dispatch.
   Verify: `plugin/hooks/pre-tool-bash.mjs` denies `task --write --worktree-auto` prompts with absolute workspace paths.
3. Documentation/help warning.
   Verify: task help/skill text tells users to use repo-relative prompt paths with `--worktree-auto`.
4. Packaged output rebuild.
   Verify: `plugin/hooks/pre-tool-bash.mjs`, `plugin/hooks/hooks.json`, and bundled scripts contain the guard.

## Work Items

| Work item | Files/modules | Behavior | Contract fixed | Verification |
|---|---|---|---|---|
| Shared path detector | `src/lib/task-runtime.mjs` | Extract absolute POSIX paths from prompt/brief text, normalize line refs/trailing punctuation, and match against workspace root aliases. | Absolute paths inside the launch workspace are recognized before dispatch. | `test/worktree-path-guard.test.mjs` pure detector tests. |
| Runtime guard | `src/handlers/task.mjs` | Reject `--worktree-auto` prompts/briefs containing absolute workspace paths before adapter resolution, worktree creation, or job persistence. Covers inline prompts, `--prompt-file`, and rendered structured briefs. | `--worktree-auto` cannot silently launch a task that targets the main checkout. | CLI validation tests in `test/worktree-path-guard.test.mjs`; asserts no plugin-data state is written before rejection. |
| Bash preflight hook | `hooks/pre-tool-bash.mjs`, `hooks/hooks.json` | Add active PreToolUse(Bash) guard. Continue existing missing-`--worktree-auto` denial and add absolute-path denial. Handles direct bridge commands, bundled script commands, simple `cd repo && ...` wrappers, and prompt files. | Claude slash/Bash dispatch catches the issue before invoking the bridge. | `test/pre-tool-bash-hook.test.mjs`; plugin surface tests. |
| User-facing contract | `src/commands-meta.mjs`, `skill/SKILL.md`, `plugin/skills/codex-bridge/SKILL.md` | Warn that `--worktree-auto` prompts must use repo-relative paths. | Users can learn the path semantics before losing dispatches. | Help/docs surface tests and manual review. |
| Generated surfaces | `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs`, `plugin/hooks/*` | Packaged installs receive the runtime and hook changes. | Source and installable layouts stay aligned. | `npm run build`; targeted tests. |

## Risk + Rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| False positives on absolute paths used only as examples | Only paths inside the workspace root are blocked; `/tmp` and outside paths pass. | Revert runtime guard and hook entry together. |
| Users intentionally target the launch checkout while using `--worktree-auto` | Error tells them to drop `--worktree-auto`; no new override flag added. | Add an explicit override later if real usage appears. |
| Hook parser misses exotic shell syntax | Runtime guard is authoritative and runs on parsed prompt/brief contents. | Disable hook with `CODEX_BRIDGE_HOOK_DISABLE=pre-tool-bash`; runtime guard remains. |
| Symlinked workspace paths | Detector compares workspace root, cwd alias, and realpath aliases. | Expand aliases in detector if a missed symlink pattern is observed. |

## Acceptance Criteria

| Case | Check |
|---|---|
| `14.09` | `codex-bridge task --json --write --worktree-auto "write <workspace-absolute-path>"` exits `6` with `WORKTREE_ABSOLUTE_PATH_CONFLICT` and creates no task/worktree. |
| `14.09` | PreToolUse(Bash) denies the same command before shell execution and tells the user to rewrite paths as repo-relative. |
| `14.09` | `codex-bridge task --write --worktree-auto "inspect /tmp/outside.txt"` is not blocked by the absolute-path guard. |
| `14.09` | `task --help` / skill docs state the repo-relative path contract for `--worktree-auto`. |

## Out of Scope

- Auto-rewriting absolute workspace paths into worktree-relative paths.
- Tracking every filesystem write Codex performs outside the task worktree.
- Changing the default sandbox away from `danger-full-access`.
- Making `--worktree-auto` default for write-mode tasks.
- Fixing other `14-real-world-failure-cases/*` files or the flat `14-real-world-failure-cases.md` summary.
- Broad architecture recommendations from `00–13`, `15`, or non-focus feedback documents.
