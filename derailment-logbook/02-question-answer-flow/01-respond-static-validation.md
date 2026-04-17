# 02 / 01 — `respond` validation paths

**Scenarios under test:**
- `Scenario: Respond to nonexistent request shows error`
- `Scenario: Respond without --answer shows error`
- `Scenario: Respond to already-answered request shows error`

---

## [NICE] `PENDING_REQUEST_NOT_FOUND` envelope is well-formed

```
respond req-nonexistent --question-id q1 --answer jwt --json
```
returns exit 3 with:
```json
{"ok":false,"error":{"class":"not_found","code":"PENDING_REQUEST_NOT_FOUND",
  "message":"No pending request found: req-nonexistent.",
  "retryable":false,
  "suggestion":"It may have timed out or already been answered."}}
```
Suggestion text covers both "already answered" and "timed out" in one envelope — matches the Gherkin scenarios for both cases. Keep.

---

## [BROKE] `respond` without `--answer` doesn't emit "requires --answer"

**Trace:** Gherkin `Scenario: Respond without --answer shows error` expects:
> `stderr should contain "requires --answer"`

Actual: when the request-id doesn't exist yet, the CLI short-circuits with `PENDING_REQUEST_NOT_FOUND` before validating `--answer` is present. The missing-answer validator is unreachable from the Gherkin's test setup because the test uses an unknown request id.

**Root cause in skill text:** Either the Gherkin scenario is written against a wrong invocation (should use a real pending req-id) or the validator order in `respond` should check flags before looking up the pending-request store.

**Fix target:** `02-question-answer-flow.feature:93–97` — either rewrite with a real pending request, or accept that `PENDING_REQUEST_NOT_FOUND` precedes `USAGE_ERROR` in this path and update expected stderr.

---

## [GUESSED] Scenarios requiring live questions are unreachable via skill docs alone

Scenarios 13–17 (Single-choice question, Multi-question, CONFIRMED, Question during plan, etc.) require provoking Codex to call `requestUserInput`. Neither SKILL.md nor `references/prompt-writing.md` tells the executor how to *force* that call. The `config.yaml` `prompt_footer` asks Codex to use `requestUserInput`, but in practice Codex's internal skills often route questions via plain text (as SKILL.md acknowledges under "Codex has its own internal skills").

From the perspective of a user testing the question flow, there is no dependable recipe. The realistic path is: run an ambiguous prompt, hope Codex asks, if it asks via text fall back to `send`.

**Fix target:** `references/prompt-writing.md` — add a short "Provoke a question" recipe (e.g. "Tell Codex to ask before picking between two interchangeable libraries"). Or accept that live-question scenarios are best-effort and remove the Background's `Given Codex asks a question via requestUserInput` in favor of `Given a synthetic requestUserInput notification is injected`.
