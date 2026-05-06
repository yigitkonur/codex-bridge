---
name: codex-bridge
description: >
  Delegate substantial implementation, refactor, debug, and review work to OpenAI
  Codex through a hook-driven runtime. Use when the user says "have Codex…",
  "run this by Codex", asks for an adversarial review, or wants a
  plan→execute→review→merge loop. The plugin's hooks intercept native Agent
  spawns (Explore-class), auto-arm Monitor on background dispatches, isolate
  write-mode tasks in a per-task git worktree, and surface running-job state
  into context — so the orchestrator rarely has to teach itself how to drive
  the bridge.
compatibility: Requires Node.js 22+, the Codex CLI on $PATH (`npm i -g @openai/codex && codex login`), and Claude Code v1.0+. macOS or Linux — the JSON-RPC broker uses unix sockets.
license: MIT
allowed-tools: Bash Monitor
metadata:
  version: "2.3.5"
  homepage: "https://github.com/yigitkonur/codex-bridge"
---

# Codex Bridge

Codex is the executor; you are the orchestrator. Most of the wiring is in the runtime — your job is the **judgment**: when to delegate, what to surface as `specific_concerns`, when to merge, when to iterate.

Tasks are read-only unless the command explicitly opts into writes or config
sets a wider sandbox. For file-changing work, use `--write`; for bridge-managed
isolation, pair it with `--worktree-auto`.

When using `--worktree-auto`, prompts and brief text must name repo-relative
paths (`src/file.ts`), not absolute paths inside the launch checkout. Absolute
checkout paths still point at the main workspace, so the bridge rejects them
before creating the task worktree.

Sandbox enforcement is opt-in for users who pin a sandbox policy and do not
want orchestrators to silently downgrade it with `--read-only`:

```yaml
codex_bridge:
  sandbox_policy: "danger-full-access"
  sandbox_enforce: true
```

Run `/codex-bridge:setup --enforce-sandbox` once to install the Claude
permission-layer deny rules. The PreToolUse Bash hook also denies `task
--read-only` when `sandbox_enforce: true`, and Explore agent reroutes use
`--write --worktree-auto` instead of `--read-only`. Known limitations:
auto-pipeline check, standalone `review`, standalone `adversarial-review`, and
the stop-time review gate run read-only by design; disable the stop-time review
gate when enforcing sandbox pins.

## Parallel dispatch

For N >= 2 parallel jobs, use `/codex-bridge:fan-out`:

```bash
/codex-bridge:fan-out --group <name> --prompt "..." --prompt "..." [--read-only|--write]
```

Do NOT use `Agent { subagent_type: "codex-bridge:codex-bridge-runner" }` for
parallel dispatch. The runner is for single substantial handoffs; fan-out uses
direct Bash dispatch and tags every job with the same group.

After dispatch, track the group:

```bash
/codex-bridge:status --group <name>
/codex-bridge:wait --group <name> --all
/codex-bridge:bundle --group <name> --output ./audit.tar.gz
```

## When to use codex-bridge

**Trigger** when the work is one of:

- Substantial implementation (multi-file, scaffolding, migrations).
- N >= 2 parallel dispatch via `/codex-bridge:fan-out`.
- Plan→execute→review loop where you want the worker isolated from your context.
- Adversarial review where you want to weight findings against specific risks.
- Background coding job you want to tail without burning Opus turns on the implementation.
- A `[QUESTION]` or `[PLAN]` to respond to.
- Task→review→verdict→follow-up loops with `/codex-bridge:iterate`.

**Don't trigger** when:

- The task is a single-line typo or a one-file refactor under 50 LOC — just edit.
- You're watching a foreign long command (`xcodebuild`, `npm test`, …) — Monitor only understands `.events` files; use `Bash --run-in-background` instead.
- You already have an answer and are calling Codex for a second opinion on prose. Use a fresh subagent or write it yourself.

