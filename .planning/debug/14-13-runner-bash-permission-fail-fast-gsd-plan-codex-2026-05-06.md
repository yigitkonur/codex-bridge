# Phase 1 — Analysis

## Focus Case

| Case | Current classification | Validation |
|---|---:|---|
| `14.13 — Runner agent has no Bash permission for its only allowed tool, and doesn't fail-fast on denial` | P1 | Real, but partially mitigated in the current tree. The runner prompt and `SubagentStop` hook now reduce the 150s false-success ambiguity; the missing preapproval for the runner's only Bash command remained real. |

## Problem

The legacy `codex-bridge-runner` subagent is a thin wrapper whose only useful action is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task ...
```

Its frontmatter grants `tools: Bash`, but that only makes Bash available to the subagent. It does not preapprove the concrete command, so Claude Code's Bash permission resolver can still prompt or deny. When this happens during parallel runner dispatch, every runner can fail before creating a bridge job.

The original report also claimed the runner consumes its full turn budget on denial. That was true for the captured transcript, but the current tree already contains two mitigations:

- `plugin/agents/codex-bridge-runner.md` instructs the runner to return a structured `BASH_DENIED` JSON shape immediately.
- `hooks/subagent-stop.mjs` classifies a stopped bridge subagent with no job id and Bash-denial text as `BASH_DENIED`, so the parent gets failure context even if the Agent tool labels the subagent turn completed.

## Root Cause

| Root cause | Evidence | Fix implication |
|---|---|---|
| Tool availability was mistaken for command approval. | Runner frontmatter uses `tools: Bash`; official subagent docs list `tools`, not command-scoped `allowed-tools`. | Do not add unsupported agent frontmatter. Use permissions or hooks. |
| The installed Bash hook did not approve safe bridge task commands. | Before this fix, `plugin/hooks/pre-tool-bash.mjs` reached `pass-through` and emitted `{ "continue": true }` for the bundled runner command. | Return an explicit allow decision after safety gates pass. |
| Runner denial behavior is model-mediated. | Prompt-level fail-fast text helps, but only the platform permission layer can prevent the prompt/denial path. | Keep prompt + `SubagentStop` fail-fast as defense in depth, not as the primary permission fix. |
| Parallel runner dispatch amplifies any permission prompt. | N runners each hit the same permission resolver edge; native Agent completion labels are not a bridge success signal. | Prefer `/codex-bridge:task` / direct Bash for parallel work; runner stays compatibility-only. |

Docs checked on 2026-05-06:

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): subagent frontmatter supports `tools`, `disallowedTools`, `permissionMode`, etc.; no command-scoped `allowed-tools` field is documented.
- [Claude Code permissions](https://code.claude.com/docs/en/permissions): Bash commands require approval unless matched by allow rules or equivalent permission handling.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks): hooks can participate in permission decisions, which is the appropriate local fix surface.

## Is It Real?

Yes, with a severity nuance:

- **Real P1:** a fresh or drifted install can still block the legacy runner before it invokes the bridge.
- **Not P0 in current product direction:** normal `/codex-bridge:task` already bypasses the runner, and the runner is now documented as compatibility-only and not for parallel dispatch.
- **Fail-fast subclaim downgraded:** still worth guarding, but already partially fixed by prompt text and `SubagentStop` classification.

## Blast Radius

| Who notices | Manifestation | Timing |
|---|---|---|
| Orchestrators using `Agent(codex-bridge:codex-bridge-runner)` | Agent returns permission-denial prose/JSON instead of a bridge job envelope. | Immediately at dispatch; worst under N parallel runners. |
| Parallel fan-out workflows | N prompts/denials, no job ids, confusing native Agent completed labels. | First fan-out on a fresh/drifted permission setup. |
| Hook/permission maintainers | Overbroad allow rules could accidentally approve arbitrary Bash. | During fix if matcher is too loose. |

## Dependencies / Overlaps

| Related case | Relationship |
|---|---|
| `14.01 runner returns completed when it gave up` | Protocol consequence of the same no-job runner failure. `SubagentStop` classification mitigates parent context, but does not preapprove Bash. |
| `14.06 monitor not auto-armed` | Shared runner/Agent legacy surface; direct `/codex-bridge:task` is the safer default. |
| `14.09 absolute paths break worktree isolation` | Shares `PreToolUse(Bash)` safety surface; the auto-allow must run only after the absolute-path guard. |
| Destructive diff/worktree safety work | The permission fix must not bypass write-mode isolation denials. |

# Phase 2 — GSD Implementation Plan

## Cluster Map

| Cluster | Cases | Fix surface | Status |
|---|---|---|---|
| Runner Bash preapproval | 14.13 A | `hooks/pre-tool-bash.mjs`, `plugin/hooks/pre-tool-bash.mjs`, `hooks/hooks.json`, `plugin/hooks/hooks.json` | Implemented |
| Runner denial fail-fast | 14.13 B | `plugin/agents/codex-bridge-runner.md`, `hooks/subagent-stop.mjs` | Already partially implemented before this slice; kept as defense in depth |
| Legacy runner guidance | 14.13 D | `plugin/agents/codex-bridge-runner.md`, command/skill docs | Already present: runner is compatibility-only and not for parallel dispatch |

## Sequencing

| Wave | Prerequisite | Work | Verification |
|---|---|---|---|
| 1 — Validate contract | Read focus file and current runner/hook code | Confirm unsupported `allowed-tools` agent fix; choose hook-based allow path | Source inspection + official docs |
| 2 — Add narrow allow | Wave 1 | In `PreToolUse(Bash)`, allow only parsed `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task ...` or the same absolute path under `CLAUDE_PLUGIN_ROOT`, and only after existing safety gates pass | Hook unit tests |
| 3 — Preserve safety denials | Wave 2 | Ensure write-without-worktree, absolute workspace paths, non-bundled paths, compound shell commands, and subshell syntax do not auto-allow | Negative tests |
| 4 — Generated alignment | Wave 2 | Run `npm run build` so packaged hook copies stay aligned | Build output clean |
| 5 — Regression | Wave 3/4 | Run focused tests and full suite | `node --test ...`; `npm test` |

## Per-Cluster Work Items

| Cluster | Files/modules | Behavior change | Contract fixed | Verification |
|---|---|---|---|---|
| Runner Bash preapproval | `hooks/pre-tool-bash.mjs`, `plugin/hooks/pre-tool-bash.mjs` | Safe bundled bridge task commands now return `permissionDecision: "allow"` instead of `{continue:true}`. | The runner's one permitted bridge invocation does not need a user prompt. | `PreToolUse(Bash) auto-approves...` tests. |
| Safety preservation | Same hook files | Auto-allow is skipped for non-bundled paths, unquoted shell control, subshell syntax, and any command blocked by existing safety gates. | Permission fix does not become broad Bash approval. | Negative pre-tool-bash tests. |
| Hook wiring | `hooks/hooks.json`, `plugin/hooks/hooks.json` | Bash PreToolUse hook is installed in both authored and packaged hook configs. | Permission decision code actually runs before Bash permission resolution. | `plugin-surfaces.test.mjs` hook wiring checks. |
| Fail-fast defense | `plugin/agents/codex-bridge-runner.md`, `hooks/subagent-stop.mjs` | Existing prompt-level `BASH_DENIED` and parent-context classifier remain in place. | If approval still fails, the runner should stop fast and parent sees failure context. | Existing runner/subagent-stop tests. |

## Risk + Rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Over-approving arbitrary Bash | Strict parser requires first token `node`, second token bundled bridge path, third token `task`; rejects non-bundled paths and shell control. | Remove the `permissionDecision: "allow"` branch or set `CODEX_BRIDGE_HOOK_DISABLE=pre-tool-bash`. |
| Bypassing worktree safety | Auto-allow is emitted only on the `pass-through` path after write/worktree and absolute-path checks. | Revert hook allow branch; safety denials remain. |
| Platform hook semantics drift | Tests pin emitted shape and hook wiring. | Fall back to explicit user/project `permissions.allow` setup path. |
| Runner still denied by external deny rule | Claude Code deny rules outrank allow behavior. | Expected fail-closed behavior; `SubagentStop` surfaces denial context. |

## Acceptance Criteria

| Case | Acceptance check |
|---|---|
| 14.13 A — no Bash preallow | A PreToolUse payload for `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --json "..."` returns `permissionDecision: "allow"`. |
| 14.13 B — no fail-fast | Runner prompt still contains exact `BASH_DENIED` JSON guidance, and `SubagentStop` flags no-dispatch Bash-denial text as failed context. |
| 14.13 parallel amplification | Runner docs still say not to use this Agent surface for N >= 2; direct `/codex-bridge:task`/Bash remains the parallel path. |
| Safety non-regression | Write tasks without `--worktree-auto`, absolute workspace paths with `--worktree-auto`, non-bundled paths, and compound shell commands do not auto-allow. |

## Out Of Scope

- Replacing Claude Code's native Agent completion label semantics.
- Building `/codex-bridge:fan-out`.
- Installing or mutating user `~/.claude/settings.json` permission rules.
- Solving broader hook additionalContext delivery issues from documents `00-13` or `15`.
- Reworking worktree lifecycle, base-ref defaults, result rendering, or monitor auto-arm beyond the in-scope runner permission path.

## Verification Reached

| Command | Result |
|---|---|
| `npm run build` | Pass |
| `node --test test/pre-tool-bash-hook.test.mjs test/plugin-surfaces.test.mjs` | Pass: 64 passed, 1 skipped |
| `npm test` | Pass: 417 passed, 1 skipped |
