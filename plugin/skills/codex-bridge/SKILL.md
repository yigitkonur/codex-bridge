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
  version: "2.2.0"
  homepage: "https://github.com/yigitkonur/codex-bridge"
---

# Codex Bridge

Codex is the executor; you are the orchestrator. Most of the wiring is in the runtime — your job is the **judgment**: when to delegate, what to surface as `specific_concerns`, when to merge, when to iterate.

Tasks are read-only unless the command explicitly opts into writes or config
sets a wider sandbox. For file-changing work, use `--write`; for bridge-managed
isolation, pair it with `--worktree-auto`.

## When to use codex-bridge

**Trigger** when the work is one of:

- Substantial implementation (multi-file, scaffolding, migrations).
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

You almost never have to remember the wiring — the hooks do it:

- **PreToolUse(Agent)** intercepts Explore-class subagents and reroutes them through codex-bridge. Pass-through for Plan, general-purpose, and codex-bridge:* types.
- **PostToolUse(Bash|Agent)** parses accepted bridge envelopes and emits an `additionalContext` block with the literal Monitor invocation. You arm it on the next turn — no manual derivation.
- **SessionStart** injects running-job status into context, so you start every session oriented.
- **Stop** can run the opt-in stop-time review gate. Pending verdicts are surfaced through `verdicts --pending`; check and resolve them before exiting.

When a hook misbehaves, set `CODEX_BRIDGE_HOOK_DISABLE=<name>` (or `=all`) and re-run.

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

- **`task_id`** (`task-mo…` / `review-mo…`) — canonical handle for `status`, `result`, `wait`, `events`, `cancel`, `merge`, `verdict`, `iterate`.
- **`threadId`** (UUID v7 `019d…`) — required by `send` and `steer`. Also accepted by jobId-side commands as a convenience.

**Don't pattern-match `[codex] Thread ready (019d…)` from stderr** — that's a threadId, not a task_id. The `--json` envelope (`result.jobId`, `result.threadId`, `result.eventsPath`, `result.monitor.tool_hint`) is the only canonical source — `result.jobId` is the canonical task handle.

## Worktrees and merges

Write-mode tasks land in `<repo>/../.codex-bridge-worktrees/<task_id>` on a `subagent/codex/<task_id>` branch. The worktree is **not** auto-removed on completion — you must:

1. Read `<jobs>/<task_id>/meta.json`, then run `adversarial-review --cwd <worktree.path> --base <worktree.base_ref>` with the same brief.
2. Inspect the verdict: `/codex-bridge:verdict <task_id>` or read `<jobs>/<task_id>/verdict.json`.
3. If `verdict=approved`: `/codex-bridge:merge <task_id>` (gated; refuses if verdict isn't approved). `verdicts --pending` shows approved-but-unmerged work. Do not manually `git merge subagent/codex/*` except as recovery from a bridge failure.
4. If `verdict=needs-attention` or `must-fix`: use `/codex-bridge:iterate <task_id>` or start a fresh worktree task with a corrected prompt; `/codex-bridge:verdict <task_id> --discard` abandons unwanted work.

## Pointers

Everything below is owned by another canonical surface. Read those when you need the detail; don't expect SKILL.md to mirror them.

- **Per-subcommand reference** — `node …/codex-bridge.mjs <sub> --help`. The `--json` envelope's `error.code`, `error.suggestion`, and `result.next_action.command` are also self-documenting.
- **Final answer extraction** — `result <job-id> --transcript --final-only --format text` prints Codex's stored final assistant message without raw NDJSON queries.
- **Event stream** — `events --help` shows the supported filters. Treat unknown tags as forward-compat — pass them through, don't filter on assumed vocabulary.
- **Config keys** — `config show --json` prints the merged config. Edit `~/.codex-bridge/config.yaml`, `<workspace>/config.yaml`, or the cwd `config.yaml`; the resolution order is documented there.
- **Error decision tree** — `references/error-recovery.md` (decision tree by `error.code` + `origin`).
- **Brief composition** — `references/brief-composition.md` (full schema + when to use which field).
- **One canonical orchestration flow** — `references/orchestration-flows.md`.
- **Notification format** — `references/notification-format.md` (judgment-only; current CLI details are owned by `events --help`).
- **Monitor patterns** — `references/monitor-patterns.md` (Preset A only; everything else has been removed).

When in doubt: ask the runtime first (`<subcommand> --help`, `config show --json`, `version --json`), then read prose. Prose ages; the runtime is canonical.
