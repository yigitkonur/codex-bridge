# test-gherkin/AGENTS.md

Behavioral specifications in Gherkin format. **Not executable tests.** There is no test runner in `package.json`; no `cucumber-js`, `vitest-cucumber`, or similar dependency is installed. These files are the source of truth for expected CLI behavior and are verified by reading them alongside code changes.

Root rules live in `/AGENTS.md`. This file covers conventions specific to authoring and maintaining the specs.

## Files

Numeric prefix sets reading order. Every feature is phrased in imperative terms from the perspective of Claude Code orchestrating the bridge.

| File | Scope |
|---|---|
| `01-task-lifecycle.feature` | Plan → approve → execute → done; mode overrides; session file creation; follow-ups. |
| `02-question-answer-flow.feature` | `requestUserInput` handling; `[QUESTION]` / `[CONFIRMED]`; multi-question payloads; answer routing via `respond`. |
| `03-auto-pipeline.feature` | Silent review, fix, completion-check stages; pipeline progress tags; disable flags. |
| `04-notifications-and-events.feature` | Tag structure; NDJSON vs events file; file paths; action commands. |
| `05-timeout-and-stuck-detection.feature` | Timeout thresholds; stuck task detection; cancel; heartbeat monitoring. |
| `06-error-classification.feature` | Error types; recovery suggestions per `codexErrorInfo` variant. |
| `07-cli-commands.feature` | Every subcommand (task, send, steer, respond, review, adversarial-review, status, result, cancel, setup). |
| `08-config-system.feature` | YAML parsing; defaults; precedence; per-task overrides. |
| `09-session-logging.feature` | NDJSON ordering, timestamps, retroactive querying. |
| `10-protocol-compliance.feature` | JSON-RPC framing, error codes, notification dispatch, idempotency, socket lifecycle. |

## Gherkin conventions used here

- `Feature:` — one line per file.
- `As Claude Code orchestrating a Codex task, I need <outcome>, so that <value>.` — role-goal-benefit block at the top.
- `Background:` — common preconditions (CLI available, app-server running, session dir exists, default config).
- `Scenario:` — concrete test case.
- `Scenario Outline:` — parameterized, with `Examples:` table. Used for effort-level matrices and notification tag permutations.
- `Given` / `When` / `Then` / `And` / `But` — standard.
- Inline strings use double quotes. File paths use backticks.

## Synchronization rules

Specs reference concrete artifacts that must stay in sync:

- **Event tags**: `[PLAN]`, `[QUESTION]`, `[CONFIRMED]`, `[PIPELINE:diff|review|fix|check]`, `[DONE]`, `[INCOMPLETE]`, `[ERROR]`, `[REVIEW]`. Defined in `src/lib/session-log.mjs` format helpers. Any rename breaks every scenario that matches on them.
- **Config keys**: `mode`, `effort`, `auto_review`, `post_task_prompt`, `allow_questions`, `session_dir`, `prompt_footer`, `model`. Defined in `src/lib/config.mjs::DEFAULT_CONFIG`.
- **Turn parameters**: `collaborationMode`, `sandboxPolicy`, `reasoning effort`, `outputSchema`. Upstream contract; scenarios assert they're set correctly per mode.
- **Reasoning effort levels**: `none | minimal | low | medium | high | xhigh`. Enum in `src/codex-bridge.mjs::VALID_REASONING_EFFORTS`.
- **Exit codes**: `0` success, non-zero on error. Scenarios assert specific values.

When code in those surfaces changes, update the matching scenarios in the same change.

## Authoring rules

1. **Write `Given/When/Then` as observable facts about the CLI, not implementation details.** Prefer "the events file contains a `[PLAN]` tag" over "the session-log module calls formatPlanEvent".
2. **Numbered scenarios, not tagged.** No `@slow` / `@wip` tags; if a scenario isn't ready to pass, leave it out until it does.
3. **Keep scenarios small.** One concept per scenario. A scenario that sets up a thread, approves a plan, reviews the diff, and fixes findings should be four scenarios sharing a `Background`.
4. **Use `Scenario Outline` for enum matrices.** Effort levels, notification tags, config precedence — anywhere a table is clearer than repetition.
5. **Don't invent new verbs.** Every `When I run "..."` should be a real CLI invocation with a real exit code and a real events-file effect.
6. **Quote file paths and thread ids as literals when they're arbitrary placeholders.** `"thr_abc"` is fine; `{threadId}` is fine in spec text where it's clearly a placeholder.

## When adding a subcommand, flag, tag, or config key

Always update `07-cli-commands.feature` for subcommands and flags, `04-notifications-and-events.feature` for new tags, `08-config-system.feature` for new config keys, and whichever lifecycle/pipeline feature is affected. A code change that ships without a matching scenario is a half-landed feature.

## What doesn't belong here

- Unit-level assertions about internal state that isn't observable via the CLI.
- Environment-specific behavior (e.g., "on macOS with FileVault"). Scenarios must be portable; platform differences that matter belong in `src/` code with a fallback.
- Flaky timing assumptions. Timeout scenarios should assert threshold behavior (`> 600 s`), not exact wall clock timing.
