# 08 — `adversarial-review` writes no session artifacts for its own thread

**Observed:** 2026-04-18 during retest (same session as obs 07).
**Codex version:** `codex-cli 0.104.0`
**Bridge bundle:** `skill/scripts/codex-bridge.mjs` @ `7d224ea`.

## What happened

Launched `adversarial-review` against a dirty working tree:

```sh
cd /tmp/cbtest-retest.nVz080
echo "<!-- XSS test: <img src=x onerror=alert(1)> -->" >> index.html
bridge adversarial-review --scope working-tree --json "check for XSS risks"
```

The command completed with `ok:true` and a well-formed envelope — `result.threadId: 019da12a-d04d-7692-ae1c-826ba8b2fbdd`, `result.findings: []` (no findings, which is correct: a comment like `<!-- ... -->` doesn't actually expose XSS; the reviewer correctly refused to hallucinate).

But checking `~/.codex-bridge/sessions/`:

```sh
ls ~/.codex-bridge/sessions/019da12a-*
# ls: no matches
```

**Zero session artifacts were created for the review thread.** No `.events`, no `.ndjson`, no `.diff`, no `.plan.md`, no `.review.json`.

## Why this is a derailment

Several specs and references implicitly assume that every thread produces session artifacts:

1. **`skill/references/ndjson-guide.md`** tells users to tail `~/.codex-bridge/sessions/{threadId}.ndjson` for retrospective analysis. For review threads this path always 404s.

2. **`gherkin-tests-v2/06-artifacts/03-review-json-is-phantom-file.md`** asserts that `.review.json` is not written for review commands. That's correct (and this retest confirms `writeReview` is still uncalled), but the *absence of any artifact at all* — including `.events` and `.ndjson` — is a stronger statement: review threads are **completely opaque** to session-log tooling.

3. **`bridge summary <thread-id>`** works off `.ndjson`. Passing a review-thread id produces `SESSION_NOT_FOUND` (exit 3). The user has no way to retrospectively inspect what the review turn actually looked at.

4. **Monitor tool workflows** documented in `skill/references/monitor-patterns.md` — "tail `$EVENTS` for `[DONE]`" — can never apply to review commands. Reviews return synchronously via the envelope only.

## Root cause (hypothesis, not verified)

The `review` and `adversarial-review` handlers in `src/codex-bridge.mjs` call `runAppServerReview(cwd, {...})` directly rather than going through `runBridgeTask`, which is the code path that calls `initSession(sessionDir, threadId)` before the turn starts. Because `initSession` is where `.events` and `.ndjson` files are first opened for appending (`session-log.mjs:16-17`), bypassing it means no files are ever created.

The intent may have been: "reviews are short-lived, they return findings synchronously, session artifacts are overkill." But that removes the one-way bridge from review threads into the rest of the skill's tooling.

## Suggested fixes (not implemented here)

1. **Call `initSession` in the review handler too.** One line. Gives `.events` and `.ndjson` presence for every review turn. Users can then `bridge summary <review-thread-id>`, `bridge events <review-thread-id> --follow`, and see what the reviewer did.

2. **Write the envelope's `findings` array to `{threadId}.review.json` via `writeReview`.** This is the phantom function documented in obs 03 and `gherkin-tests-v2/06-artifacts/03-review-json-is-phantom-file.md`. Calling it from the review handler would make `.review.json` no longer phantom AND give users a canonical on-disk store of the findings shape. The filename is already reserved; just nobody writes it.

3. **Document the opacity in `skill/references/command-reference.md`.** If (1) and (2) aren't adopted, at minimum SKILL.md should note: "Review commands do not produce session artifacts. Use the `--json` envelope as the canonical record."

## Effect on specs

- `gherkin-tests-v2/06-artifacts/03-review-json-is-phantom-file.md` can be strengthened: the invariant isn't just "`.review.json` doesn't exist" but "no session artifacts of any kind exist for a review-only thread." A new scenario asserting `ls $SESSION_DIR/$REVIEW_TID* 2>&1 | grep "No such"` would capture the full surface.
- `gherkin-tests-v2/08-review-and-resume/01-adversarial-review-structured-findings.md` works correctly as written — it only asserts envelope shape, which passes. But it could add a note: "this scenario does NOT exercise session-log artifacts because review threads don't produce them."

## Related

- Observation 03 — `writeReview` is a phantom (this observation explains *why* — the function exists for a call path that isn't wired).
- Observation 07 — both surfaced in the same retest pass and both point at hidden state a user would expect to find surfaced.
- `skill/references/ndjson-guide.md` — needs a callout for the review exception.
