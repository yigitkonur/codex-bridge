# Phase 1 — Analysis

| Focus case | Validity | Severity | Core finding |
|---|---|---|---|
| `14.01` runner returns `completed` when it gave up | Real | P0 for documented fan-out workflows; platform-owned in part | The bridge made a native Agent wrapper the canonical dispatch path even though Claude Code labels any non-crashing subagent turn as `completed`; a denied runner or non-terminal monitor wrapper could therefore look like successful work. |

## Problem

The per-issue report describes two variants of the same truth-contract failure:

| Variant | What actually happens | Why the parent is misled |
|---|---|---|
| Runner Bash denial | `codex-bridge:codex-bridge-runner` cannot invoke Bash, returns explanatory prose, and no `task-*` job exists. | Claude Code frames the subagent turn as `completed` because the agent returned text rather than throwing. |
| Monitor wrapper pulses | An Agent wrapper around Monitor returns on `[DIRECTIVES]`, `[CHECKPOINT]`, or "Monitor armed" prose before any terminal event. | Each wrapper return is labeled `completed`, even though the underlying Codex task is still running. |

The precise failure is not that the bridge runtime marks an existing job `completed`; the runtime has queued/running/terminal job state and terminal event tags. The failure is at the orchestration boundary where bridge-owned plugin prose and agent surfaces used native Agent completion as if it meant bridge dispatch/terminal success.

## Root Cause

| Layer | Current architecture | Root cause |
|---|---|---|
| `/codex-bridge:task` command | Routed substantial work through `Agent(subagent_type: "codex-bridge:codex-bridge-runner")`. | The command delegated the initial dispatch to a second LLM turn instead of directly invoking the deterministic CLI. |
| Runner agent | `tools: Bash`; instructions said to return bridge stdout, and if Bash failed, return command output. | No structured fail-fast contract for tool denial; denial prose can end the subagent turn cleanly. |
| SubagentStop hook | Only surfaced terminal events when it could correlate a job id. | If no job id existed, the hook stayed silent, leaving the false native `completed` label uncorrected. |
| Monitor handoff prose | Correctly used `events --follow`, but did not explicitly forbid Agent-wrapping Monitor. | Wrapping Monitor recreates the same native Agent completion ambiguity for non-terminal progress. |

## Is It Real?

Yes. The claim is real for users following the documented/plugin-command path or manually spawning the runner for parallel dispatch. It is slightly overstated as a "protocol-layer" bug inside the bridge runtime: Claude Code owns native task-notification labels, and a Markdown subagent cannot force the UI status to `failed`. The bridge-owned defect is making that unreliable label part of the canonical success path and failing to emit a corrective signal when no bridge job exists.

Severity remains P0 for unattended fan-out because the blast radius is downstream state contamination: later waves can be planned against imaginary job IDs. For a single manual dispatch it behaves more like P1 because the user can inspect the body or run `status --all`.

## Blast Radius

| Who notices | Manifestation | When |
|---|---|---|
| Orchestrators running N parallel tasks | Missing `jobId` values, empty `status --all`, validation gates over imaginary jobs. | Immediately after denied runner fan-out, often after minutes of wasted subagent budget. |
| Users watching Monitor via Agent wrappers | Many completed notifications for non-terminal progress. | During long-running jobs with bootstrap/checkpoint events. |
| Script authors | Need defensive cross-checks against `status --json`. | Any automation that trusts native Agent `completed` as dispatch success. |

## Dependencies / Overlaps

There are no other in-scope focus files. Reference overlaps are:

| Reference | Overlap | Plan treatment |
|---|---|---|
| `04-cli-recovery-and-envelope.md` F18 | Runner determinism and JSON envelope shape. | Address only as needed for runner fail-fast and `/task` direct dispatch. |
| `10` / `12` hook critiques | Platform limits around Agent interception/additionalContext. | Treat as constraint: fix available plugin surfaces, do not claim Claude UI status control. |
| `13` CLI/tool design | Recommends slash-command-driven direct dispatch and parent-thread Monitor. | Adopt only the direct-dispatch/terminal-Monitor piece. |

# Phase 2 — GSD Implementation Plan

## Cluster Map

