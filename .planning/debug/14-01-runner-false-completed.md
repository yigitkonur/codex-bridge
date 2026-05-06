---
status: fixed
trigger: "14.01 runner returns completed status when it actually gave up"
created: 2026-05-06
updated: 2026-05-06
---

# Debug Session: 14.01 Runner False Completed

## Symptoms

- expected_behavior: "A codex-bridge runner or monitor wrapper reports completed only after the bridge dispatch or terminal monitor event actually succeeds; denial, failed dispatch, timeout, or non-terminal progress must not be framed as success."
- actual_behavior: "Runner subagent can return explanatory text after Bash denial and be surfaced by Claude Code as completed; monitor wrapper patterns can return on non-terminal events and also be surfaced as completed."
- error_messages: "No bridge error envelope; runner body says it needs Bash permission. Monitor wrapper body may contain [DIRECTIVES], [CHECKPOINT], or 'Monitor armed' text."
- timeline: "Observed in parallel fan-out sessions described by the focused 14.01 field report."
- reproduction: "Spawn codex-bridge:codex-bridge-runner for background JSON dispatch without Bash permission, or wrap Monitor in a subagent that returns on each event."

## Current Focus

- hypothesis: "The primary local defect is the packaged runner/hook contract: the runner relies on Claude subagent completion semantics and lacks a fail-fast structured denial path, while monitor handoff prose allows wrapper use instead of terminal-only Monitor usage."
- test: "Inspect runner, hook, monitor hint, command docs, and plugin tests; add contract tests for denial/fail-fast wording and terminal-only Monitor semantics."
- expecting: "Focus case is real but not fully solvable inside bridge runtime because Claude Code owns task-notification statuses; local fix must avoid/short-circuit false-success surfaces and make monitor handoff terminal-only."
- next_action: "Focused fix implemented; targeted tests pass. Full npm test is blocked by unrelated base-ref/worktree failures in concurrent dirty changes."
- reasoning_checkpoint:
- tdd_checkpoint:

## Evidence

- timestamp: 2026-05-06
  source: "codex-bridge-feedback/codex/14-real-world-failure-cases/01-P0-runner-returns-completed-when-it-actually-gave-up.md"
  observation: "Focused report documents two variants: runner Bash denial surfaced as completed, and monitor wrapper non-terminal pulses surfaced as completed."

## Eliminated

- hypothesis: "Flat summary file should define additional work."
  reason: "User scoped source of truth to per-issue files inside 14-real-world-failure-cases/."

## Resolution

- root_cause: "The canonical plugin task command routed dispatch through a native Agent wrapper, but Claude Code's Agent completion label only means the wrapper turn ended, not that codex-bridge created a job or reached a terminal event. The legacy runner also lacked a structured Bash-denial fail-fast path, and SubagentStop was silent when no job id existed."
- fix: "Route /codex-bridge:task through direct Bash, downgrade the runner to compatibility-only single dispatch with BASH_DENIED fail-fast output, make SubagentStop surface no-dispatch bridge subagents as failed context, and explicitly require parent-thread Monitor rather than Agent-wrapped Monitor."
- verification: "npm run build passed. node --test test/plugin-surfaces.test.mjs test/codex-adapter-lifecycle.test.mjs passed. node --test test/baseline-contracts.test.mjs and node --test test/result-summary-contract.test.mjs passed after build. Full npm test currently fails on unrelated base-ref/worktree tests outside 14.01 scope."
- files_changed: "plugin/commands/task.md, plugin/agents/codex-bridge-runner.md, hooks/subagent-stop.mjs, hooks/pre-tool-agent.mjs, hooks/post-tool-bash.mjs, plugin/hooks/subagent-stop.mjs, plugin/hooks/pre-tool-agent.mjs, plugin/hooks/post-tool-bash.mjs, plugin/skills/codex-bridge/references/monitor-patterns.md, skill/references/monitor-patterns.md, test/plugin-surfaces.test.mjs, .planning/debug/14-01-runner-false-completed-analysis-plan.md"
