# codex-bridge

a claude code plugin for handing real work to openai codex without losing track of the job.

claude stays the orchestrator. codex does the implementation, review, follow-up, and long-running work through the local codex app-server. codex-bridge adds the parts you usually end up wanting once this gets serious: background jobs, event logs, worktree isolation, structured briefs, review artifacts, verdicts, and gated merge.

<p align="center">
  <a href="https://github.com/yigitkonur/codex-bridge/actions/workflows/build.yml"><img alt="build" src="https://github.com/yigitkonur/codex-bridge/actions/workflows/build.yml/badge.svg"></a>
  <a href="https://github.com/yigitkonur/codex-bridge/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/yigitkonur/codex-bridge?sort=semver"></a>
  <a href="#license"><img alt="license" src="https://img.shields.io/badge/license-mit-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen">
</p>

## what you get

- `/codex-bridge:task` for delegating implementation, debugging, refactors, and multi-step work.
- `/codex-bridge:review` for codex's normal code review.
- `/codex-bridge:adversarial-review` for a steerable review that challenges the design and risk profile.
- `/codex-bridge:iterate` for task -> review -> verdict -> follow-up loops.
- `/codex-bridge:status`, `/codex-bridge:events`, `/codex-bridge:wait`, `/codex-bridge:result`, and `/codex-bridge:cancel` for background jobs.
- `/codex-bridge:verdict`, `/codex-bridge:verdicts`, and `/codex-bridge:merge` for branch-bound review and gated landing.

the official openai codex plugin is still the clean default if you only want `/codex:*` reviews and simple delegation. codex-bridge is the heavier tool: use it when you want durable artifacts, worktree isolation, monitor-ready event streams, and explicit merge control.

## requirements

- claude code with plugin support.
- node.js 22 or later.
- git.
- the codex cli on your path.
- a working codex login or provider config.

install codex if you do not already have it:

```bash
npm install -g @openai/codex
codex login
```

## install

install the plugin in claude code:

```text
/plugin marketplace add yigitkonur/codex-bridge
/plugin install codex-bridge@codex-bridge
/reload-plugins
```

then run:

```text
/codex-bridge:setup
```

`setup` checks node, npm, codex, auth, backend capability support, and the optional stop review gate. if it says ready, you are good.

why two commands? claude code installs plugins from marketplaces. `yigitkonur/codex-bridge` is the github repo that provides the marketplace, and `codex-bridge@codex-bridge` means "install the `codex-bridge` plugin from the `codex-bridge` marketplace." `@...` is the marketplace name, not the github owner.

if you see this:

```text
marketplace "yigitkonur" not found
```

you ran the old bad command, `/plugin install codex-bridge@yigitkonur`. add the marketplace first, then install from it with `@codex-bridge`.

for a local checkout while developing:

```text
/plugin marketplace add /absolute/path/to/codex-bridge
/plugin install codex-bridge@codex-bridge
/reload-plugins
```

if you are migrating from the old standalone skill under `~/.agents/skills/codex-bridge/`, read [migration.md](migration.md).

## quick start

review your current work:

```text
/codex-bridge:review --background
/codex-bridge:status
/codex-bridge:result
```

hand off an implementation task:

```text
/codex-bridge:task fix the failing auth tests with the smallest safe patch
```

run a stricter review:

```text
/codex-bridge:adversarial-review --base main focus on race conditions, data loss, and rollback safety
```

run the closed loop:

```text
/codex-bridge:iterate add retry/backoff to the upstream fetcher, cover it with tests, and stop when review approves
```

## main commands

### `/codex-bridge:task`

starts a codex task. by default the bridge uses plan mode, the configured sandbox, and the auto review pipeline.

use it for implementation, debugging, refactors, and bigger investigations. write-mode work should use worktree isolation; the plugin hooks enforce that for direct cli calls.

useful patterns:

```text
/codex-bridge:task --background investigate why ci is failing
/codex-bridge:task --write --worktree-auto add pagination to the export endpoint
/codex-bridge:task --resume finish the previous codex task
```

### `/codex-bridge:review`

runs codex's normal reviewer against the working tree, a branch diff, or a task worktree.

```text
/codex-bridge:review
/codex-bridge:review --base main
/codex-bridge:review --task task-abc123 --json
```

this command is review-only. it does not fix code.

### `/codex-bridge:adversarial-review`

runs the bridge's structured adversarial reviewer. use this when you want codex to question the approach, not just scan the diff.

```text
/codex-bridge:adversarial-review --base main question the caching design
/codex-bridge:adversarial-review --task task-abc123 --json
/codex-bridge:adversarial-review --brief @brief.json --concern "watch for non-retryable 4xx handling"
```

`--brief` and `--concern` feed the review focus channel as untrusted data, so you can steer the review without letting arbitrary text become instructions.

### `/codex-bridge:iterate`

runs a task, reviews the result, writes a verdict, and starts follow-up work until the task is approved or the max iteration limit is reached.

