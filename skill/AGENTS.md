# skill/AGENTS.md

This folder is the installable Codex Bridge skill bundle. Some files are
authored here; others are generated from `src/` by `npm run build`.

## Authored Files

Edit these directly:

- `SKILL.md` - user-facing skill instructions and frontmatter metadata.
- `config.yaml` - commented shipped defaults for end users.
- `references/**` - user-facing reference material.
- `AGENTS.md` - maintainer instructions for this folder.
- `CLAUDE.md` - symlink to `AGENTS.md`.

The release workflow removes `AGENTS.md` and `CLAUDE.md` from release archives,
so do not put user-required runtime instructions only in this file.

## Generated Files

Do not hand-edit these. Edit the matching source under `src/` and run
`npm run build`.

| Generated path | Source |
|---|---|
| `scripts/codex-bridge.mjs` | `src/codex-bridge.mjs` bundled by esbuild |
| `app-server-broker.mjs` | `src/adapters/codex/broker.mjs` bundled by esbuild |
| `prompts/adversarial-review.md` | `src/prompts/adversarial-review.md` |
| `schemas/review-output.schema.json` | `src/schemas/review-output.schema.json` |
| `templates/execute-instructions.md` | `src/templates/execute-instructions.md` |
| `templates/plan-enforcement.md` | `src/templates/plan-enforcement.md` |

The build workflow runs a fresh build and checks these paths for drift. A source
change without regenerated skill output ships stale code to users.

## SKILL.md

`SKILL.md` is loaded by legacy skill installers and by the root plugin
manifest's `./skill` entry. The packaged marketplace plugin has a separate
`plugin/skills/codex-bridge/SKILL.md`; keep both skill frontmatters in sync
with code and package metadata:

- `name` must stay `codex-bridge`.
- `metadata.version` must match `package.json`. Keep `package.json`, both
  plugin manifests, `skill/SKILL.md`, and
  `plugin/skills/codex-bridge/SKILL.md` version metadata aligned.
- Runtime compatibility must match `package.json` engines and actual code.
- Examples must invoke `node <skill path>/scripts/codex-bridge.mjs`; there is no
  package-level executable declared in `package.json`.

If a command, flag, JSON envelope field, event tag, or default changes in code,
update `SKILL.md` and the relevant reference file in the same task.

## config.yaml

`skill/config.yaml` is the shipped user-editable layer. The code source of
truth for default values is `DEFAULT_CONFIG` in
`src/lib/runtime-options.mjs`; `src/lib/config.mjs` owns schema validation,
diagnostics, and layer merging.

Current default keys are:

- `mode: "plan"`
- `model: "gpt-5.4"`
- `effort: "xhigh"`
- `auto_review: true`
- `post_task_prompt`
- `allow_questions: true`
- `session_dir: "~/.codex-bridge/sessions"`
- `sandbox_policy: "danger-full-access"`
- `skip_meta_skills: true`
- `command_failure_circuit_breaker: true`
- `idle_timeout_ms: 300000`
- `turn_plan_ms: 1800000`
- `turn_default_ms: 1800000`
- `pipeline_stage_ms: 720000`
- `pipeline_total_ms: 1800000`
- `destructive_diff_mode: "pause"`
- `destructive_diff_lines_deleted: 1000`
- `destructive_diff_files_changed: 30`
- `question_answer_ms: 300000`
- `artifact_retention_jobs: 50`
- `artifact_retention_days: 30`
- `redact_secrets: false`
- `prompt_footer`

When adding or changing a config key, update `src/lib/runtime-options.mjs`,
`src/lib/config.mjs`, `skill/config.yaml`, generated `plugin/config.yaml`, and
tests that cover config surface behavior.

## References

Reference files are hand-authored. They are not copied by the build script.
Keep them aligned with the CLI metadata in `src/codex-bridge.mjs`, event
formatters in `src/lib/session-log.mjs`, error classification in
`src/lib/cli-errors.mjs`, config defaults in `src/lib/runtime-options.mjs`, and
config schema/layering in `src/lib/config.mjs`.

Before adding a new user-facing reference file or workflow-like prose, read
`.planning/codebase/DOCUMENTATION.md` and satisfy its public-documentation
exception and re-bloat gates. Contributor or agent workflow policy belongs in
GSD, not in the shipped skill references.

Current reference files:

- `command-reference.md`
- `config-reference.md`
- `error-recovery.md`
- `monitor-patterns.md`
- `ndjson-guide.md`
- `notification-format.md`
- `orchestration-flows.md`
- `brief-composition.md`
- `prompt-writing.md`
- `templates/coder-mission.md`
- `templates/research-mission.md`
- `templates/test-runner.md`

Use relative links inside references so they work in GitHub and in an installed
skill tree.

## Editing Rules

- If you touch generated paths, stop and move the edit to `src/` instead.
- If you touch `src/`, run `npm run build` before verification.
- If you only touch authored skill docs/config, `npm test` is usually enough.
  Re-read cited code paths manually when updating instructions.
- Keep examples runnable against the checked-in bundle.
- Do not describe features that only exist in prose. Verify the command, flag,
  tag, or field in code first.
