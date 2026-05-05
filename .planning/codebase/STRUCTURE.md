---
last_mapped_commit: 6b3a78a98eb5396798d0ed2ee3d8f7451f204652
refreshed: 2026-05-05
---

# Codebase Structure

## Directory Layout

```text
codex-bridge/
|-- .claude-plugin/          # Marketplace and root plugin metadata
|-- .github/workflows/       # Build and release workflows
|-- .planning/               # GSD project state, maps, archives, field reports
|-- hooks/                   # Authored Claude hook source copied to plugin/
|-- plugin/                  # Canonical packaged Claude Code plugin layout
|   |-- .claude-plugin/
|   |-- agents/
|   |-- commands/
|   |-- hooks/
|   |-- prompts/
|   |-- schemas/
|   |-- scripts/
|   |-- skills/
|   `-- templates/
|-- scripts/                 # Contract, release, and smoke scripts
|-- skill/                   # Legacy installable skill bundle
|-- src/                     # Authored Node ESM runtime source
|   |-- adapters/
|   |-- lib/
|   |-- prompts/
|   |-- schemas/
|   |-- templates/
|   `-- codex-bridge.mjs
|-- test/                    # Node built-in test suite
|-- AGENTS.md
|-- CHANGELOG.md
|-- MIGRATION.md
|-- README.md
|-- esbuild.config.mjs
|-- package.json
`-- package-lock.json
```

The old `docs/superpowers/` tree and source-adjacent adapter prose docs were
removed during the 2026-05-05 GSD-only documentation migration. Contributor
workflow and architecture prose now belongs under `.planning/`.

## Primary Areas

**Root**
- Purpose: package metadata, public docs, plugin marketplace metadata, build
  config, release history, and maintainer instructions.
- Key files: `package.json`, `esbuild.config.mjs`, `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, `README.md`, `MIGRATION.md`,
  `CHANGELOG.md`, `AGENTS.md`.

**`.planning/`**
- Purpose: only contributor and agent workflow authority.
- Key files: `PROJECT.md`, `STATE.md`, `ROADMAP.md`, `MILESTONES.md`,
  `RETROSPECTIVE.md`, `codebase/DOCUMENTATION.md`,
  `codebase/ADAPTERS.md`, milestone archives, phase archives, field reports.

**`src/`**
- Purpose: authored runtime source.
- Key files: `src/codex-bridge.mjs`, `src/adapters/index.mjs`,
  `src/adapters/index.d.ts`, `src/adapters/codex/**`, `src/lib/**`,
  `src/prompts/**`, `src/schemas/**`, `src/templates/**`.

**`src/adapters/`**
- Purpose: adapter registry plus the concrete Codex adapter.
- Current fact: only `codex` is registered in `src/adapters/index.mjs`.
- GSD notes: adapter contract and future backend notes live in
  `.planning/codebase/ADAPTERS.md`.

**`src/lib/`**
- Purpose: shared config, runtime options, broker lifecycle, state, jobs, Git,
  registry, session logs, pending-request IPC, rendering, errors, update
  checks, process helpers, prompt helpers, and workspace helpers.

**`hooks/`**
- Purpose: authored hook source and active hook manifest.
- Build behavior: `npm run build` copies `hooks/` into `plugin/hooks/`.
- Active behavior is governed by `hooks/hooks.json`, not by script presence.

**`plugin/`**
- Purpose: canonical packaged Claude Code plugin installed by the marketplace.
- Authored public surfaces: `plugin/commands/*.md`,
  `plugin/agents/*.md`, `plugin/skills/codex-bridge/SKILL.md`,
  `plugin/schemas/brief.schema.json`, and plugin metadata.
- Generated/copied surfaces: runtime scripts, prompt/schema/template assets,
  config, and root hook copies.

**`skill/`**
- Purpose: legacy installable skill payload still used by release packaging.
- Authored surfaces: `skill/SKILL.md`, `skill/config.yaml`,
  `skill/references/**`, `skill/AGENTS.md`.
- Generated surfaces: `skill/scripts/`, `skill/app-server-broker.mjs`,
  `skill/prompts/`, `skill/schemas/`, and `skill/templates/`.

**`scripts/`**
- Purpose: release packaging, runtime smoke, and baseline contract validation.
- Key files: `scripts/baseline-contracts.mjs`,
  `scripts/runtime-smoke.mjs`, `scripts/package-release.mjs`.

**`test/`**
- Purpose: Node built-in tests for CLI envelopes, adapter registry/routing,
  Codex protocol/client behavior, broker lifecycle, config, state, jobs, Git,
  hooks, plugin surfaces, generated drift, update checks, release packaging,
  and static source contracts.

## Where To Make Changes

| Change | Primary edit location | Required follow-up |
|---|---|---|
| CLI subcommand | `src/codex-bridge.mjs` | plugin command docs, tests, build |
| Codex app-server behavior | `src/adapters/codex/**` | protocol/types/tests, build |
| Shared runtime helper | `src/lib/**` | focused tests, build if bundled |
| Config key | `src/lib/runtime-options.mjs`, `src/lib/config.mjs`, `skill/config.yaml` | generated `plugin/config.yaml`, tests |
| Prompt/schema/template | `src/prompts/`, `src/schemas/`, `src/templates/` | generated copies, tests |
| Hook behavior | `hooks/**` and `hooks/hooks.json` | generated `plugin/hooks/**`, hook tests |
| Plugin command/agent | `plugin/commands/`, `plugin/agents/` | plugin-surface tests |
| Packaged plugin skill docs | `plugin/skills/codex-bridge/**` | word-budget/plugin tests |
| Legacy skill docs/config | `skill/**` authored files | release/package tests |
| Contributor workflow docs | `.planning/**` | GSD health/review checks when available |

## Generated Paths

Do not hand-edit generated runtime files:

- `skill/scripts/`, `skill/app-server-broker.mjs`
- `skill/prompts/`, `skill/schemas/`, `skill/templates/`
- `plugin/scripts/`
- `plugin/prompts/`, `plugin/schemas/review-output.schema.json`,
  `plugin/templates/`, `plugin/config.yaml`

`plugin/schemas/brief.schema.json` is a packaged plugin-only authored schema,
not copied from `src/schemas/` by `esbuild.config.mjs`.

## Compatibility Files

`CLAUDE.md` files are symlinks to neighboring `AGENTS.md` files. Keep them as
compatibility aliases unless the project deliberately drops Claude-file
compatibility. Release packaging removes `skill/AGENTS.md` and
`skill/CLAUDE.md` from skill archives.

---

*Structure analysis refreshed: 2026-05-05*
