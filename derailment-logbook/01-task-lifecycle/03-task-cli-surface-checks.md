# 01 / 03 — `task` CLI surface: validation, missing flag, prompt-file

**Scenarios under test:**
- `Scenario: Task with empty prompt shows error`
- `Scenario: Task accepts file as prompt`
- `Scenario Outline: Valid effort levels are accepted` (negative case)
- `Scenario: Config mode "default" skips plan phase` (command-line shortcut)

---

## [NICE] Validation and usage exit codes match the table

| Invocation | Exit | `error.code` |
|---|---|---|
| `task --json` (no prompt) | 6 | `MISSING_PROMPT` |
| `task --json --effort banana "hi"` | 6 | `INVALID_EFFORT` |
| `task --json --mode default "hi"` | 2 | `USAGE_ERROR` |
| `send --json` (no args) | 2 | `USAGE_ERROR` |
| `bogus-cmd` | 2 | (text error, not JSON) |

Exit codes line up with SKILL.md's exit-code table and `command-reference.md`. The error envelopes are complete (`ok`, `code`, `class`, `message`, `retryable`, sometimes `suggestion`). Keep this.

---

## [BROKE] `task` has no `--mode` flag, yet that is the only way to skip plan mode

**Trace:** I tried `task --json --mode default "hi"` → `USAGE_ERROR: Unknown flag: --mode`. Looking at `command-reference.md` the `task` synopsis is:
```
codex-bridge task [--write] [--effort <level>] [-m <model>] [--prompt-file <path>]
                  [--resume | --resume-last] [--fresh] [--background] [--json] [prompt or file.md]
```
Only `send` has `--mode`. So to start directly in execution mode an executor must:
1. Edit `skill/config.yaml` and flip `mode: "plan"` → `mode: "default"`, then
2. Run `task --write "prompt"`.

This is a multi-step workflow buried in `config-reference.md`, not in the quick-start.

**Root cause in skill text:** SKILL.md's quick-start implies a single command can execute against files; the config gate is invisible. A realistic user who just wants to fix a typo burns one plan turn (~30–60 s) plus any auto-pipeline delay before the first write.

**Fix target:** SKILL.md `## Starting a Task` — add a one-liner: "to skip planning and go straight to execution, either set `mode: default` in `config.yaml` or use `task` ⟶ `send <tid> --mode default` (one extra turn)."

---

## [BROKE] Unknown subcommand outputs plain text, breaking machine parsers

**Trace:** `node … bogus-cmd` prints:
```
Unknown subcommand: bogus-cmd
  → Run `codex-bridge --help` for the list of subcommands.
```
Exit 2. But there is no JSON envelope, even if the agent expected one via `--json` habit. (Though here I didn't pass `--json` — the subcommand parser runs before flag parsing.)

**Impact:** An agent wrapper that always parses stdout as JSON will choke when a typo produces plain text instead of an error envelope.

**Fix target:** Either always emit the standard error envelope on unknown subcommands (preferred), or document in `command-reference.md` "Global flags" that unknown-subcommand errors bypass `--json` formatting.

---

## [GUESSED] `task file.md` is documented ambiguously

**Trace:** SKILL.md example:
```
node … task --write --prompt-file prompt.md
node … task --write "your prompt here"
```
And the synopsis: `task ... [prompt or file.md]`.

There is one line after the second example:
> The positional form takes **text**, not a path; use `--prompt-file` to load from disk.

But the Gherkin `Scenario: Task accepts file as prompt` says:
> `When I run "codex-bridge task --write task-prompt.md"`
> `Then the prompt sent to the app-server should be "Implement OAuth2 flow"`

The scenario contradicts SKILL.md. A naive executor reading only the Gherkin would pass a filename positionally and fail silently (text-literal). Reading SKILL.md first they'd know to use `--prompt-file`.

**Root cause in skill text:** Gherkin spec `01-task-lifecycle.feature:103` is wrong (or documents a feature that was removed). SKILL.md's correction is buried inline.

**Fix target:** Either delete the Gherkin `Scenario: Task accepts file as prompt` (preferred — the behavior doesn't exist) or, if the feature is intended, re-add positional-file detection to `task`.
