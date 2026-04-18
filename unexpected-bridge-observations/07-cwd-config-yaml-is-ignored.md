# 07 — `config.yaml` in cwd/workspace is silently ignored

**Observed:** 2026-04-18 during gherkin-tests-v2 retest after Codex backend recovered.
**Codex version:** `codex-cli 0.104.0`
**Bridge bundle:** `skill/scripts/codex-bridge.mjs` @ `7d224ea` (7 commits on origin/main).

## What happened

Set up a fresh fixture at `/tmp/cbtest-retest.nVz080/` with a deliberate config override:

```yaml
# /tmp/cbtest-retest.nVz080/config.yaml
codex_bridge:
  mode: default
  auto_review: false
  post_task_prompt: ""
```

The fixture is a clean git repo. The config was placed at the repo root — the same place a user would intuitively expect. Ran:

```sh
bridge task --mode default --write --json "create a minimal index.html with <h1>Hello</h1> and a <p>World</p>"
```

**Expected** (per `gherkin-tests-v2/03-config/01-auto-review-false-shortcircuits-pipeline.md` and `03-config/02-empty-post-task-prompt-skips-check.md`): pipeline skips review and check stages. `.events` should contain `[PIPELINE:diff]` → `[DONE]`, nothing else.

**Observed**: full pipeline ran all three stages.

```
[PIPELINE:diff]   15:12:01
[PIPELINE:review] 15:12:01
[PIPELINE:check]  15:13:30
[DONE] … pipeline: {complete:true, completedStages:['diff','review','check']}
```

The config file sitting next to the task's cwd was never read.

## Root cause (corrected)

My initial diagnosis pointed at `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/config.yaml` — wrong. That path is a state store (`state.json` + `jobs/*.json`) and only holds one setting (`stopReviewGate`) via `src/lib/state.mjs::getConfig`. The actual bridge config is at:

```
${CLAUDE_SKILL_DIR}/config.yaml
```

…i.e. the installed skill's own config.yaml (`~/.claude/skills/codex-bridge/config.yaml` for a global install). `src/lib/config.mjs::loadConfig(skillDir)` reads only that single file and merges it with `DEFAULT_CONFIG`. A `config.yaml` anywhere else — cwd, workspace root, state dir — was never consulted. Before the fix below, a user tweaking `config.yaml` in their project directory had no effect whatsoever.

## Resolution — 2026-04-18

`src/lib/config.mjs::loadConfig` now takes an optional `overrideDir` argument. When a caller passes one (task, send, steer, wait, events, review), `{overrideDir}/config.yaml` is read as a top layer over the skill config:

```
DEFAULT_CONFIG < ${CLAUDE_SKILL_DIR}/config.yaml < ${cwd}/config.yaml
```

Verified live against the same fixture this observation was discovered on: with `config.yaml` in cwd setting `auto_review: false, post_task_prompt: ""`, a full `bridge task --mode default --write …` now produces only `[DONE]` — no `[PIPELINE:review]`, no `[PIPELINE:check]`. `gherkin-tests-v2/03-config/01` and `03-config/02` now PASS.

Fix landed in commit covering `src/lib/config.mjs` (new override layer), `src/codex-bridge.mjs` (cwd wired into `getBridgeConfig(cwd)` for task/send/steer/wait/events), `skill/references/config-reference.md` (documents the layered resolution), and the regenerated `skill/scripts/codex-bridge.mjs` bundle.

Three of the five originally-scoped fixes are now live (override semantics, docs, discoverable via `bridge setup --json`). Two remain for a follow-up:

- `bridge config show` as a first-class introspection command
- Warning surfaced to stderr when a plausible-but-unused config.yaml is detected at cwd while the current overrideDir is elsewhere (currently silent success)

## Why this is a derailment

1. **Two specs falsely appear to fail.** `gherkin-tests-v2/03-config/01-auto-review-false-shortcircuits-pipeline.md` and `03-config/02-empty-post-task-prompt-skips-check.md` both assume "set `auto_review: false` in the workspace's config.yaml" works. As written, both will "fail" against a fixture placed in a tmp dir with a cwd-level config — even though the underlying pipeline code behaves correctly; the config just never reaches it.

2. **Hidden state complexity.** The user has to know about `$CLAUDE_PLUGIN_DATA` (often `~/.claude/plugins/data/codex-openai-codex/state/` under Claude Code), navigate to the correct workspace hash directory, and write the file there. Nothing in `skill/config.yaml` or `skill/SKILL.md` explains this.

3. **No `bridge` subcommand exposes the config location.** `bridge setup --json` returns `ready`, `codex`, `auth`, `broker` — no `configPath`. `bridge version --json` likewise. A user debugging "why isn't my config taking effect" has no affordance.

## Suggested fixes (not implemented here)

1. **Honor `./config.yaml` with override semantics.** If `$(pwd)/config.yaml` or `$(workspaceRoot)/config.yaml` exists, read it AFTER the state-dir config and let its keys override. That matches the muscle memory users already have from every other CLI (npm, prettier, eslint, etc.). Backwards-compatible.

2. **Surface the active config path in `setup` / `version`.** Add `result.configPath` to both envelopes. Lets a user run `bridge version --json | jq .result.configPath` and see exactly which file is authoritative for this invocation.

3. **`bridge config show --json`.** A first-class subcommand that prints `{configPath, values, source: "default" | "user"}` for every key. This is the normal CLI affordance; the absence of it makes config debugging a grep-the-source exercise.

4. **Warn when a plausible-but-unused config.yaml is detected.** During state-dir config load, if a sibling `config.yaml` exists at `$(workspaceRoot)`, emit `{tag: "CONFIG_WARNING"}` to `.ndjson` + stderr: "`$(workspaceRoot)/config.yaml` is ignored; the active config lives at `$stateDir/config.yaml`." Cheap to implement, high-value UX.

5. **Update `skill/references/config-reference.md`** to document the actual path explicitly and include `ls ~/.claude/plugins/data/.../state/<slug>-*/config.yaml` as the discovery command.

## Effect on specs

- `gherkin-tests-v2/03-config/01-auto-review-false-shortcircuits-pipeline.md` — update the Background to say "config.yaml lives at `$stateDir/config.yaml` (see obs 07); you must place it there via `bridge setup` or manual write, not at the workspace root."
- `gherkin-tests-v2/03-config/02-empty-post-task-prompt-skips-check.md` — same.
- `gherkin-tests-v2/03-config/03-plan-mode-masks-effort-config.md` — same.

This doesn't change the specs' assertions (those remain correct about bridge behavior); it just adds the missing Setup step that's required for the predicate to evaluate the code path the spec is about.

## Related

- Observation 01 (plan-mode bypass via superpowers) — unrelated, but both surfaced in the same test pass.
- Observation 06 (stop-gate review orphans) — unrelated; included here for completeness of the 2026-04-18 session.
- `src/lib/state.mjs` slug-hash computation.
- `skill/references/config-reference.md` — document to update.
