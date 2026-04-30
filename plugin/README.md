# codex-bridge plugin scaffold

This directory is the pre-release v2.0.0 plugin scaffold for codex-bridge. It is
not the canonical v1.5.0 runtime skill yet. The shipped runtime skill remains at
`../skill/SKILL.md`, and the root `.claude-plugin/plugin.json` remains the
v1.5.0 plugin metadata for the current release line.

The plugin manifest in this directory intentionally keeps the plugin name as
`codex-bridge` because it is the replacement plugin surface for the same
project, not a second product. Do not load the root plugin surface and this
pre-release scaffold together in one Claude Code install; the marketplace entry
at `../.claude-plugin/marketplace.json` points to `./plugin` so an install path
chooses this scaffold explicitly.

The `2.0.0-alpha.0` version marks the scaffold as pre-release work for the v2
plugin redesign. It intentionally differs from the root v1.5.0 metadata until
the v2 plugin surface becomes the release surface.

Current tracked surfaces are intentionally minimal:

- `plugin/.claude-plugin/plugin.json` declares only the placeholder skill and
  hooks config that exist in this directory.
- `plugin/skills/codex-bridge/SKILL.md` is a placeholder so the skill path
  resolves during install validation.
- `plugin/hooks/hooks.json` is an empty hooks registry for later phases.

Commands and agents are omitted from the manifest until their tracked files land
in later v2 phases.
