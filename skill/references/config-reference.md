# Configuration Reference

## Config file resolution

Bridge config is layered. Each layer overrides the one above it (lowest → highest):

1. **Built-in defaults** — hardcoded in `src/lib/config.mjs::DEFAULT_CONFIG`. Used when nothing else exists.
2. **Skill config** — `${CLAUDE_SKILL_DIR}/config.yaml`, e.g. `~/.claude/skills/codex-bridge/config.yaml` for a global install. This is the file that ships with the skill bundle; edit it to change defaults for every project.
3. **Workspace-root override** — `$(git rev-parse --show-toplevel)/config.yaml` (the project's repo root). Useful when one repo needs different settings than your global skill config and you want the setting to apply regardless of which subdirectory you run the command from.
4. **cwd override** — `$(pwd)/config.yaml`, where `pwd` is the cwd passed to the command (via `-C` flag or the default process cwd). Wins last. Useful for running the same command against different configs by `cd`-ing into different dirs.

If any file is missing or malformed, that layer is skipped silently — the next layer's values apply. The system never crashes on config errors.

**Workspace-root + cwd overrides are new (2026-04-18, v1.1.0 added cwd override, v1.1.1 adds the workspace-root layer).** Before v1.1.0, only the skill config was read; a `config.yaml` sitting next to your project was silently ignored. See `unexpected-bridge-observations/07-cwd-config-yaml-is-ignored.md` for the original derailment.

**Quick check**: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs config show` prints the effective merged config plus which of the four source files actually exist. `*` marks keys that differ from `DEFAULT_CONFIG`. Use `--json` for programmatic consumption. This is the authoritative answer to "why isn't my config taking effect?"

## Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | string | `"plan"` | Collaboration mode: `"plan"` (plan first) or `"default"` (execute directly) |
| `model` | string | `"gpt-5.4"` | Default model. Inherited from Codex user config if not set. |
| `effort` | string | `"high"` | Execution reasoning effort. Plan mode always uses `"xhigh"` regardless. |
| `auto_review` | boolean | `true` | Run automatic review after task execution completes |
| `post_task_prompt` | string | (see below) | Completion check prompt. Empty string disables it. |
| `prompt_footer` | string | (see below) | Text appended to every prompt. Used to instruct Codex to use `requestUserInput` tool for questions. |
| `allow_questions` | boolean | `true` | Allow Codex to ask questions in Default mode. Always enabled in Plan mode. |
| `session_dir` | string | `"~/.codex-bridge/sessions"` | Where session logs are stored. `~` expands to home directory. |
| `sandbox_policy` | string | `"danger-full-access"` | Sandbox profile. One of `"danger-full-access"`, `"workspace-write"`, `"read-only"`. See below. |
| `skip_meta_skills` | boolean | `true` | Prepend a directive telling Codex to skip its internal planning/ceremony skills (`using-superpowers`, `brainstorming`, `writing-plans`, `using-git-worktrees`). See below. |
| `command_failure_circuit_breaker` | boolean | `true` | Emit `[WARNING]` after 3 consecutive same-family command failures (osascript, open -a, display dialog, computer-use, AppleScript). See below. |

### `skip_meta_skills`

Codex ships with opinionated meta-skills that, by default, run before execution: `using-superpowers`, `brainstorming`, `writing-plans`, `using-git-worktrees`. When the bridge is already orchestrating — the orchestrator has decided the plan, the workspace, and the intent — those skills routinely burn ~10 minutes producing spec and plan files under `docs/superpowers/` that aren't part of the deliverable.

With `skip_meta_skills: true` (shipped default), every prompt is prefixed with an `[ORCHESTRATOR DIRECTIVE]` line instructing Codex to execute directly and not to create those files. This is **advisory** — Codex can still invoke the skills — but in practice it cuts the ceremony overhead sharply. Set to `false` if you want Codex's full default behavior (e.g. when running without an orchestrator).

### `command_failure_circuit_breaker`

When Codex's ReAct loop attempts a command family that is structurally unavailable (e.g. `osascript` on a headless box, `display dialog` without a GUI, `computer-use/get_app_state` in a sandboxed env), it doesn't converge — each failure generates a new variant. The observed worst case is 24 consecutive attempts over 3 minutes before external intervention.

With this flag on (shipped default), the bridge counts consecutive failures of the same command family from `item.type === "commandExecution"` completions. After **3** consecutive failures, it writes a `[WARNING]` event to `.events` with:

```
[WARNING] <threadId> command-family-circuit-breaker-tripped
  family: osascript
  threshold: 3 consecutive failures
  sample: /bin/zsh -lc "osascript -e 'tell application …'"
  turnInterrupted: no
```

Monitored families: `osascript`, `applescript-dialog`, `applescript-system`, `open-app`, `computer-use`. A successful command **resets** the counter (consecutive means consecutive). Unmonitored-family failures are ignored so a failing `npm test` between probes does not shield the breaker.

The current implementation logs only — it does not auto-interrupt the turn. An orchestrator tailing `.events` via Monitor can catch the warning and decide to `cancel <jobId>` or `steer <tid> <turn-id> "environment is headless, move on"`. Auto-interrupt would require a new `onTurnReady(turnId)` hook from `codex.mjs` and is tracked as an enhancement candidate in `07-orchestration/07-circuit-breaker-trips-on-repeated-family.md`.

### `sandbox_policy`

The shipped default is **`"danger-full-access"`** — no sandbox, no permission blocker. This mirrors `codex --dangerously-bypass-approvals-and-sandbox` and lets Codex commit its own work without hitting raw POSIX errors on `.git/` writes. The pre-v1.2.0 default of `workspace-write` routinely caused Codex to misinterpret sandbox denials as puzzles to solve (e.g. attempting `osascript` to reach a human-operated Terminal).

Opt into a stricter profile by editing `config.yaml`:

| Value | Behavior |
|---|---|
| `"danger-full-access"` | Upstream `SandboxPolicy::DangerFullAccess`. No filesystem or network restriction. **Shipped default.** |
| `"workspace-write"` | Writes allowed inside cwd only. `.git/` blocked. Fine for pure-edit tasks that don't commit. |
| `"read-only"` | No writes. Useful for analysis-only runs. |

The setting applies to `task` and `send` turns and to the auto-pipeline's **fix** stage. The **completion-check** stage stays `read-only` regardless, because the check must not mutate the workspace while evaluating it.

Unknown values silently fall back to the mode-derived default (`plan → read-only`, `default → workspace-write`). A typo cannot widen permissions beyond the mode-derived floor.

## Default post_task_prompt

```
Review your own work critically:
1. Is this task 100% complete?
2. Are there any edge cases you missed?
3. Did you run all relevant tests?
List any unfinished items.
```

The completion check uses structured output (JSON schema) to get a binary `complete: true/false` result with specific `missing_items`.

## Examples

### Minimal (plan mode, auto-review, all defaults)
```yaml
codex_bridge:
  mode: "plan"
```

### Skip planning (direct execution)
```yaml
codex_bridge:
  mode: "default"
```

### No auto-review, no completion check
```yaml
codex_bridge:
  auto_review: false
  post_task_prompt: ""
```

### Custom completion check
```yaml
codex_bridge:
  post_task_prompt: |
    Verify:
    1. All functions have JSDoc comments
    2. No console.log statements remain
    3. TypeScript strict mode passes
    Report any violations.
```

## Resetting to Defaults

Delete `config.yaml`. Hardcoded defaults in the script take over.
