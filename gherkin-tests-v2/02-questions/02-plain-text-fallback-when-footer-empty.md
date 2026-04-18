# 02-plain-text-fallback-when-footer-empty

**Derived from:** `src/codex-bridge.mjs:1268-1270` (developer-instruction concatenation of `prompt_footer`), `src/lib/config.mjs` (`prompt_footer` default), `skill/SKILL.md` note "Codex may ask questions via plain text …" (the documented derailment), error code `PENDING_REQUEST_NOT_FOUND` exposed by the `respond` subcommand.
**What this catches:** Pins the *current, documented* failure mode so that a future enforcement change (e.g. the worker detecting plain-text question shapes and synthesizing `[QUESTION]` tags, or the CLI refusing to accept `prompt_footer: ""`) is discovered explicitly and can update this spec. It also asserts the `respond` CLI's error contract when nothing is pending: `ok:false`, `error.code == "PENDING_REQUEST_NOT_FOUND"`, exit code 3 — callers rely on that exit code to distinguish "no question outstanding" from other respond failures.
**Runtime cost:** medium (one real Codex turn to surface the plain-text question; 20–60 s)
**Test subject:** single-page HTML site with hero, feature list, and footer

## Feature: empty `prompt_footer` lets Codex fall back to plain-text questions; `respond` errors cleanly

### Background

Given Codex CLI installed and authenticated
And the following is defined in the test shell:
  ```sh
  REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
  ```
And `npm run build` has been run since the last `src/` edit
And resolved config is `prompt_footer: ""`, `allow_questions: true`, `mode: default`, `auto_review: false`
And `cwd = $TMPDIR/html-site` is a clean git repo

### Scenario: Codex asks in plain text — no `[QUESTION]` tag, respond errors out

Given the workspace above
When I run `bridge task --write --json "build a one-page HTML site with a hero, feature list, and footer, with a theme; if the spec is ambiguous, ask me"`
Then the envelope returns `ok == true`
And `result.phase` is one of `"done"` or `"incomplete"`
And `{TID}.events` does **not** contain any line starting with `[QUESTION] `
And `{TID}.pending.json` does **not** exist at any point during the turn
And the last `ITEM_COMPLETED` row for `kind == "agent_message"` in `{TID}.ndjson` has `data.text` containing a sentence ending in `?`

When I then run `bridge respond req-fake --answer "anything" --json`
Then stdout parses as a JSON envelope with `ok == false`
And `error.code == "PENDING_REQUEST_NOT_FOUND"`
And the process exit code is `3`

### Pass / fail predicate

```sh
# Codex answered in plain text, no tool-based question was ever surfaced
! grep -q '^\[QUESTION\] ' "$TID.events" \
  && test ! -f "$TID.pending.json" \
  && jq -e '.ok == true and (.result.phase | IN("done","incomplete"))' task.json \
  && jq -se 'map(select(.tag=="ITEM_COMPLETED" and .data.kind=="agent_message"))
             | last.data.text | test("\\?")' "$TID.ndjson"

# respond with no pending request yields the documented error contract
bridge respond req-fake --answer "anything" --json > respond.json
RC=$?
jq -e '.ok == false and .error.code == "PENDING_REQUEST_NOT_FOUND"' respond.json \
  && test "$RC" = "3"
```

### Enhancement candidates

This is the documented derailment — the spec exists precisely so that if someone adds enforcement (strips plain-text questions and forces `requestUserInput`, or detects question-shaped assistant text and synthesizes a `[QUESTION]` tag retroactively), the behavior change is caught by the `! grep -q '^\[QUESTION\] '` assertion and the spec can be updated in the same PR. It also catches a subtler regression: if someone ever has `respond` exit 0 with a soft warning when no pending file exists, the `RC == 3` check fails and protects the error contract callers depend on.
