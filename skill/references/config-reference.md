# Configuration Reference

## Config file resolution

Bridge config is layered. Each layer overrides the one above it (lowest → highest):

1. **Built-in defaults** — hardcoded in `src/lib/config.mjs::DEFAULT_CONFIG`. Used when nothing else exists.
2. **Skill config** — `${CLAUDE_SKILL_DIR}/config.yaml`, e.g. `~/.claude/skills/codex-bridge/config.yaml` for a global install. This is the file that ships with the skill bundle; edit it to change defaults for every project.
3. **Workspace-root override** — `$(git rev-parse --show-toplevel)/config.yaml` (the project's repo root). Useful when one repo needs different settings than your global skill config and you want the setting to apply regardless of which subdirectory you run the command from.
4. **cwd override** — `$(pwd)/config.yaml`, where `pwd` is the cwd passed to the command (via `-C` flag or the default process cwd). Wins last. Useful for running the same command against different configs by `cd`-ing into different dirs.

If any file is missing or malformed, that layer is skipped silently — the next layer's values apply. The system never crashes on config errors.

All four layers are honored. Before 1.1.0, only the skill config layer was read — a `config.yaml` sitting next to your project was silently ignored. See `unexpected-bridge-observations/07-cwd-config-yaml-is-ignored.md` for the original derailment.

**Quick check**: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs config show` prints the effective merged config plus which of the four source files actually exist. `*` marks keys that differ from `DEFAULT_CONFIG`. Use `--json` for programmatic consumption. This is the authoritative answer to "why isn't my config taking effect?"

## Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | string | `"plan"` | Collaboration mode: `"plan"` (plan first) or `"default"` (execute directly) |
| `model` | string | `"gpt-5.4"` | Default model. Inherited from Codex user config if not set. |
| `effort` | string | `"xhigh"` | Execution reasoning effort. Plan mode always uses `"xhigh"` regardless. Shipped default raised from `"high"` to `"xhigh"` in 1.3.0 — live delegations consistently benefited from xhigh; set to `"high"` (or lower) or pass `--effort high` for cheaper turns. |
| `auto_review` | boolean | `true` | Run automatic review after task execution completes |
| `post_task_prompt` | string | (see below) | Completion check prompt. Empty string disables it. |
| `prompt_footer` | string | (see below) | Text appended to every prompt. Used to instruct Codex to use `requestUserInput` tool for questions. |
| `allow_questions` | boolean | `true` | **Documented contract, not currently enforced.** Intended to let callers disable `requestUserInput` in default mode; today no code path reads this key and the `prompt_footer` (which steers Codex toward `requestUserInput`) is emitted unconditionally. Either set `prompt_footer: ""` to drop the steering line, or treat this key as reserved until a future release wires it. |
| `session_dir` | string | `"~/.codex-bridge/sessions"` | Where session logs are stored. `~` expands to home directory. Also the canonical path to `tail -f` directly when the bridge CLI is misbehaving. |
| `sandbox_policy` | string | `"danger-full-access"` | Sandbox profile. One of `"danger-full-access"`, `"workspace-write"`, `"read-only"`. See below. |
| `skip_meta_skills` | boolean | `true` | Prepend an `[ORCHESTRATOR DIRECTIVE]` telling Codex to skip any internal planning / ceremony / meta-skill chain before execution (framework-agnostic — any chain that produces scaffold docs under `docs/`, `plans/`, `specs/`, etc.). See below. |
| `command_failure_circuit_breaker` | boolean | `true` | Emit `[WARNING]` when 3 of the last 5 same-family command executions fail (with wrapper-pattern detection). See below. |
| `idle_timeout_ms` | integer | `300000` | No-event idle watchdog: max wall-clock gap between app-server notifications before a turn is failed with `ClientTimeout`. CLI override: `--idle-timeout-ms`. |
| `turn_plan_ms` | integer | `1800000` | Per-turn timeout for plan turns. Raised to 30 min in 1.3.0 — matches `turn_default_ms`; pre-1.3.0 the plan budget was 5 min (300 000 ms) and routinely killed live plans mid-reasoning. CLI override: `--turn-plan-ms` (task) / `--turn-timeout-ms` (send when `--mode plan`). |
| `turn_default_ms` | integer | `1800000` | Per-turn timeout for execute turns (also covers send turns in default mode). Raised to 30 min in 1.3.0 — pre-1.3.0 was 600 000 ms (10 min), and interrupted multi-file ports that were still actively writing. CLI override: `--turn-default-ms` (task) / `--turn-timeout-ms` (send). |
| `pipeline_stage_ms` | integer | `300000` | Per-stage timeout for auto-pipeline (review / fix / check). CLI override: `--pipeline-stage-timeout-ms`. |
| `pipeline_total_ms` | integer | `900000` | Total auto-pipeline timeout across all stages. CLI override: `--pipeline-total-timeout-ms`. |
| `question_answer_ms` | integer | `300000` | How long `requestUserInput` waits for a response before logging `QUESTION_TIMEOUT` and replying to the upstream server request with `result: { answers: {} }` (an empty-answer success response, not a rejection — see `src/codex-bridge.mjs:2197`). CLI override: `--question-timeout-ms`. |

Resolution order for every timeout: CLI flag → `config.yaml` key → built-in default.

## Validation and error handling

`loadConfig` does not schema-validate YAML layers. Wrong types and typos survive the merge; behavior depends on where the value is read:

1. **YAML parse failure** (file unreadable, malformed syntax) → the whole layer is dropped silently and the next layer takes over.
2. **Malformed `*_ms` key in `config.yaml`** (e.g. `turn_plan_ms: "30m"`, `idle_timeout_ms: 0`, `pipeline_stage_ms: -1`) → each read site uses `Number(config.<key>) > 0 ? … : <default>` and silently reverts to the **built-in default** (not the layer below). This is deliberately different from the CLI-flag contract below — a typo in `config.yaml` will not raise an error.
3. **Malformed CLI flag** (`--turn-plan-ms abc`, `--idle-timeout-ms 0`) → `parsePositiveMsOption` throws `USAGE_ERROR` (exit 2). Callers notice typos immediately.
4. **Malformed `sandbox_policy`** → silently falls back to the mode-derived default (`plan → read-only`, `default → workspace-write`). Documented under `sandbox_policy` below.
5. **Malformed `effort`, `mode`, or any other string/boolean key** → **no validation** in `loadConfig`. The raw value is forwarded to the downstream consumer. A bad `effort:` in config.yaml reaches Codex as the `reasoning_effort` payload; a bad `mode:` reaches `buildCollaborationMode` unchecked. Fix by running `config show` to see the effective merged values.

Run `config show` whenever a knob seems to have no effect — the output enumerates every layer's path and highlights keys that differ from `DEFAULT_CONFIG`.

## Environment variable overrides

Four `CODEX_BRIDGE_*` env vars override runtime-only knobs that are not surfaced as `config.yaml` keys or CLI flags. **When they are read varies** — see the rightmost column:

| Env var | Default | Read when | Purpose |
|---|---|---|---|
| `CODEX_BRIDGE_HEARTBEAT_MS` | `60000` (60 s) | once per `task` / `send` turn (heartbeat-loop init) | Interval for `[HEARTBEAT]` events written to `.events`. Emits unconditionally regardless of Codex activity — proves the observability channel is live even during silent reasoning windows. |
| `CODEX_BRIDGE_CHECKPOINT_MS` | `300000` (5 min) | once per `task` / `send` turn (checkpoint-loop init) | Interval for `[CHECKPOINT]` digests (last assistant message + tool calls + git delta). Also drives the stall detector (see below). |
| `CODEX_BRIDGE_STALL_CHECKPOINTS` | `3` | once per `task` / `send` turn (checkpoint-loop init) | Consecutive **barren** checkpoint windows (no commands, no file changes, no plans) before the bridge emits `[ERROR] \| StallDetected` and stops the heartbeat/checkpoint timers. The barren counter only starts after the first actionable item lands (grace period); default stall window = `CHECKPOINT_MS × STALL_CHECKPOINTS` = 15 min once Codex is past that grace. |
| `CODEX_BRIDGE_NO_UPDATE_CHECK` | unset | every bridge invocation (auto-apply hot path) | Set to `"1"` (strict equality) to disable the silent auto-apply that re-installs `yigitkonur/codex-bridge` via `npx -y skills add` on non-`--json`, non-`update` invocations (rate-limited to once/hour/workspace). This is the only opt-out. |


### `skip_meta_skills`

Codex ships with opinionated skill chains that, by default, run before execution — planning skills, brainstorming skills, worktree-management skills, and any equivalent ceremony framework. When the bridge is already orchestrating — the orchestrator has decided the plan, the workspace, and the intent — those chains routinely burn many minutes producing spec and plan scaffolding under paths like `docs/`, `plans/`, `specs/`, or similar that isn't part of the deliverable.

With `skip_meta_skills: true` (shipped default), every prompt is prefixed with an `[ORCHESTRATOR DIRECTIVE]` line instructing Codex to execute directly and not to create such scaffolding. The directive is framework-agnostic — it targets the *behavior* (producing scaffold docs before touching the deliverable), not a specific skill name, so it stays effective as Codex's upstream skill chain evolves. This is **advisory** — Codex can still invoke its own skills — but in practice it cuts the ceremony overhead sharply. Set to `false` if you want Codex's full default behavior (e.g. when running without an orchestrator).

### `command_failure_circuit_breaker`

When Codex's ReAct loop attempts a command family that is structurally unavailable (e.g. `osascript` on a headless box, `display dialog` without a GUI, `computer-use/get_app_state` in a sandboxed env), it doesn't converge — each failure generates a new variant. The observed worst case is 24 attempts over 3 minutes before external intervention.

With this flag on (shipped default), the bridge tracks same-family command executions in a **sliding window of size 5** and trips when **3 of those 5 are failures**. In addition to raw non-zero exits, a **wrapper-pattern detector** counts monitored-family commands as failed even when the shell exits 0 if the command contains a known failure-hiding construct (`& kill`, `|| true`, `|| exit 0`, `; true` at end). This catches Codex's observed behavior of wrapping failing AppleScript in `osascript … & sleep 2; kill -TERM $!` to mask the underlying failure.

On trip, the bridge writes a `[WARNING]` event to `.events`:

```
[WARNING] <threadId> command-family-circuit-breaker-tripped
  family: osascript
  threshold: 3 consecutive failures
  sample: /bin/zsh -lc "osascript -e 'tell application …'"
  turnInterrupted: no
```

The NDJSON `CIRCUIT_BREAKER` record also carries `failsInWindow` (3-5), `windowSize` (5), and `wrapperDetected` (bool) so downstream tooling can distinguish "true structural failure" from "Codex hiding the failure behind a wrapper".

**Pre-v1.2.2 behavior:** counter was "3 strictly consecutive same-family fails" and had no wrapper detection. A retest under v1.2.1 found Codex routinely bypasses that threshold by interleaving successful wrappers between raw failures — v1.2.2 upgrades to the sliding window + wrapper detection to catch this.

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

**macOS caveat for `workspace-write`:** Apple seatbelt's enforcement of `workspace-write` depends on the Codex binary version and the OS rev — in some combinations `.git/` writes under the cwd succeed, in others they're denied. Do not rely on the sandbox to block `.git/` writes on macOS; if a task needs the **`workspace-dirty`** phase to be triggerable (e.g. for automated handback testing), verify with a scripted Codex run on your exact OS+Codex combo. The phase only fires when upstream Codex raises `SandboxError`; a permissive seatbelt lets the commit go through and the run finishes as `phase: "done"`. Linux sandboxes (bubblewrap/user-namespaces) are more consistently restrictive.

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

### Large scaffold — raised turn + pipeline budgets
```yaml
codex_bridge:
  turn_default_ms: 1800000       # 30 min per execute turn
  pipeline_stage_ms: 600000      # 10 min per review/fix/check stage
  pipeline_total_ms: 1800000     # 30 min total pipeline cap
```

Use for multi-file bootstrap tasks (Xcode/SPM projects, large migrations). Per-invocation alternative: pass `--turn-default-ms 1800000 --pipeline-stage-timeout-ms 600000 --pipeline-total-timeout-ms 1800000` on `task` instead of editing the config.

### Human-in-the-loop questions (slow answering)
```yaml
codex_bridge:
  question_answer_ms: 1800000    # 30 min for a human to answer
```

Default 5 min is tight if the answer requires deliberation. Per-invocation: `--question-timeout-ms 1800000` on `task` / `send`.

## Resetting to Defaults

Delete `config.yaml`. Hardcoded defaults in the script take over.
