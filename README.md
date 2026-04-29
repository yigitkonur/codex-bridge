# codex-bridge

A [Claude Code](https://code.claude.com/) plugin that delegates substantial coding work to **OpenAI Codex** through a hook-driven runtime. Claude orchestrates; Codex executes. Hooks intercept native `Agent` spawns, auto-arm Monitor on background dispatches, isolate write-mode tasks in per-task git worktrees, and surface running-job state into context — so the orchestrator rarely has to teach itself how to drive the bridge.

<p align="center">
  <a href="https://github.com/yigitkonur/codex-bridge/actions/workflows/build.yml"><img alt="build" src="https://github.com/yigitkonur/codex-bridge/actions/workflows/build.yml/badge.svg"></a>
  <a href="https://github.com/yigitkonur/codex-bridge/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/yigitkonur/codex-bridge?sort=semver"></a>
  <a href="#license"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen">
</p>

## install

```bash
# 1. install Codex and sign in
npm i -g @openai/codex && codex login

# 2. install the plugin
/plugin install codex-bridge@yigitkonur

# 3. verify
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" setup --json | jq '.result.ready'
```

If `setup` reports `true`, you're done. Open Claude Code in any repo and ask it to "have Codex…" — the plugin takes over.

Migrating from the v1.x skill at `~/.agents/skills/codex-bridge/`? See [MIGRATION.md](MIGRATION.md).

## what's different from a typical Codex skill

The v1.x version of codex-bridge was a 22K-word user-level skill that taught Claude how to drive the bridge by reading prose. v2.0 turns most of that teaching into runtime enforcement:

- **PreToolUse(Agent)** intercepts Explore-class subagent spawns and reroutes them through codex-bridge for cheap-fast read-heavy work. Plan and general-purpose subagents pass through unchanged.
- **PreToolUse(Bash)** auto-rejects `task --write` invocations that omit `--worktree-auto`. Worktree isolation is the canonical contract for write-mode work; the user's main checkout is never touched by a worker.
- **PostToolUse(Bash)** parses the `--json` envelope and emits the literal Monitor invocation as `additionalContext` — Claude arms it on the next turn without you having to teach the rule.
- **SessionStart** injects running-job status into context so every session boots oriented.
- **Stop** blocks if any approved-but-unmerged verdict is pending, with one-line resolution hints.

The skill is now ~3,600 words instead of 22,000. The runtime owns the wiring; SKILL.md owns the judgment.

## three-line examples

```bash
# delegate substantial work, isolated in a worktree, with concerns flowing into review
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --write --worktree-auto --json --brief @brief.json

# adversarial review using the brief's specific_concerns as {{OPUS_CONCERNS}}
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" adversarial-review --task <task_id> --brief @brief.json

# closed loop: dispatch → review → verdict → re-dispatch up to 3 rounds
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" iterate <task_id> --max 3 --brief @brief.json
```

The slash-command equivalents (`/codex-bridge:task`, `/codex-bridge:adversarial-review`, `/codex-bridge:iterate`) are preferred — the hooks fire on the underlying Bash invocations.

## verdict and merge

Write-mode work doesn't auto-land. Each task produces a worktree at `<repo>/../.codex-bridge-worktrees/<task_id>` on a `subagent/codex/<task_id>` branch. Convert review findings into a verdict, then merge:

```
/codex-bridge:verdict <task_id> --set approved --summary "Tests green; concerns dismissed."
/codex-bridge:merge <task_id>             # gated; refuses if verdict ≠ approved
/codex-bridge:merge <task_id> --pr        # opens a GitHub PR with brief + verdict as body
```

The Stop hook blocks session exit while approved-but-unmerged verdicts exist. `/codex-bridge:verdict <task_id> --discard` is the explicit "do nothing with this" sink.

## brief schema

The brief is the canonical channel for non-trivial dispatch. It's a small JSON object that travels from dispatch through review:

```json
{
  "goal": "Add retry/backoff to the upstream fetcher",
  "worker_assignment": "Implement exponential backoff with jitter, max 3 attempts; preserve the public API; cover with a unit test.",
  "specific_concerns": [
    "Don't swallow non-retryable 4xx upstream errors",
    "Make the timeout configurable via the existing Config object"
  ],
  "acceptance_criteria": ["npm test passes", "diff under 200 lines"]
}
```

`specific_concerns` flows verbatim into the adversarial-review prompt's `{{OPUS_CONCERNS}}` slot — the orchestrator's privileged channel for review focus. The full schema is at [`plugin/schemas/brief.schema.json`](plugin/schemas/brief.schema.json); composition guidance is in [`plugin/skills/codex-bridge/references/brief-composition.md`](plugin/skills/codex-bridge/references/brief-composition.md).

## per-backend support

v2.0 ships only the codex backend. The adapter abstraction at `src/adapters/` is in place so future backends are mechanical additions:

| backend | status | mode |
|---|---|---|
| `codex` | ready | OAuth via `codex login`; full capability set |
| `gemini` | placeholder README | future |
| `aider` | placeholder README | future |
| `claude-cli` | placeholder README | future |
| `ollama` | placeholder README | future |

Capabilities are exposed at `version --json::result.adapter_capabilities`. Don't hard-code "codex behavior" in slash commands — branch on declared capabilities.

## kill switches

Every hook reads `CODEX_BRIDGE_HOOK_DISABLE` first. Set it to a comma-separated list of hook names (`pre-tool-agent,pre-tool-bash,post-tool-bash,session-start,session-end,user-prompt-submit,subagent-stop,stop-gate`) or `all` to bypass.

```bash
# triage: skip the Agent intercept this session only
CODEX_BRIDGE_HOOK_DISABLE=pre-tool-agent claude

# emergency: skip every hook
CODEX_BRIDGE_HOOK_DISABLE=all claude
```

`--no-hooks` on the CLI bypasses every hook-driven behavior even when the orchestrator dispatches.

## config

Five-layer resolution (highest precedence first):

1. CLI flag (e.g., `--backend codex`).
2. `<cwd>/.codex-bridge.local.md` (gitignored, per-user-per-project).
3. `<cwd>/.codex-bridge.yaml`.
4. `<git-root>/.codex-bridge.yaml`.
5. `~/.codex-bridge/config.yaml`.

`config show --json --schema` prints the merged config plus its JSON schema. Use it to debug "why isn't my config taking effect?".

## artifact registry

Each task gets a directory at `~/.codex-bridge/jobs/<task_id>/`:

```
meta.json        # backend, started_at, base_sha, worktree, parent_task_id, capabilities
brief.json       # verbatim brief (or null if free-text)
brief.md         # human-readable rendering
events.jsonl     # NormalizedEvent stream (Monitor reads this)
diff.patch       # worktree state snapshot
review.json      # reviewer's structured output
verdict.json     # post-review decision
lock             # POSIX flock; held while worker alive
```

`cleanup --age-days 30` walks `meta.completed_at` and removes terminal directories; `--archive` tarballs first.

## status, events, wait

```bash
# fan-in view of all tracked jobs (live)
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" status --watch --interval 10s

# tail one job's events with smart defaults (excludes HEARTBEAT, 30-min timeout)
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" events <task_id> --follow

# block until terminal
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" wait <task_id> --timeout-ms 1800000 --json
```

Schema docs are emitted by the runtime: `events --schema --json`, `version --json`, `<sub> --help --json`. Don't trust prose for things the runtime can tell you directly.

## links

- [SKILL.md (judgment-only)](plugin/skills/codex-bridge/SKILL.md)
- [MIGRATION.md (v1.x → v2.0)](MIGRATION.md)
- [CHANGELOG.md](CHANGELOG.md)
- [Brief composition](plugin/skills/codex-bridge/references/brief-composition.md)
- [Error recovery decision tree](plugin/skills/codex-bridge/references/error-recovery.md)
- [Re-bloat prevention rules](plugin/skills/codex-bridge/references/AGENTS.md)
- [Adapter contract](src/adapters/README.md)

## license

MIT.
