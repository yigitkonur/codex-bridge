# 07 / 01 — `send <not-a-uuid>` crashes to exit 1 with a raw Codex lib error

**Scenarios under test:**
- `Scenario: send with invalid mode shows error`
- `Scenario: send to nonexistent thread shows error`
- Every Gherkin `Given a task produced a "[PLAN]" notification on thread "thr_abc"`

---

## [BROKE] `send thr_abc …` produces exit 1 `INTERNAL_ERROR`

Invocation (exactly as shown in SKILL.md, command-reference.md, and several Gherkin scenarios):
```
node skill/scripts/codex-bridge.mjs send thr_abc --mode execute 'Go' --json
```

Actual envelope:
```json
{
  "ok": false,
  "error": {
    "class": "internal",
    "code": "INTERNAL_ERROR",
    "message": "invalid thread id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `t` at 1",
    "retryable": false
  },
  "command": "send"
}
```
Exit **1**. Two defects:

1. **Input validation order is wrong.** The `--mode execute` validation (which should produce `USAGE_ERROR` exit 2) never runs because thread-id parsing fails first and *crashes to internal*.
2. **UUID parsing failure is reported as `internal`.** This is a user-supplied input error; it should be `validation` exit 6 with a human-readable message like `"invalid thread id: expected UUID (e.g. 019d9a86-1c8a-7f41-…)"`.

Combined with feature 04/01's finding (thread IDs are UUIDs, not `thr_abc`), every Gherkin scenario that reads:

> `When I run "codex-bridge send thr_abc --mode default 'Implement the plan.'"`

would CRASH in practice. The scenarios encode a hardwired test-id that real `send` rejects.

**Fix target:**
1. `src/codex-bridge.mjs::handleSend` — wrap the thread-id parse in a try/catch that maps to `INVALID_THREAD_ID` / `validation` / exit 6, with a suggestion string.
2. Validate `--mode` (must be `plan|default`) before attempting any UUID parse.
3. SKILL.md `## Responding to Events` — replace `thr_abc` placeholders with realistic UUIDs or explicit `<threadId>` tokens.
4. Consider updating Gherkin to use UUIDs or documenting `thr_abc` strictly as an unreal placeholder.

---

## [BROKE] `--wait` flag on `task` does not exist

Gherkin `Scenario: task with --wait runs synchronously` drives:
```
codex-bridge task --write --wait 'Quick fix'
```

Real behavior: exit 2 `USAGE_ERROR: Unknown flag: --wait`.

`task --json` already blocks synchronously by default; `--background` opts out of that. The `--wait` flag was never added. The Gherkin scenario is aspirational.

**Fix target:** Delete the Gherkin scenario, OR rename to use `--json` (which already is sync). `command-reference.md` correctly omits `--wait`.

---

## [BROKE] `review` (default scope) runs a full billed Codex turn with no cap

I invoked `codex-bridge review --json` expecting the default `--scope auto` to be a quick diff-only probe. Instead the CLI immediately starts a billed reviewer turn (`review-...` job). If there are no local changes the turn still runs against "Review working tree diff" (which is empty), wasting tokens.

**Fix target:** `command-reference.md` should mark `review` as expensive, or `review` should short-circuit when `git diff` is empty. Right now the docs make `review` look cheap.

---

## [NICE] Missing-arg error envelopes are clean

| Invocation | Exit | code |
|---|---|---|
| `send thr_abc --json` (no prompt) | 6 | `MISSING_PROMPT` |
| `steer` | 2 | `USAGE_ERROR` (*"requires <thread-id> <turn-id> <prompt...>"*) |
| `steer thr_abc` | 2 | `USAGE_ERROR` |
| `summary` | 2 | `USAGE_ERROR` |
| `summary thr_nonexistent` | 3 | `SESSION_NOT_FOUND` |
| `respond` | 2 | `USAGE_ERROR` |

Consistent classes, stable codes. Keep.

---

## [GUESSED] `task-resume-candidate` returns cancelled jobs as "available"

With a single cancelled task as the latest in this session, `task-resume-candidate --json` returned `available: true` and proposed it as the resumable. Resuming a cancelled thread likely fails; the candidate should filter by `status: "completed"`.

**Fix target:** `src/codex-bridge.mjs::handleTaskResumeCandidate` — exclude terminal non-completed statuses. Or at least document that cancelled/failed candidates are still returned and the caller must gate.

---

## [GUESSED] `summary` on empty NDJSON returns `entries: []` not "No events recorded"

Gherkin `Scenario: summary for empty NDJSON shows message` expects stdout to contain `"No events recorded"`. `--json` mode returns `{entries: []}` with no such string. Plain mode may differ.

**Fix target:** Either emit a sentinel `No events recorded` in the plain path (keep `--json` as `entries: []`), and update the Gherkin to scope itself to plain mode.
