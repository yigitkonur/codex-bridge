# Phase 1 — Analysis

| Case | Validity | Severity | Decision |
|---|---|---:|---|
| `14.11` — `base_ref` silently defaults to current branch | Real defect | P0 for fan-out dispatch, P1 for single-task dispatch | Fix the explicit control and visibility gap; do not flip the default branch policy in this patch. |

## What The Problem Actually Is

`task --write --worktree-auto` creates an isolated git worktree from a base ref, but the public `task` command has no `--base-ref` option. The low-level worktree helper already accepts `baseRef`; the task handler never parses or forwards it. When the caller omits a base, `createSubagentWorktree` resolves the base from the caller's current branch and records that as `worktree.base_ref`.

The failure mode is not that the stored `base_ref` is hidden forever; the JSON launch/status metadata does include it after dispatch. The real defect is that the base choice is not controllable at dispatch time and is not visible enough in the human launch path. In a fan-out workflow, one stale current branch silently becomes the base for every worker.

## Root Cause

The current architecture splits worktree behavior across two layers:

| Layer | Current behavior | Root-cause contribution |
|---|---|---|
| `src/lib/git.mjs#createSubagentWorktree` | Supports `baseRef`; otherwise resolves `currentBranch !== "HEAD" ? currentBranch : detectDefaultBranch(...)`. | The helper has the needed override seam but no source metadata explaining whether the value came from CLI/default/current. |
| `src/handlers/task.mjs#handleTask` | Parses many task flags, but not `base-ref`; calls `createSubagentWorktree` without `baseRef`. | Public CLI cannot express the user's intended base. |
| `src/commands-meta.mjs` and docs | `task --help` and skill references omit any base-ref flag. | Orchestrators cannot discover the capability. |
| Background launch rendering | Prints job id/status only. | Human-mode dispatch does not make the chosen base obvious. |

## Is It A Real Problem?

Yes. The core claim is valid: a caller cannot explicitly choose `main`, `refs/heads/main`, a SHA, or `current` through `task`, even though the underlying helper can do it. The report's P0 label is justified for multi-agent fan-out because the same wrong default propagates to N worktrees and recovery requires cancel/re-dispatch. For a single task it is not P0: the blast radius is one worker and the metadata can be inspected after launch.

The report overreaches on changing the default to `main`. That would be a breaking behavioral change for users who intentionally dispatch from topic branches to preserve local context. The safer first fix is explicit override plus source metadata. A default policy/config migration can follow once there is usage data and a compatibility story.

## Blast Radius

| Who notices | When it manifests | Impact |
|---|---|---|
| Orchestrators dispatching parallel workers | After launch, when reading envelopes/status or when workers reason against the wrong baseline | N cancelled jobs, duplicate token spend, cleanup/re-dispatch overhead |
| Solo users on feature branches | When the worker's diff/review is based on feature-branch state | One wrong worktree; lower recovery cost |
| Merge/review flow | Later, if `meta.worktree.base_ref` points to an unintended branch | Review/merge targets the wrong lineage |

## Dependencies And Overlaps

| Overlap | Relationship | Sequencing |
|---|---|---|
| `09-P0-absolute-paths-break-worktree-isolation.md` | Same class: implicit worktree contract mismatch discovered after dispatch. | Independent; do not derive work from it here. |
| `16-P1-branch-switched-mid-session.md` | Same theme: orchestrator branch state is non-obvious. | Independent; base-ref flag helps but does not solve mid-session branch drift. |
| Broader warning/config proposals in docs `00-13`, `15` | Related product design, not required to close this focus case. | Leave out of this patch to avoid changing default semantics. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Root cause | Fix surface | Status |
|---|---|---|---|
| C1 — Explicit base-ref contract | Handler does not parse/pass the existing helper override. | `src/handlers/task.mjs`, `src/lib/git.mjs`, `src/commands-meta.mjs`, docs/tests, generated bundles. | Implement now |
| C2 — Dispatch visibility | Human launch text does not surface chosen base; JSON lacks source metadata. | `src/lib/git.mjs`, `src/lib/task-runtime.mjs`, registry metadata. | Implement now |
| C3 — Warning/default policy | Current-branch default may be risky in fan-out. | Future config/risk classifier/prompting. | Out of scope |

