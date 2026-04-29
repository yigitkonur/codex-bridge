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
  version: "2.0.0"
  homepage: "https://github.com/yigitkonur/codex-bridge"
---

# Codex Bridge

Codex is the executor; you are the orchestrator. Most of the wiring is in the runtime — your job is the **judgment**: when to delegate, what to surface as `specific_concerns`, when to merge, when to iterate.

## When to use codex-bridge

**Trigger** when the work is one of:

- Substantial implementation (multi-file, scaffolding, migrations).
- Plan→execute→review loop where you want the worker isolated from your context.
- Adversarial review where you want to weight findings against specific risks.
- Background coding job you want to tail without burning Opus turns on the implementation.
- A `[QUESTION]` or `[PLAN]` to respond to.
- Closed-loop iteration until verdict=approved (use `/codex-bridge:iterate`).

**Don't trigger** when:

- The task is a single-line typo or a one-file refactor under 50 LOC — just edit.
- You're watching a foreign long command (`xcodebuild`, `npm test`, …) — Monitor only understands `.events` files; use `Bash --run-in-background` instead.
- You already have an answer and are calling Codex for a second opinion on prose. Use a fresh subagent or write it yourself.

## How the runtime helps you

You almost never have to remember the wiring — the hooks do it:

- **PreToolUse(Agent)** intercepts Explore-class subagents and reroutes them through codex-bridge. Pass-through for Plan, general-purpose, and codex-bridge:* types.
- **PreToolUse(Bash)** auto-rejects `task --write` invocations missing `--worktree-auto`. Worktree isolation is the canonical write-mode contract.
- **PostToolUse(Bash)** parses the `--json` envelope and emits an `additionalContext` block with the literal Monitor invocation. You arm it on the next turn — no manual derivation.
- **SessionStart** injects running-job status into context, so you start every session oriented.
- **Stop** blocks if any approved-but-unmerged verdict is pending. Resolve before exiting.

When a hook misbehaves, set `CODEX_BRIDGE_HOOK_DISABLE=<name>` (or `=all`) and re-run.

## Briefs (the orchestrator's privileged channel)

For non-trivial work, prefer a **brief** over a free-text prompt. The brief is a small JSON object that travels with the task all the way through to the review prompt's `{{OPUS_CONCERNS}}` slot. See `references/brief-composition.md`.

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --json --background --worktree-auto --brief @brief.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" adversarial-review --brief @brief.json
```

`specific_concerns` flows into the adversarial-review prompt verbatim. Anything you'd say "watch out for X" about should go there — not in the prose `worker_assignment`.

## Capability gating

Before assuming a feature exists, read it. Two surfaces tell you what the bridge can do:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" version --json | jq '.result.adapter_capabilities'
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" status <task_id> --json | jq '.result.capabilities'
```

The active backend's `capabilities` object names the booleans you should branch on (`supports_questions`, `supports_resume`, `supports_worktree`, `supports_artifact_registry`, `supports_iteration_chain`, …). v2.0 ships only the codex backend; future adapters declare their own. Don't hard-code "codex behavior" in slash commands — branch on the capability you actually need.

## Identifiers

Two IDs flow through every task. Use the right one or commands fail:

- **`task_id`** (`task-mo…` / `review-mo…`) — canonical handle for `status`, `result`, `wait`, `events`, `cancel`, `merge`, `verdict`, `iterate`.
- **`threadId`** (UUID v7 `019d…`) — required by `send` and `steer`. Also accepted by jobId-side commands as a convenience.

**Don't pattern-match `[codex] Thread ready (019d…)` from stderr** — that's a threadId, not a task_id. The `--json` envelope (`result.task_id`, `result.threadId`, `result.eventsPath`, `result.monitor.tool_hint`) is the only canonical source.

## Worktrees and merges

Write-mode tasks land in `<repo>/../.codex-bridge-worktrees/<task_id>` on a `subagent/codex/<task_id>` branch. The worktree is **not** auto-removed on completion — you must:

1. Run `/codex-bridge:review <task_id>` (or rely on `/codex-bridge:iterate` to do it for you).
2. Inspect the verdict: `/codex-bridge:verdict <task_id>` or read `<jobs>/<task_id>/verdict.json`.
3. If `verdict=approved`: `/codex-bridge:merge <task_id>` (gated; refuses if verdict isn't approved). The Stop gate blocks session exit while approved-but-unmerged verdicts exist.
4. If `verdict=needs-attention` or `must-fix`: `/codex-bridge:iterate <task_id>` to re-brief and re-dispatch, or `/codex-bridge:verdict <task_id> --discard` to abandon.

## Pointers

Everything below is owned by another canonical surface. Read those when you need the detail; don't expect SKILL.md to mirror them.

- **Per-subcommand reference** — `node …/codex-bridge.mjs <sub> --help`. The `--json` envelope's `error.code`, `error.suggestion`, and `result.next_action.command` are also self-documenting.
- **Tag glossary** — `events --schema --json` emits the canonical list. Treat unknown tags as forward-compat — pass them through, don't filter on assumed vocabulary.
- **Config keys** — `config show --json --schema` prints the merged config + JSON schema. Edit `~/.codex-bridge/config.yaml` or `<workspace>/.codex-bridge.yaml`; the resolution order is documented there.
- **Error decision tree** — `references/error-recovery.md` (decision tree by `error.code` + `origin`).
- **Brief composition** — `references/brief-composition.md` (full schema + when to use which field).
- **One canonical orchestration flow** — `references/orchestration-flows.md`.
- **Notification format** — `references/notification-format.md` (judgment-only; the schema is owned by `events --schema`).
- **Monitor patterns** — `references/monitor-patterns.md` (Preset A only; everything else has been removed).
- **Re-bloat prevention** — `references/AGENTS.md` (read before adding a new reference file).

When in doubt: ask the runtime first (`--json --schema`, `config show`, `events --schema`), then read prose. Prose ages; the runtime is canonical.
