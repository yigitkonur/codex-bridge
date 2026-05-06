# Phase 1 — Analysis

## Case 14.21: `--worktree-auto` should be the default for `--write`

| Field | Analysis |
|---|---|
| Validity | Real P1. The claim is not P0 by itself because it does not directly corrupt data when no write task is launched, but it is a high-leverage safety default for every write task and every parallel orchestration flow. |
| Problem | `task --write` historically allowed Codex to edit the launch checkout unless the caller knew to add `--worktree-auto`. New users and parallel agents had to discover the isolation flag before the first mistake. |
| Root cause | Worktree isolation was modeled as an opt-in flag and taught as an advanced mode. The runtime, help text, skill docs, and Bash hook were not a single contract: the runtime default could be changed independently from the parser, docs, and hook preflight behavior. |
| Current local finding | This working tree already contained a partial default-on implementation in `src/handlers/task.mjs`, but `--no-worktree-auto` was not parsed, help/docs still over-emphasized explicit `--worktree-auto`, and the generated Bash hook copy still denied bare `--write` before rebuild. |
| Blast radius | Any write task can mutate the user's main checkout, inherit branch switches, race another writer, or leave partial edits after cancellation. The most visible failures are concurrent Claude/Codex sessions, background task batches, and branch-sensitive work. |
| User-visible symptom | A user runs `task --write "fix X"` and later discovers edits landed in the main checkout instead of `<repo>/../.codex-bridge-worktrees/<task_id>`. |
| Dependencies | Case 09 absolute path guard must reject launch-checkout absolute paths before worktree creation. Case 10 cancel cleanup must remove bridge-created worktrees by default. Case 16 branch drift is reduced by default isolation but still relevant for non-write/resume/in-place opt-out flows. |
| Challenge / downgrade | The issue is correctly P1, not P0. Default-on reduces dangerous exposure but does not replace review/merge gates, cancel cleanup, or branch assertions. |

## Root Cause Thread

1. CLI boolean parsing accepted `--worktree-auto=false` but not the documented `--no-worktree-auto` opt-out.
2. `handleTask` had to compute one effective isolation decision from explicit true, explicit false, `--write`, `--read-only`, and resume mode.
3. The PreToolUse(Bash) hook had a stale mental model: bare `--write` meant "missing isolation" instead of "runtime default isolation".
4. First-use docs and examples still made isolation look optional by including `--worktree-auto` in canonical write examples.
5. Generated plugin copies (`plugin/hooks/*`, `plugin/scripts/*`, `skill/scripts/*`) must be rebuilt after source changes, otherwise tests exercise stale behavior.

# Phase 2 — GSD Implementation Plan

## Cluster Map

| Cluster | Fix surface | Behavior contract | Verification |
|---|---|---|---|
| CLI isolation decision | `src/lib/args.mjs`, `src/handlers/task.mjs` | `task --write` creates an isolated worktree by default; `--no-worktree-auto` explicitly disables that; thread-only resume never creates a fresh worktree implicitly. | Parser tests, static handler tests, path-guard CLI tests. |
| Hook preflight alignment | `hooks/pre-tool-bash.mjs`, generated `plugin/hooks/pre-tool-bash.mjs` | Bare `task --write` is treated as isolated and can be auto-approved only after absolute path checks; explicit opt-out falls back to normal Bash permission instead of plugin auto-approval. | `test/pre-tool-bash-hook.test.mjs`. |
| User-facing contract | `src/commands-meta.mjs`, `skill/SKILL.md`, `plugin/skills/codex-bridge/SKILL.md`, README, command references | Help and first-use docs teach `--write` as isolated by default and reserve `--no-worktree-auto` for intentional in-place edits. | Help snapshot tests and plugin surface tests. |
| Generated bundle alignment | `npm run build` outputs under `skill/` and `plugin/` | Packaged CLI and hook copies match source runtime behavior. | Build succeeds; tests exercise plugin copies. |

## Sequencing