## How the runtime helps you

The plugin enforces sandbox, plan-mode, Monitor, and event filtering automatically through hooks. You don't think about them. Specifically:

- **Monitor arms itself** when you dispatch a `--background` task. The exclude tags, timeout, and verbosity come from the workspace config.
- **Plan-mode triggers** when the user's prompt contains keywords like "plan" / "planla". You can override with `--mode default`.
- **Sandbox is pinned** to the workspace's configured policy. Read-only flags are stripped when the user has enabled sandbox enforcement.
- **Cadences** (checkpoint, heartbeat, idle timeout) are set from config; you cannot widen them mid-flight.

To inspect or change any of these: `/codex-bridge:config show` and `/codex-bridge:config set <key>=<value>`.

When a hook misbehaves: `CODEX_BRIDGE_HOOK_DISABLE=<name>` (or `=all`) bypasses it for one session. See `references/troubleshooting.md` for the full list.

## Briefs (the orchestrator's privileged channel)

For non-trivial work, prefer a **brief plus a real prompt**. The brief is a
small JSON object that is appended to the worker prompt and also travels with
the task through review/check artifacts. It does not remove the need for a
positional prompt or `--prompt-file`. See `references/brief-composition.md`.

Minimum useful brief — `goal` and `worker_assignment` are the only required keys:

```json
{
  "goal": "Add retry/backoff to the upstream fetcher",
  "worker_assignment": "Implement exponential backoff with jitter, max 3 attempts; preserve the existing public API; cover with a unit test.",
  "specific_concerns": [
    "Don't swallow non-retryable 4xx upstream errors",
    "Make the timeout configurable via the existing Config object"
  ]
}
```

Pass it to either subcommand:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --json --write --background --worktree-auto --brief @brief.json "Implement the task described in the Codex Bridge structured brief."
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" adversarial-review --brief @brief.json
```

`specific_concerns` flows into the adversarial-review prompt verbatim. Anything you'd say "watch out for X" about should go there — not in the prose `worker_assignment`.

## Capability gating

Before assuming a feature exists, read it. Two surfaces tell you what the bridge can do:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" version --json | jq '.result.adapter_capabilities'
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" status <task_id> --json | jq '.result.capabilities'
```

The active backend's `capabilities` object names the booleans you should branch on (`supports_questions`, `supports_resume`, `supports_worktree`, `supports_artifact_registry`, …). v2.x currently ships only the codex backend; future adapters must declare their own. Don't hard-code "codex behavior" in slash commands — branch on the capability you actually need.

## Identifiers

Two IDs flow through every task. Use the right one or commands fail:

- **`task_id`** (`task-mo…` / `review-mo…`) — canonical handle for `status`, `result`, `wait`, `events`, `timeline`, `cancel`, `merge`, `verdict`, `iterate`.
- **`threadId`** (UUID v7 `019d…`) — required by `send` and `steer`. Also accepted by jobId-side commands as a convenience.

**Don't pattern-match `[codex] Thread ready (019d…)` from stderr** — that's a threadId, not a task_id. The `--json` envelope (`result.jobId`, `result.threadId`, `result.eventsPath`, `result.monitor.tool_hint`) is the only canonical source — `result.jobId` is the canonical task handle.

## Worktrees and merges

Write-mode tasks land in `<repo>/../.codex-bridge-worktrees/<task_id>` on a `subagent/codex/<task_id>` branch. The worktree is **not** auto-removed on successful completion — you must:

