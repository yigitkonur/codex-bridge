# 02-allow-questions-flag-not-enforced

**Derived from:** `src/lib/config.mjs:18` (`DEFAULT_CONFIG.allow_questions: true` — the only reference to `allow_questions` in the entire `src/` tree; confirmed by grep), `src/codex-bridge.mjs:1317-1361` `runBridgeTask` `onServerRequest` handler (accepts `item/tool/requestUserInput` unconditionally with no `config.allow_questions` check). A grep for `allow_questions` across `src/` returns only the config default definition and the doc copy in `src/lib/AGENTS.md` — no read site before the `[QUESTION]` notification is emitted or before `item/tool/requestUserInput` is accepted.
**What this catches:** The dead-config-key ambiguity: `allow_questions: false` is advertised to users via `skill/config.yaml` and `skill/references/config-reference.md` but has no enforcement, so users setting it to `false` still see `[QUESTION]` events and still have their turn blocked waiting for `respond`. This contract documents the *current* broken behavior so the tripwire fires when someone finally wires the flag up — at which point the fix commit must also update the schema, the reference doc, and this file together.
**Runtime cost:** medium
**Test subject:** single-page HTML site (chosen so that question provocation is plausible via an ambiguous prompt like "pick a color scheme")

## Feature: allow_questions: false does not suppress [QUESTION] (known bug)

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given `bridge()` is defined as above (see "Which binary the specs target" in AGENTS.md — the function form is required for bash and zsh portability)
And `npm run build` has been run since the last `src/` edit
And `config.yaml` resolves with `codex_bridge.allow_questions: false`
And `codex_bridge.prompt_footer` is left at the default (which instructs Codex to prefer `request_user_input`)
And `cwd` is a clean git repo
And the task prompt is intentionally ambiguous: "build a single-page HTML site with a hero, a feature list, and a footer — pick the color palette"

### Scenario: flag is ignored; question is emitted and blocks the turn

Given the user runs `bridge task --write --json "build a single-page HTML site … pick the color palette"`
When Codex emits `item/tool/requestUserInput` during the turn
Then the `onServerRequest` handler accepts the request without consulting `config.allow_questions`
And `.events` contains at least one line starting with `[QUESTION]`
And `.ndjson` contains a `QUESTION` record with the `itemId` matching the tool-call id
And a `{threadId}.pending.json` file is written under the session dir
And the CLI blocks (worker polls `waitForResponse` up to 5 minutes) just as it would with `allow_questions: true`

### Scenario: envelope does not surface the flag as rejected

Given the same invocation
When the envelope is inspected after the user answers via `bridge respond`
Then `result` contains no `warnings[]` entry mentioning `allow_questions`
And `result` contains no `errors[]` entry mentioning `allow_questions`
And no `[CONFIG_IGNORED]` tag exists in `.events`

### Pass / fail predicate

```sh
# Static verification (sub-second, no Codex required):
# allow_questions must appear ONLY as a DEFAULT_CONFIG key — never in a gating branch.
SRC_ROOT="$(git rev-parse --show-toplevel)/src"
MATCHES=$(grep -rn 'allow_questions' "$SRC_ROOT")
echo "$MATCHES"
# Expected: exactly two lines —
#   src/lib/config.mjs:18:  allow_questions: true,
#   src/lib/AGENTS.md:288:  allow_questions: true,   (doc copy in the config cluster)
# Any additional match in runBridgeTask, onServerRequest, or any condition block = bug is FIXED.
echo "$MATCHES" | grep -v -E '(config\.mjs|AGENTS\.md)' && echo "WARN: allow_questions referenced in logic — spec needs updating" || echo "PASS: flag is dead (not enforced)"

# Runtime verification (requires Codex + ambiguous prompt):
EVENTS=~/.codex-bridge/sessions/${TID}.events
grep -q '^\[QUESTION\]' "$EVENTS" \
  && test -f ~/.codex-bridge/sessions/${TID}.pending.json \
  && ! grep -q -i 'allow_questions' "$EVENTS"
```

(When the bug is fixed, the static check will emit "WARN", the first `grep -q '^\[QUESTION\]'` flips to `! grep -q '^\[QUESTION\]'`, and the `pending.json` check flips to `! test -f` — those are the intentional breakages that signal the fix commit landed.)

### Enhancement candidates

- **Fix option A (suppress):** in `runBridgeTask`'s `onServerRequest` handler (`src/codex-bridge.mjs:1317-1361`), when `config.allow_questions === false`, immediately reply with `error: { code: -32601, message: "User questions are disabled by config" }` and skip the `[QUESTION]` emission. Update this Gherkin to assert the reverse.
- **Fix option B (remove):** delete the `allow_questions` key from `DEFAULT_CONFIG`, `skill/config.yaml`, and `skill/references/config-reference.md`. Replace this contract with a regression test asserting the key is absent from the published skill.
- **Fix option C (dynamic footer):** when `allow_questions: false`, swap the default `prompt_footer` for a phrase like "Do not ask questions; make reasonable assumptions." This avoids rejecting `requestUserInput` at the RPC layer but discourages the model from issuing one. Weakest fix — observable behavior still depends on model compliance.
- Add a `bridge setup --json` step that warns when `allow_questions: false` is set, until the flag is either wired up or removed. That surfaces the dead key to users without requiring a full schema migration.
