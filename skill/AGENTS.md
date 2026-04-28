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
| `app-server-broker.mjs` | `src/app-server-broker.mjs` bundled by esbuild |
| `prompts/adversarial-review.md` | `src/prompts/adversarial-review.md` |
| `schemas/review-output.schema.json` | `src/schemas/review-output.schema.json` |
| `templates/execute-instructions.md` | `src/templates/execute-instructions.md` |
| `templates/plan-enforcement.md` | `src/templates/plan-enforcement.md` |

The build workflow runs a fresh build and checks these paths for drift. A source
change without regenerated skill output ships stale code to users.

## SKILL.md

`SKILL.md` is loaded by skill installers and by the Claude plugin manifest.
Keep its frontmatter in sync with code and package metadata:

- `name` must stay `codex-bridge`.
- `metadata.version` must match `package.json` and `.claude-plugin/plugin.json`.
- Runtime compatibility must match `package.json` engines and actual code.
- Examples must invoke `node <skill path>/scripts/codex-bridge.mjs`; there is no
  package-level executable declared in `package.json`.

If a command, flag, JSON envelope field, event tag, or default changes in code,
update `SKILL.md` and the relevant reference file in the same task.

## config.yaml

`skill/config.yaml` is the shipped user-editable layer. The code source of
truth is `DEFAULT_CONFIG` in `src/lib/config.mjs`.

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
- `pipeline_stage_ms: 300000`
- `pipeline_total_ms: 900000`
- `question_answer_ms: 300000`
- `prompt_footer`

When adding or changing a config key, update both `src/lib/config.mjs` and this
file. Then update `references/config-reference.md` and tests that cover config
surface behavior.

## References

Reference files are hand-authored. They are not copied by the build script.
Keep them aligned with the CLI metadata in `src/codex-bridge.mjs`, event
formatters in `src/lib/session-log.mjs`, error classification in
`src/lib/cli-errors.mjs`, and config defaults in `src/lib/config.mjs`.

Current reference files:

- `command-reference.md`
- `config-reference.md`
- `error-recovery.md`
- `monitor-patterns.md`
- `ndjson-guide.md`
- `notification-format.md`
- `orchestration-flows.md`
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
- Keep examples runnable against the checked-in bundle.
- Do not describe features that only exist in prose. Verify the command, flag,
  tag, or field in code first.
