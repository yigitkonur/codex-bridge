---
name: codex-bridge-v2-alpha
description: >-
  DO NOT INVOKE — pre-release placeholder. The real codex-bridge skill content
  lands in T27 of the v2.0.0 redesign. Until then this file exists only so the
  plugin manifest's `skills: ["./skills/codex-bridge"]` declaration resolves to
  a tracked surface and the plugin is installable in isolation. Until T27 ships,
  use the legacy v1.5.0 skill at `./skill/SKILL.md` for real codex-bridge work.
version: "2.0.0-alpha.0"
---

# codex-bridge (pre-release)

This skill is a placeholder during the v2.0.0 plugin redesign. It exists so the plugin manifest at `plugin/.claude-plugin/plugin.json` can declare `skills: ["./skills/codex-bridge"]` and have the path resolve to a tracked file (empty directories aren't tracked by git, so without this file Claude Code's plugin loader would either reject the plugin or install it without the skill surface).

## What lands when

The full slim skill (target: ~1,200 words of judgment-only guidance) lands in T27 of the v2.0.0 redesign plan. Before then, the skill simply isn't useful — all of the runtime behavior currently flows through:

- Slash commands: `/codex-bridge:setup`, `/codex-bridge:task`, `/codex-bridge:review`, `/codex-bridge:adversarial-review`, `/codex-bridge:status`, `/codex-bridge:result`, `/codex-bridge:cancel`, `/codex-bridge:wait`, `/codex-bridge:events`, `/codex-bridge:respond`, `/codex-bridge:steer`, `/codex-bridge:send`, `/codex-bridge:summary`, `/codex-bridge:version`, `/codex-bridge:update`, `/codex-bridge:config`, `/codex-bridge:auth-status`, `/codex-bridge:await-artifact`
- Forwarder agent: `codex-bridge-runner` (lands in T10)

## Pre-release status

Don't rely on this skill's content. Track the v2.0.0 ship date in `MIGRATION.md` (lands in T29) for the canonical content arrival.
