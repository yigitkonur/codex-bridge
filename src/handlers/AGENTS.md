# src/handlers/AGENTS.md

This folder contains command handlers imported by `src/codex-bridge.mjs`.
Handlers own command-specific parsing and orchestration; shared mechanics belong
in `src/lib/`.

## Grouping

| File | Commands |
|---|---|
| `meta.mjs` | `setup`, `version`, `update`, `config`, `auth-status`, machine-readable help data |
| `task.mjs` | `task`, `task-worker`, `send`, `steer`, `respond`, `cancel` |
| `review.mjs` | `review`, `adversarial-review` |
| `inspect.mjs` | `summary`, `status`, `result`, `wait`, `events`, `task-resume-candidate`, `await-artifact` |
| `registry.mjs` | `merge`, `verdict`, `verdicts`, `iterate` |

Keep existing handler names stable. `handleAdversarialReview` is the named
handler for the formerly inline dispatch arrow.

## Conventions

- Parse flags through `parseCommandInput` from `src/lib/handler-utils.mjs`.
- Resolve cwd/workspace with shared helpers before reading config or state.
- Import path constants from `src/lib/runtime-paths.mjs`; do not recompute
  source-vs-bundled paths with `import.meta.url`.
- Emit structured success with `emitSuccess`; throw `CliError` subclasses or
  helpers from `src/lib/cli-errors.mjs` for classified failures.
- Use `src/lib/task-runtime.mjs` for task/review execution and background task
  launch mechanics.
- If a helper is called by two or more handler groups, move it to `src/lib/`
  instead of duplicating it between handler files.
- User-facing command changes must update `src/commands-meta.mjs`,
  `SUBCOMMAND_DISPATCH` in `src/codex-bridge.mjs`, plugin command docs, skill
  references, and tests together.

Run `npm run build` and `npm test` after handler changes. For runtime behavior
changes, also exercise the affected CLI command against an authenticated Codex
install when possible.
