# 10 / 01 — Protocol-compliance spot checks

**Scenarios under test:** mostly non-observable from the CLI surface — verified by reading the source.

---

## [NICE] `ClientInfo.name: "codex_bridge"` and `experimentalApi: true`

Grep of `src/lib/app-server.mjs:25,31` confirms:
```js
name: "codex_bridge",
experimentalApi: true,
```
Matches `Scenario: Initialize uses experimentalApi true` and the AGENTS.md invariant. Keep untouched — `AGENTS.md:6` warns this name is load-bearing for the upstream HTTP `originator` header.

---

## [GUESSED] "TODO: plan ambiguity" is still in the Gherkin

`10-protocol-compliance.feature:147–154` `Scenario: Completion check uses outputSchema for structured response` includes an in-spec TODO:

```
# TODO: plan ambiguity — the auto-pipeline plan mentions outputSchema
# for structured JSON { complete: boolean, missing_items: string[] }
# but the implementation details show heuristic text parsing instead.
```

The actual `src/lib/auto-pipeline.mjs` around line 200 parses the completion-check turn's `finalMessage` as JSON with a fallback to `complete: true` (see earlier PR fix). So the spec's "best interpretation" is half-true: JSON is attempted, text is fallback.

**Fix target:** Rewrite the Gherkin scenario without the TODO — either drop the `outputSchema` reference if no schema is sent, or verify the schema is attached on the turn/start payload. Reading `runReviewTurn` or `runCompletionCheckTurn` in `src/lib/auto-pipeline.mjs` to confirm is the next step.

---

## [GUESSED] Wire-level scenarios (thread/start, turn/start, turn/steer, turn/interrupt) are not agent-verifiable

Most of feature 10 requires logging the actual bytes sent over the unix socket. There is no documented way for a skill user or Claude Code agent to enable JSON-RPC wire logging. `src/lib/AGENTS.md` mentions the protocol but no debug flag exposes it.

**Fix target:** `references/command-reference.md` or a new section in SKILL.md "Debug" should expose an env var like `CODEX_BRIDGE_DEBUG_RPC=1` to tee the wire traffic to a file; otherwise these scenarios can only be verified by modifying source. If this is intentional, document it as such.
