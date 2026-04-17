# 01 / 01 — Default task in plan mode (sync call)

**Scenario under test:** `Scenario: Default task starts in plan mode` + `Scenario: Task accepts inline text prompt`.

**Setup:** `.tmp/mini-site/` (static HTML/CSS/JS todo).

**Command exactly as SKILL.md suggests:**
```
node skill/scripts/codex-bridge.mjs task --json -C .tmp/mini-site \
  "Add a delete button next to each todo item so users can remove tasks. \
   Update index.html, app.js, and style.css as needed. Keep it simple."
```

**Observed:** exit 0, `result.phase: "incomplete"`, `result.status: 0` (inside result), `meta.duration_ms: 461767`, `result.touchedFiles: []`, `result.pipeline.error: "auto-review exceeded 300000ms"`.

Codex spent ~7 min trying and failing: `apply_patch` / `morph/edit_file` / shell write all rejected because the plan-mode sandbox is `readOnly`. The assistant message ended up being a dump of file contents the user was expected to apply by hand.

---

## [BROKE] `--write` on `task` does NOT enable writes when config `mode: "plan"`

**Trace:** I invoked `task --write`. The turn was still sent with `sandboxPolicy: readOnly`. Codex kept trying to write and got rejected. Eventually the model gave up and emitted raw file contents.

**Root cause in skill text:** SKILL.md "Starting a Task" shows `task --write "..."` as the canonical entry and never notes that write access is gated by *execution mode*, not by the `--write` flag. The flag only matters once the plan is approved via `send --mode default`. Plan mode is hard-coded to `readOnly` (see `src/lib/config.mjs::buildSandboxPolicy`).

**Impact:** First-time user burns an expensive 7-minute billed turn while Codex pinballs against a read-only sandbox. The sync envelope reports `ok:true` even though nothing was written — exit 0 looks like success.

**Fix target:** SKILL.md `## Starting a Task`, and `references/command-reference.md` `## task`.

---

## [BROKE] Sync `task --json` can block 5× longer than advertised, silently

**Trace:** The call blocked for 461 s. The job itself "completed" after ~8 min (Codex turn + a full 300 s auto-review stall). The CLI kept the sync call open until the pipeline hit its internal 300 s timeout.

**Root cause in skill text:** SKILL.md "Quick Start" frames sync as "one call, the envelope tells you what's next" and reserves async for "long tasks". Nothing warns that the **sync path includes the auto-pipeline**, so even a short turn becomes a 5–8 min block when `auto_review: true` (the default). The `## How It Works` bullet on the auto-pipeline doesn't connect to the sync path.

**Impact:** Executors following the quick-start example get a multi-minute stall on trivial prompts. No progress events reach them because sync doesn't emit to `.events` in a consumable way for the caller.

**Fix target:** SKILL.md `## Quick Start` needs a one-liner: "sync blocks through the auto-pipeline; disable `auto_review` or use async+Monitor for interactive tasks."

---

## [GUESSED] `next_action.command` uses unqualified `codex-bridge`, not the real invocation

**Trace:** Envelope returned:
```json
"next_action": {
  "command": "codex-bridge send 019d9a86-... \"Complete the missing items\""
}
```
The SKILL.md quick-start uses `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs ...`. There is no `codex-bridge` binary on PATH in a normal skill install. A naive executor pasting `next_action.command` into a shell gets `command not found`.

**Root cause in skill text:** `references/command-reference.md` writes every synopsis as `codex-bridge <sub>` without explaining that `codex-bridge` is shorthand for `node <scriptPath>`. SKILL.md's envelope section doesn't flag that the shorthand must be rewritten.

**Fix target:** SKILL.md envelope block (around the exit-code table) — add one sentence: "`next_action.command` is printed as `codex-bridge <sub> …`; substitute `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs` for the `codex-bridge` prefix before shell execution."

---

## [GUESSED] `phase: "incomplete"` with no edits is indistinguishable from a stuck plan

**Trace:** The Gherkin `Scenario: Plan produced triggers PLAN notification` expects `[PLAN]` + `{threadId}.plan.md`. Real behavior: Codex skipped formal planning (its own `brainstorming`/`writing-plans` skills took over) and the turn completed with `result.phase: "incomplete"` and `touchedFiles: []`.

The skill docs describe the "Codex skips planning" fallback in `references/orchestration-flows.md`, but they frame it as landing in `[DONE]`. In reality sync returns `phase: incomplete`. Executor has to guess whether to:
- re-run with `--mode default` (if they realize plan-mode is the culprit), or
- follow `next_action.command` (which asks Codex to "Complete the missing items" on the same read-only thread — a dead end).

**Root cause in skill text:** SKILL.md `## How It Works` ⟶ "Codex has its own internal skills" is correct but mislocated: it only mentions the `[DONE]` landing. `orchestration-flows.md`'s "Codex Skips Planning" block also only documents `[DONE]`.

**Fix target:** SKILL.md and `orchestration-flows.md`: when Codex skips planning *in plan mode*, the sync envelope is `phase:"incomplete"` and `next_action` is misleading — the right recovery is `send --mode default`.

---

## [NICE] `result.phase` + `result.next_action` pattern

The envelope DID tell me what the next step was supposed to be (`send ... "Complete the missing items"`). That scaffolding is load-bearing — keep it. It just needs a path prefix and a "may be wrong if phase is unexpected" caveat.

---

## [NICE] `status <job-id> --json` gives instant state

Polling `status task-mo2n0i8z-cbefzo --json` returned accurate `phase`/`status`/`elapsed` every time. The `references/monitor-patterns.md` "Preset D: Custom Polling" snippet used this correctly. Keep it.