## Sequencing

| Wave | Work | Prerequisite | Verify |
|---|---|---|---|
| 1 | Add tests for helper source metadata, `current` shortcut, handler flag wiring, and task help. | None | Red tests prove the missing contract. |
| 2 | Add `--base-ref <ref>` parsing and validation; pass it to `createSubagentWorktree`. | Wave 1 | Static handler test passes; help advertises flag. |
| 3 | Resolve `baseRef: "current"` to the active branch, record `base_ref_source`, and preserve existing implicit-current default. | Wave 2 | Worktree tests prove `feature`, `main`, explicit refs, and `current`. |
| 4 | Surface base in background launch text and registry metadata; update docs/skill references. | Wave 3 | Help/docs tests and bundled help output show the contract. |
| 5 | Run `npm run build`, targeted tests, and full suite where possible. | Waves 1-4 | Generated plugin/skill scripts include source changes. |

## Per-Cluster Work Items

| Cluster | Files/modules | Behavior change | Contract fixed | Verification |
|---|---|---|---|---|
| C1 | `src/handlers/task.mjs`, `src/commands-meta.mjs` | `task` accepts `--base-ref <ref>` and rejects empty values. | Users can choose a worktree base before dispatch. | Static handler test; `task --help` output. |
| C1 | `src/lib/git.mjs` | `baseRef: "current"` resolves to the checked-out branch; any other non-empty value is passed to git as a ref/sha. | `main`, `refs/heads/main`, SHAs, branch names, and `current` are valid public inputs. | `test/git-worktree.test.mjs`. |
| C2 | `src/lib/git.mjs`, `src/handlers/task.mjs` | Worktree metadata includes `base_ref_source` (`cli-flag`, `current-branch`, `default-branch`). | Orchestrators can distinguish explicit intent from inherited branch state. | Worktree tests; registry metadata inspection by existing consumers. |
| C2 | `src/lib/task-runtime.mjs` | Background human launch text prints `Worktree base: <ref> (<source>)`. | Non-JSON users see the chosen base at dispatch time. | Render path covered by smoke/help checks; manual output inspection. |
| C2 | `skill/SKILL.md`, `plugin/skills/codex-bridge/SKILL.md`, `skill/references/command-reference.md`, `plugin/commands/task.md` | Docs teach `--base-ref` alongside `--worktree-auto`. | Discoverability gap closes. | Plugin surface/help tests; generated bundle check. |

## Risk And Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Changing default base to `main` would break users who intentionally dispatch from a feature branch. | Preserve existing implicit-current behavior; add explicit override. | Revert handler/docs metadata changes only; helper remains backward compatible if `baseRef` omitted. |
| `current` could be a real branch name. | Treat bare `current` as the documented shortcut; users can still pass `refs/heads/current` for a branch literally named `current`. | Remove the shortcut branch in `resolveSubagentBaseRef`. |
| New launch text could affect scripts scraping human output. | JSON envelope remains the machine contract; the added line is human-only. | Revert `renderQueuedTaskLaunch` line addition. |
| Full suite can be noisy while other agents have dirty in-flight changes. | Verify the focused contract with targeted tests and report unrelated suite failures separately. | Re-run full suite after concurrent changes land. |

## Acceptance Criteria

| Case | Check |
|---|---|
| `14.11` | `task --help` shows `--base-ref <ref>`, and `task --worktree-auto --base-ref main` passes `baseRef: "main"` into worktree creation. |
| `14.11` | `createSubagentWorktree({ baseRef: "current" })` records the active branch as `base_ref` and `base_ref_source: "cli-flag"`. |
| `14.11` | Omitting `--base-ref` preserves the existing current-branch default and records `base_ref_source: "current-branch"`. |
| `14.11` | Background launch metadata/rendering exposes the resolved base before the worker does useful work. |

## Out Of Scope

- Changing the default from current branch to repository default branch.
- Adding a workspace config key such as `worktree.default_base_ref`.
- Interactive pre-flight prompts or `permissionDecision: "ask"` behavior.
- Risk classification for unpushed commits, dirty worktrees, or non-default branches.
- Any work derived only from docs `00-13`, `15`, the flat `14-real-world-failure-cases.md`, or non-focus issue files.