```text
/codex-bridge:iterate implement the settings migration and keep going until review approves
/codex-bridge:iterate task-abc123 --max 3
```

the output includes the next action. approved work still does not auto-merge.

### `/codex-bridge:status`, `/events`, `/wait`, `/result`, `/cancel`

these are the job controls.

```text
/codex-bridge:status
/codex-bridge:events task-abc123 --follow
/codex-bridge:wait task-abc123 --timeout-ms 1800000
/codex-bridge:result task-abc123
/codex-bridge:cancel task-abc123
```

events are written in a monitor-friendly format, so background work can be tailed without flooding the parent context.

### `/codex-bridge:verdict` and `/codex-bridge:merge`

write-mode work lands only after review and approval.

```text
/codex-bridge:verdict task-abc123 --set approved --summary "tests green; review concerns handled"
/codex-bridge:merge task-abc123
```

merge is intentionally strict. it refuses stale approvals, unapproved verdicts, dirty worktrees, and non-fast-forward branches.

## structured briefs

for non-trivial work, use a brief. it gives codex a clean assignment and gives the reviewer the same context later.

```json
{
  "goal": "add retry/backoff to the upstream fetcher",
  "worker_assignment": "implement exponential backoff with jitter, max 3 attempts; preserve the public api; cover it with a unit test.",
  "specific_concerns": [
    "do not swallow non-retryable 4xx upstream errors",
    "keep the timeout configurable through the existing config object"
  ],
  "acceptance_criteria": [
    "npm test passes",
    "public api stays compatible"
  ]
}
```

use it like this:

```text
/codex-bridge:task --brief @brief.json --background
/codex-bridge:adversarial-review --brief @brief.json --task task-abc123 --json
```

- schema: [plugin/schemas/brief.schema.json](plugin/schemas/brief.schema.json)
- brief guidance: [plugin/skills/codex-bridge/references/brief-composition.md](plugin/skills/codex-bridge/references/brief-composition.md)

## artifacts

each task gets a registry directory under `~/.codex-bridge/jobs/<task_id>/`.

```text
meta.json
brief.json
brief.md
events.jsonl
diff.patch
review.json
verdict.json
lock
```

that is the audit trail. use `/codex-bridge:result`, `/codex-bridge:events`, and `/codex-bridge:verdict` before digging into the files directly.

## config

config is merged in this order:

1. built-in defaults.
2. install-root `config.yaml`.
3. workspace-root `config.yaml`.
4. cwd `config.yaml`.

inspect the effective config:

```text
/codex-bridge:config show
```

the shipped defaults are intentionally agent-heavy: plan mode, `gpt-5.4`, `xhigh` effort, auto review on, danger-full-access sandbox, and meta-skill skipping.

## hooks and safety

codex-bridge ships claude code hooks for the stuff that should be enforced by runtime, not vibes:

- pre-tool agent routing for supported delegation cases.
- pre-tool bash checks for write-mode worktree isolation.
- post-tool bash monitor hints for background jobs.
- session lifecycle cleanup and status context.
- optional stop-time review gate.

the stop review gate is opt-in:

```text
/codex-bridge:setup --enable-review-gate
/codex-bridge:setup --disable-review-gate
```

if the official openai codex plugin is enabled, codex-bridge suppresses its own stop gate and leaves that path to the official plugin.

emergency bypass:

```bash
CODEX_BRIDGE_HOOK_DISABLE=all claude
```

or bypass one hook:

```bash
CODEX_BRIDGE_HOOK_DISABLE=pre-tool-agent claude
```

## codex integration

codex-bridge uses your local `codex` cli and the codex app-server. it does not create a second codex account, auth store, or remote runtime.

that means:

- your existing codex login applies.
- your codex provider config applies.
- usage counts against whatever codex account or provider you configured.
- static tests can prove local contracts, but real task/review round trips need a working codex install.

## faq

### should i use this or the official openai codex plugin?

use the official plugin for the straightforward path. use codex-bridge when you want stronger orchestration: background task tracking, worktree isolation, durable artifacts, review/verdict records, and gated merge.

### does codex-bridge edit my current checkout?

it can, but write-mode task work is meant to run in per-task git worktrees. merge back only after review approval.

### does review fix code?

no. `review` and `adversarial-review` are read-only. `task` and `iterate` are the write paths.

### where do i see what happened?

start with:

```text
/codex-bridge:status
/codex-bridge:result <task_id>
/codex-bridge:events <task_id> --follow
```

then inspect `~/.codex-bridge/jobs/<task_id>/` if you need the raw artifacts.

### how do i verify the install from a shell?

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" setup --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" version --json
```

## links

- [migration.md](MIGRATION.md)
- [changelog.md](CHANGELOG.md)
- [skill entry](plugin/skills/codex-bridge/SKILL.md)
- [brief schema](plugin/schemas/brief.schema.json)
- [brief composition](plugin/skills/codex-bridge/references/brief-composition.md)
- [error recovery](plugin/skills/codex-bridge/references/error-recovery.md)
- [adapter contract](src/adapters/README.md)

## license

mit.