1. **Wave 1: Runtime contract**
   - Add `--no-<boolean>` support in the shared parser.
   - Keep `effectiveWorktreeAuto = explicit true OR write-mode default, unless explicit false/env opt-out/resume/read-only`.
   - Verify `--no-worktree-auto` maps to `options["worktree-auto"] === false`.

2. **Wave 2: Guardrails**
   - Run absolute path guard whenever `effectiveWorktreeAuto` is true, including bare `--write`.
   - Update guard suggestions from "drop `--worktree-auto`" to "pass `--no-worktree-auto` if in-place edits are intentional".
   - Keep `--brief`, `--intercepted-from`, and `--base-ref` bound to isolated task registry/worktree creation.

3. **Wave 3: Hook behavior**
   - Parse `--no-worktree-auto` in the Bash hook classifier.
   - Treat explicit opt-out as manual permission, not plugin auto-approval and not denial.
   - Preserve auto-approval only for bundled bridge commands that pass safety gates.

4. **Wave 4: Docs and packaging**
   - Update help, skill, plugin skill, README, brief/orchestration examples, and changelog.
   - Run `npm run build` to refresh generated scripts and plugin hooks.

5. **Wave 5: Verification**
   - Run focused tests first.
   - Run full `npm test`.
   - Fresh-context review the diff before declaring done.

## Per-Cluster Work Items

| Cluster | Files/modules touched | Change | Risk / rollback |
|---|---|---|---|
| CLI isolation decision | `src/lib/args.mjs`, `src/handlers/task.mjs` | Add `--no-worktree-auto`; ensure write default remains disabled for resume/read-only/explicit false. | Parser change affects all boolean flags. Roll back by reverting `--no-` parser support and keeping `--worktree-auto=false` only. |
| Hook preflight alignment | `hooks/pre-tool-bash.mjs` | Bare write is checked as isolated; explicit opt-out returns `{"continue":true}` for human/tool permission. | Auto-approval could be too permissive if guard misses prompt text. Covered by prompt-file and absolute path hook tests. |
| User-facing contract | `src/commands-meta.mjs`, `skill/SKILL.md`, `plugin/skills/codex-bridge/SKILL.md`, `skill/references/*`, plugin references, README, CHANGELOG | Reposition `--write` as safe default; remove unnecessary `--worktree-auto` from canonical examples. | Docs could overpromise if worktree creation fails. Runtime fails closed with `WORKTREE_CREATE_FAILED`, so docs remain true. |
| Generated bundle alignment | `skill/scripts/*`, `plugin/scripts/*`, `plugin/hooks/*` via build | Refresh packaged CLI/hook artifacts. | Generated diffs are large; rollback by rebuilding from reverted source. |

## Acceptance Criteria

| Case | Acceptance check |
|---|---|
| 14.21 | `codex-bridge task --write "..."` computes `effectiveWorktreeAuto === true` and creates a task worktree unless the caller passes `--no-worktree-auto`, uses resume/read-only, or the env kill switch disables the default. |
| 14.21 parser | `parseArgs(["--no-worktree-auto"], { booleanOptions: ["worktree-auto"] })` returns `{ "worktree-auto": false }`. |
| 14.21 hook | PreToolUse(Bash) allows/auto-approves bare bundled `task --write` only after default-isolation safety checks, but explicit `--no-worktree-auto` falls back to normal permission flow. |
| 14.21 path guard | Bare `task --write "edit /absolute/path/inside/repo"` fails before job creation with `WORKTREE_ABSOLUTE_PATH_CONFLICT`. |
| 14.21 docs | `task --help` advertises `--worktree-auto|--no-worktree-auto` and states write tasks use per-task worktree isolation by default. |

## Out Of Scope

- New merge UX beyond existing `merge`, `verdict`, and task-bound review flows.
- Broader hook architecture redesign from docs 10-12.
- General event stream truth, Monitor lifecycle, or pipeline timeout cases from other focus files.
- Any additional per-issue files not marked `YOUR FOCUS`.
- Changing sandbox defaults; this plan only changes write-task isolation defaults.