1. Read `<jobs>/<task_id>/meta.json`, then run `adversarial-review --cwd <worktree.path> --base <worktree.base_ref>` with the same brief.
2. Inspect the verdict: `/codex-bridge:verdict <task_id>` or read `<jobs>/<task_id>/verdict.json`.
3. If `verdict=approved`: `/codex-bridge:merge <task_id>` (gated; refuses if verdict isn't approved). `verdicts --pending` shows approved-but-unmerged work. Do not manually `git merge subagent/codex/*` except as recovery from a bridge failure.
4. If `verdict=needs-attention` or `must-fix`: use `/codex-bridge:iterate <task_id>` or start a fresh worktree task with a corrected prompt; `/codex-bridge:verdict <task_id> --discard` abandons unwanted work.

Use `/codex-bridge:doctor` when long sessions accumulate stale jobs, orphan
`<repo>/../.codex-bridge-worktrees/task-*` directories, or
`subagent/codex/task-*` branches. `doctor --clean --yes` removes clean orphans
non-interactively; dirty worktrees are skipped unless `--force` is set.

Cancelling is different: `cancel <task_id>` removes the bridge-created
worktree and `subagent/*/<task_id>` branch by default. Pass `--keep-worktree`,
`--keep-branch`, or `--keep-all` only when you intentionally want cancelled
artifacts left behind for inspection.

## Forensics: when something fails

The detached worker dup's its stderr to `<logFile>.worker.err`. Network errors, codex-CLI parser failures, sandbox denials, and crash traces land there. The bridge surfaces them two ways:

- **Event stream** — when worker.err grows mid-job, the bridge emits `[WORKER_STDERR] <threadId> | size=… | class=…` with a 500-byte tail. `class` is a heuristic hint (`network`, `rate_limit`, `permission`, `crash`, `missing_dependency`, `unknown`) — always read the tail itself when triaging.
- **Result envelope** — `result --json` populates `result.adapterResult.workerErr.{path, size_bytes, tail, truncated, error_class_hint}` when the file is non-empty. Read the `path` for the full content.

## Pointers

Everything below is owned by another canonical surface. Read those when you need the detail; don't expect SKILL.md to mirror them.

- **Per-subcommand reference** — `node …/codex-bridge.mjs <sub> --help`. The `--json` envelope's `error.code`, `error.suggestion`, and `result.next_action.command` are also self-documenting.
- **Event stream** — `events --help` shows the supported filters. Treat unknown tags as forward-compat — pass them through, don't filter on assumed vocabulary. v2.2.0 adds `[STALL_WARNING]` (early stall at 5 min), `[NEEDS_ATTENTION]` (alongside QUESTION/PLAN/ERROR for fan-out attention routing), `[ARTIFACT]` (new file created in worktree), and `[DRIFT_WARN]` (heuristic out-of-scope file detection).
- **Merged timeline** — `timeline <task_id>` merges `.events`, `.ndjson`, task log, and worker stderr for forensic reconstruction. Use `--source`, `--since`, and `--format json|html` for focused analysis.
- **Result state machine** — `references/state-machine.md` explains why `result --json` treats terminal events as authoritative and exposes `adapterResult.consistent`.
- **Config keys** — `/codex-bridge:config show` prints the merged config with provenance; `/codex-bridge:config set <key>=<value>` writes a key to the workspace `.claude/codex-bridge.local.md`; `/codex-bridge:config explain <key>` describes a knob. After set/reset: restart Claude Code.
- **Pipeline timeouts** — per-stage pipeline default is 12 min; for very large reviews use `task --pipeline-stage-timeout-ms <ms> --pipeline-total-timeout-ms <ms>`.
- **Error decision tree** — `references/error-recovery.md` (decision tree by `error.code` + `origin`).
- **Brief composition** — `references/brief-composition.md` (full schema + when to use which field).
- **One canonical orchestration flow** — `references/orchestration-flows.md`.
- **Notification format** — `references/notification-format.md` (judgment-only; current CLI details are owned by `events --help`).
- **Monitor patterns** — `references/monitor-patterns.md` (Preset A only; everything else has been removed).
- **Troubleshooting** — `references/troubleshooting.md`.

When in doubt: ask the runtime first (`<subcommand> --help`, `config show --json`, `version --json`), then read prose. Prose ages; the runtime is canonical.
