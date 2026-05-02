# Phase 3 Patterns: Existing Code To Follow

## CLI Handler Pattern

Use the existing `src/codex-bridge.mjs` handler shape:

- parse with `parseCommandInput`;
- validate impossible option combinations before mutation;
- capture `startedAt`;
- call focused helpers for behavior;
- emit through `emitSuccess` or structured errors;
- keep JSON and text output using the standard envelope.

Relevant analogs:

- `handleReviewCommand` for review option parsing and foreground/background session emission;
- `handleVerdict` for registry mutation and CLI envelopes;
- `handleMerge` for guarded mutation based on registry state;
- `handleTask` and worktree-auto paths for task-bound `iterate` work.

## Registry Pattern

Follow `src/lib/registry.mjs`:

- validate task IDs before computing paths;
- write through the existing atomic JSON helper;
- let registry-controlled timestamps override caller timestamps;
- return `null` for absent optional artifacts;
- throw `RegistryReadError` for corrupt JSON.

Tests should mirror `test/registry.test.mjs` instead of inventing a new fixture style.

## Review Parsing Pattern

Do not keep review parsing private to auto-pipeline. Move reusable behavior into a shared module so:

- native review markdown parsing is used consistently by review command, pipeline, and iterate;
- adversarial JSON normalization shares finding validation;
- future artifact replay can read the same `review_result` shape.

Keep raw review output for audit, but treat normalized findings as the public contract.

## Pipeline Event Pattern

`src/adapters/codex/pipeline.mjs` already logs stage events and NDJSON entries for diff/review/fix/check. Extend those fields instead of adding a separate logging channel.

Preserve current canonical stage names:

- `diff`
- `review`
- `fix`
- `check`
- `pipeline-total`

## Plugin Surface Pattern

In this checkout, `plugin/commands/` and `plugin/agents/` are editable packaged plugin surfaces. Generated runtime bundles under `plugin/scripts/` and `skill/scripts/` must still come from `npm run build`.

When a user-facing CLI surface changes:

- update `plugin/commands/*.md` directly;
- update `plugin/agents/codex-bridge-reviewer.md` when the reviewer handoff changes;
- run `npm run build` when source changes require generated bundles;
- add or update `test/plugin-surfaces.test.mjs`.

## Static Test Pattern

Prefer deterministic tests over live Codex calls for Phase 3:

- inject fake `runAppServerReview` and `runAppServerTurn` behavior where code already allows it;
- use temp directories and fake git repos for merge/worktree proof;
- assert JSON envelope fields with exact keys;
- keep live authenticated smoke as a Phase 6 requirement.