| Cluster | Shared root cause | Files/modules | Contract fixed | Verification |
|---|---|---|---|---|
| C1 direct dispatch | Canonical `/task` path used fragile Agent runner. | `plugin/commands/task.md`, `skill/SKILL.md` | `/codex-bridge:task` starts the bridge with one Bash call; denied Bash/CLI failure is the task result, not a successful Agent completion. | Static test asserts task command invokes `node ... task`, contains no runner subagent route, and requires terminal-only Monitor. |
| C2 runner compatibility | Legacy runner lacked fail-fast denial semantics and was advertised too broadly. | `plugin/agents/codex-bridge-runner.md` | Runner is compatibility-only, single-dispatch only, returns `BASH_DENIED` JSON immediately on tool denial. | Static test asserts `BASH_DENIED`, one Bash call, and no parallel dispatch language. |
| C3 no-job correction | SubagentStop was silent when no job id was present. | `hooks/subagent-stop.mjs`, `plugin/hooks/subagent-stop.mjs` | Bridge subagent stop with no `task-*`/`review-*` id emits additionalContext telling parent to treat it as failed; denial-shaped text maps to `BASH_DENIED`. | Hook subprocess test feeds denied runner prose and asserts failed/no-dispatch context. |
| C4 terminal Monitor | Monitor could be wrapped in an Agent and return non-terminal pulses as completed. | `hooks/post-tool-bash.mjs`, `hooks/pre-tool-agent.mjs`, plugin hook copies, monitor references | Handoff text says use parent-thread Monitor and do not wrap it in Agent; Monitor remains terminal on `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, `[PLAN]`. | Static and hook tests cover command text; existing PostToolUse safety tests continue to pass. |

## Sequencing

| Wave | Work | Prerequisites | Done when |
|---|---|---|---|
| 1 | Add failing contract tests for direct `/task`, runner denial, and no-job SubagentStop. | Focus analysis complete. | `test/plugin-surfaces.test.mjs` fails on the old surfaces. |
| 2 | Update plugin command/runner docs and SubagentStop root hook. | Wave 1. | Tests pass before generated-copy concerns except plugin hook copy. |
| 3 | Run `npm run build` to copy root hooks to `plugin/hooks/`. | Wave 2. | Packaged hooks match root hook behavior. |
| 4 | Run targeted and full verification. | Wave 3. | `node --test test/plugin-surfaces.test.mjs`, `npm test`, and `npm run build` pass for the touched surfaces. |
| 5 | Fresh-context review, then commit only the focused files. | Wave 4. | Review finds no blocking issue; commit is conventional and excludes unrelated dirty work. |

## Risks + Rollback

| Risk | Why it matters | Mitigation | Rollback |
|---|---|---|---|
| `/task` loses runner context isolation | The runner used a fresh Sonnet context, even though it only forwarded CLI args. | Direct Bash keeps the actual Codex worker isolated; only dispatch logic stays in parent context. | Revert C1 only; C2/C3 still improve legacy runner safety. |
| SubagentStop false-alarms on intentional prose-only bridge agents | Future bridge agents might legitimately return prose without a job id. | Guard only bridge agent types and only emit when there is non-empty subagent output; message says no job id, not terminal failure of a real job. | Remove no-job branch from `subagent-stop.mjs`. |
| Hook generated copies drift | Root hooks are source; plugin hooks are packaged copies. | Run `npm run build` and stage root + plugin hook copies together. | Re-run build from the reverted root hook. |
| Cannot change Claude Code native `completed` label | Platform owns the label. | Avoid the label on canonical path and add corrective context for legacy path. | None inside this repo; broader platform change remains out of scope. |

## Acceptance Criteria

| Case | One-line proof |
|---|---|
| `14.01` runner denial | A denied/blocked bridge runner with no job id produces `BASH_DENIED` or no-dispatch failure context, and `/codex-bridge:task` no longer routes initial dispatch through the runner. |
| `14.01` monitor wrapper pulses | Codex Bridge handoff text instructs parent-thread Monitor only, with terminal completion limited to `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, or `[PLAN]`. |

## Out Of Scope

- Changing Claude Code's native `<task-notification status="completed">` semantics.
- Adding a new `abandoned` job status to bridge runtime state.
- Implementing install-time `~/.claude/settings.json` permission mutation.
- Building a multi-job `/fan-out` command.
- Solving non-focus findings from `00`-`13`, `15`, or the flat `14-real-world-failure-cases.md`.
