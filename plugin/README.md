# codex-bridge packaged plugin

this directory is the packaged claude code plugin layout for codex-bridge.

it contains the plugin-local command files, agent definitions, hook registry, generated runtime bundles, generated prompts/review schema/templates, the authored brief schema, and the packaged skill entry. source lives outside this directory except for packaged command/agent/skill surfaces and `plugin/schemas/brief.schema.json`; generated files are refreshed by `npm run build`.

## edit rules

- edit runtime source under `src/`.
- edit root hook source under `hooks/`.
- edit packaged command and agent surfaces under `plugin/commands/` and `plugin/agents/`.
- edit the packaged brief schema at `plugin/schemas/brief.schema.json`.
- do not hand-edit generated runtime files under `plugin/scripts/`, `plugin/prompts/`, `plugin/schemas/review-output.schema.json`, `plugin/templates/`, or `plugin/config.yaml`.

`plugin/schemas/review-output.schema.json` is generated from `src/schemas/`.
`plugin/schemas/brief.schema.json` is authored in place.

after any source or surface change, run:

```bash
npm run build
npm test
```

## install check

from claude code, add this repo as a marketplace, install the packaged plugin, and run setup:

```text
/plugin marketplace add yigitkonur/codex-bridge
/plugin install codex-bridge@codex-bridge
/reload-plugins
/codex-bridge:setup
```

from a shell inside an installed plugin, the equivalent check is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" setup --json
```

see the root [readme](../README.md) for user-facing setup and command docs.
contributor and agent workflow policy lives under `../.planning/`; this file is
only packaged-plugin layout guidance.
