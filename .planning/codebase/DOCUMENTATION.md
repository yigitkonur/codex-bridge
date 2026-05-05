# Documentation Governance

**Updated:** 2026-05-05

## Authority Model

GSD under `.planning/` is the only contributor and agent workflow system for
this repository. New planning, phase discussion, workflow policy, codebase
mapping, audits, field reports, and contributor/agent process notes belong
under `.planning/`.

Runtime and packaging facts must still be verified against implementation
before they are copied into GSD docs. The source of truth order is:

1. `package.json`, `package-lock.json`, and package scripts.
2. Authored runtime source under `src/`, root hook source under `hooks/`, and
   release/build scripts.
3. Tests under `test/` and CI workflows under `.github/workflows/`.
4. Plugin, marketplace, and skill manifests.
5. Generated installable outputs under `skill/` and `plugin/`.
6. GSD docs under `.planning/`.
7. Public Markdown prose, only after re-checking the files above.

## Allowed Public Documentation

Public/runtime documentation may stay outside `.planning/` only when it is part
of an install, release, runtime, or user command surface:

- `README.md`, `MIGRATION.md`, `CHANGELOG.md`, and `plugin/README.md`.
- `skill/SKILL.md`, `skill/config.yaml`, and `skill/references/**`.
- `plugin/skills/codex-bridge/SKILL.md` and packaged plugin reference files.
- `plugin/commands/*.md` and `plugin/agents/*.md`.
- Runtime prompt, schema, and instruction assets under `src/prompts/`,
  `src/schemas/`, and `src/templates/`, plus generated copies.
- `AGENTS.md` files and `CLAUDE.md` symlinks that point maintainers back to
  `.planning/` and current source facts.

These files are not workflow authorities. They may explain install, command
usage, runtime behavior, release history, or maintainer rules for generated
assets, but new contributor workflow material must be captured in `.planning/`.

## Removed Non-GSD Workflow Surfaces

The following surfaces were migrated or removed during the 2026-05-05 GSD-only
migration:

- `docs/superpowers/` - retired Superpowers workflow plan. Verified lessons
  were captured in `.planning/field-reports/2026-05-05-gsd-only-migration.md`.
- `REVIEW.md` - root review workflow rules. Source-verified invariants now live
  in `.planning/codebase/ADAPTERS.md`, `.planning/codebase/CONVENTIONS.md`, and
  `src/lib/AGENTS.md`.
- `plugin/skills/codex-bridge/references/AGENTS.md` - packaged re-bloat rules.
  The governance rule now lives here so packaged references do not carry
  contributor workflow authority.
- `src/adapters/**/README.md`, `src/adapters/**/INTERFACE.md`, and
  `src/adapters/_interface/*.md` - source-adjacent future-backend prose. The
  verified adapter contract lives in `.planning/codebase/ADAPTERS.md`; active
  source remains `src/adapters/index.mjs`, `src/adapters/index.d.ts`, and
  `src/adapters/codex/**`.

Historical mentions in `CHANGELOG.md` and archived GSD phase artifacts remain
history, not active workflow.

## Re-Bloat Gates

Before adding a new public reference file, capture the reason in GSD and check
all three gates:

1. **Runtime derivability:** If an existing `--help`, `--json`, `config show`,
   `version --json`, schema, or manifest can emit the fact, keep the fact in
   runtime output rather than duplicating it in prose.
2. **Hook or test enforceability:** If the rule is procedural, prefer a hook,
   test, or CLI validation over a prose reminder.
3. **GSD ownership:** If the rule is for contributors or agents, keep it under
   `.planning/` and link to it from maintainer-only instruction files when
   necessary.

Packaged `plugin/skills/codex-bridge/references/*.md` files remain under the
800-word budget enforced by `test/skill-word-budget.test.mjs`. The packaged
`SKILL.md` remains under the 1,500-word budget enforced by the same test.
