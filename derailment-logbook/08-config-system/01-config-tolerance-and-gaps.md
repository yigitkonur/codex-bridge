# 08 / 01 — Config system behavior

**Scenarios under test:**
- `Scenario: Missing YAML file uses defaults silently`
- `Scenario: Malformed YAML file uses defaults silently`
- `Scenario: mode "default" starts tasks in default mode`
- `Scenario: CLI --effort flag overrides config effort`

---

## [NICE] Missing or malformed YAML is tolerated silently

With `skill/config.yaml` removed — `setup --json` returns `ok:true, ready:true`, exit 0.
With `skill/config.yaml` replaced by `{{INVALID YAML` — same: `ok:true, ready:true`, exit 0.

Matches `config-reference.md` "If the file is missing or malformed, hardcoded defaults are used." ✓

---

## [BROKE] No CLI way to switch mode except editing `config.yaml`

Gherkin `Scenario: mode "default" starts tasks in default mode` says:
> Given config has mode set to "default"
> When I run "codex-bridge task --write 'Some task'"

There is no `--mode` flag on `task`. The only way to exercise this scenario is to edit `skill/config.yaml`. SKILL.md doesn't tell the executor this; `config-reference.md` has examples but doesn't say "this is the only lever for `task`".

**Fix target:**
- Add a `--mode` passthrough to `task` (preferred, small code change), or
- SKILL.md `## Starting a Task` — explicit note: "`task` has no `--mode`; to execute directly, set `mode: default` in `config.yaml` first."

(See `01-task-lifecycle/03-task-cli-surface-checks.md` for the related BROKE on the wasted plan turn.)

---

## [GUESSED] Provider-backed installs never hit the Codex user config model

`setup --json` reports `provider: "codex-lb"` — the test environment routes via a load balancer. Gherkin scenarios `Codex user config inherits model if not overridden` / `YAML model takes precedence over Codex user config` presume a local Codex auth + model setting reachable via `config/read` RPC. In lb-routed environments the RPC may not expose a per-user model; an executor debugging "why isn't my model override working?" has no signal.

**Fix target:** `config-reference.md` model row — add a footnote: "provider-routed installs (`setup.result.auth.provider` = `codex-lb`) do not expose a user-level model; YAML is the only lever."

---

## [NICE] Default config values in `config.yaml` match `config-reference.md` table

Spot-checked: `mode: plan`, `effort: high`, `auto_review: true`, `allow_questions: true`, `session_dir: ~/.codex-bridge/sessions`, `post_task_prompt` matches. Keep in sync — this is a rare place the docs agree with the code.
