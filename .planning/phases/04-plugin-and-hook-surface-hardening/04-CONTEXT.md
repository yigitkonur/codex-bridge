---
phase: 04-plugin-and-hook-surface-hardening
created: 2026-05-03
status: planned
source_basis: source/tests/package/plugin/hook inspection, not repository prose outside .planning
---

# Phase 4 Context

## Goal

Maintainers can ship a consistent packaged plugin surface with safe hook activation, bounded decisions, and tested metadata relationships.

## Scope

Phase 4 covers requirements PLUG-01 through PLUG-04:

- PLUG-01: Packaged plugin manifest, commands, agents, hooks, config, scripts, prompts, schemas, and templates all resolve inside the packaged `plugin/` tree.
- PLUG-02: Root plugin metadata, package version, generated plugin metadata, and skill metadata have an explicit, tested version/canonicality relationship.
- PLUG-03: Stop hook blocks only when project lock and setup state prove the review gate is active, and it leaves timeout margin to emit a decision.
- PLUG-04: Session, subagent, user-prompt, and post-tool hooks cannot be spoofed by arbitrary stdout or unsafe monitor command text.

## Source-Backed Findings

- `plugin/.claude-plugin/plugin.json` declares plugin-local relative surfaces for skills, commands, agents, and hooks.
- `plugin/scripts/codex-bridge.mjs` resolves runtime assets from the plugin root when run from `plugin/scripts`.
- `esbuild.config.mjs` copies shared assets and root hooks into `plugin/`, but comments currently conflict with marketplace metadata about whether `plugin/` is canonical or alpha.
- Existing tests verify several plugin-local paths, but do not generically scan all `${CLAUDE_PLUGIN_ROOT}` references or assert all plugin manifest paths normalize under `plugin/`.
- `package.json`, `.claude-plugin/plugin.json`, and `skill/SKILL.md` use version `2.0.0`; `plugin/.claude-plugin/plugin.json` uses `2.0.0-alpha.0`; `plugin/skills/codex-bridge/SKILL.md` uses `2.0.0`.
- `hooks/hooks.json` and `plugin/hooks/hooks.json` wire only `SessionStart`, `SessionEnd`, and `Stop`; extra generated hook files exist but are not registered.
- `plugin/hooks/post-tool-bash.mjs` has strong monitor command validation; `plugin/hooks/pre-tool-agent.mjs` prints monitor hints from bridge stdout without reusing equivalent validation.
- Stop hook activation already checks the project lock and then setup JSON. Timeout margins are explicit: 900s hook timeout, 840s hook child timeout, 780s bridge turn timeout.

## Execution Strategy

Work is split into three plans so each requirement cluster has its own verification boundary:

- 04-01 strengthens packaged path and generated-surface contracts.
- 04-02 resolves the metadata canonicality relationship and pins it in tests/contracts.
- 04-03 wires or quarantines hook surfaces deliberately, reuses monitor sanitization, and replaces skipped spoof tests with active coverage.

