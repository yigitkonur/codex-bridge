# Phase 1 — Analysis

| Focus case | Validity | Priority | Decision |
|---|---:|---:|---|
| `14-real-world-failure-cases/16-P1-branch-switched-mid-session.md` | Real, with one boundary caveat | P1 retained | Fix bridge-owned exposure; do not claim to prevent external/manual branch switches. |

| Dimension | Analysis |
|---|---|
| Problem | A bridge task or follow-up can start from one checkout branch and later operate, review, or report against another branch if the shared working tree branch changes underneath the orchestrator. Without a guard or event, operations appear successful while using the wrong baseline. |
| Root cause | The main checkout is shared mutable state. Pre-fix, write-mode bridge tasks could run directly in that checkout, `send` had no branch precondition, and task/pipeline logging did not sample branch movement. External causes such as another Claude Code session, manual `git checkout`, or harness shell behavior are outside bridge control, but the bridge amplified the hazard by depending on the shared checkout for writes and by staying silent when the branch moved. |
| Is it real? | Yes. Two independent reports saw the same symptom shape. It is not a pure bridge bug, and the critique overstates what bridge can prevent for Claude Code `Edit` tool calls made outside bridge. The bridge can still reduce the blast radius for its own write tasks and make branch drift observable. |
| Blast radius | Highest for multi-round work where `task --write`, `send`, manual edits, review, and pipeline fix/check stages all assume one branch. Users notice when expected files vanish, diffs show unexpected content, reviews miss earlier edits, or merge/review artifacts bind to an unintended baseline. |
| Dependencies / overlaps | Overlaps with the sibling current-branch ambiguity and write-isolation findings, but this plan only consumes those ideas as mitigations. Absolute-path prompt leakage is a dependency for full worktree isolation, but this plan only preserves/uses the existing absolute-path guard rather than broadening that case. |

Validated contract:

| Contract | Required behavior |
|---|---|
| Write isolation | `task --write` should not touch the launch checkout by default. |
| Branch precondition | `task --on-branch <name>` and `send --on-branch <name>` should fail before dispatch if the checkout is not on `<name>`. |
| Branch telemetry | If bridge observes the task cwd branch change during execution or pipeline stages, it should emit a non-terminal `[BRANCH_SWITCHED]` event and matching NDJSON. |
| Scope boundary | Manual Claude Code `Edit` operations outside bridge remain outside bridge enforcement; the bridge can only document the hazard and surface its own observations. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Root cause / fix surface | Files/modules likely touched | Behavior fixed | Verification |
|---|---|---|---|---|
| C1 — Default write isolation | Raw `task --write` depended on the main checkout unless `--worktree-auto` was explicit. | `src/handlers/task.mjs`, `hooks/pre-tool-bash.mjs`, `src/commands-meta.mjs`, `plugin/commands/task.md`, `skill/SKILL.md`, command reference, hook tests | `--write` creates/uses a per-task worktree by default; `--no-worktree-auto` / `--worktree-auto=false` / env opt-out are explicit in-place escape hatches. | Hook tests, task help tests, build-generated plugin hook parity. |
| C2 — Branch launch assertion | Orchestrators had no fail-fast way to bind dispatch to the expected branch. | `src/lib/git.mjs`, `src/handlers/task.mjs`, `src/commands-meta.mjs`, `plugin/commands/send.md`, command reference, CLI surface tests | `--on-branch` rejects mismatched launch checkout with `BRANCH_MISMATCH` before Codex dispatch. | CLI test creates `main`, checks out `feature`, then verifies `task --on-branch main --json` fails with `BRANCH_MISMATCH`. |
| C3 — Branch movement telemetry | Branch drift during execution/pipeline was silent. | `src/lib/session-log.mjs`, `src/lib/task-runtime.mjs`, `src/adapters/codex/pipeline.mjs`, `src/handlers/task.mjs`, notification docs, runtime/session tests | Branch samples at task start, after execute, and around pipeline stages; detected movement logs `[BRANCH_SWITCHED]` and NDJSON. `send` also samples before/after follow-up. | Unit test for formatter; runtime test checks out another branch inside fake Codex turn and asserts event + NDJSON. |
| C4 — Operator guidance | Users needed the operational meaning of new guardrails. | `skill/SKILL.md`, `plugin/skills/codex-bridge/SKILL.md`, `skill/references/notification-format.md`, plugin notification reference, command reference | Docs explain default isolation, `--on-branch`, and `[BRANCH_SWITCHED]` response. | Static doc/help tests and manual grep for stale command hints. |

## Sequencing

| Wave | Work | Prerequisites | Done when |
|---:|---|---|---|
| 0 | Read focus file and relevant code contracts. | None | Root cause is bounded to bridge-owned mitigations vs external branch mutation. |
| 1 | Make write-mode isolation default while preserving explicit opt-out. | Existing worktree machinery and absolute-path guard. | `task --write` routes through worktree path without requiring explicit `--worktree-auto`. |
| 2 | Add branch assertion plumbing for `task` and `send`. | C1 request construction must preserve state cwd. | Mismatch fails before dispatch; help/docs expose flag. |
| 3 | Add branch telemetry samples and event rendering. | Session log available after turn; pipeline accepts callback. | Event appears when branch changes after execute or around pipeline stages. |
| 4 | Update docs, slash-command hints, generated plugin artifacts. | C1-C3 API names stable. | `npm run build` updates generated runtime/hook copies. |
| 5 | Verify and review. | Build completes. | Focused tests and full `npm test` pass, or failures are classified as unrelated/pre-existing. |

## Risk And Rollback

| Risk | Impact | Mitigation / rollback |
|---|---|---|
| Users relying on in-place `task --write` edits | Behavioral change; work lands in bridge worktree instead of launch checkout. | Explicit `--no-worktree-auto`, `--worktree-auto=false`, or `CODEX_BRIDGE_DISABLE_WORKTREE_AUTO=1`. |
| Non-git cwd or detached HEAD | Branch assertions and telemetry depend on git branch names. | `--on-branch` deliberately fails outside git; telemetry is best-effort and non-fatal. Detached HEAD reports `HEAD` through current helper. |
| Pipeline overhead | Extra git branch samples around stages. | Samples are cheap, best-effort, and swallowed on failure. |
| Event consumers with closed tag filters | New tag might be missed by consumers using inclusion filters. | Docs reinforce default `--exclude HEARTBEAT` and forward-compatible pass-through. |

## Acceptance Criteria

| Case | Check |
|---|---|
| 14.16 | A fake Codex turn that switches `main -> feature` emits `[BRANCH_SWITCHED]` with `before`, `after`, `detected_at`, and matching NDJSON. |
| 14.16 | `codex-bridge task --cwd <repo-on-feature> --on-branch main --json "noop"` exits with `BRANCH_MISMATCH` before dispatch. |
| 14.16 | `task --help` and `send --help` advertise `--on-branch <name>`. |
| 14.16 | `task --write` is documented and hooked as isolated by default, with explicit opt-out for in-place edits. |

## Out Of Scope

- Preventing branch switches caused by external terminals, other Claude Code sessions, or manual `git checkout`.
- Enforcing branch state for Claude Code `Edit` calls made outside codex-bridge.
- Redesigning the full hook architecture from documents `10-13`.
- Solving unrelated lifecycle, event-stream, CLI envelope, scalability, status, or dispatch failures from non-focus documents.
- Changing merge semantics beyond preserving existing task-bound review/merge safety surfaces.
