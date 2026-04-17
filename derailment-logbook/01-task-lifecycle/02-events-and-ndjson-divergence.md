# 01 / 02 — Events file [ERROR] vs sync envelope `ok:true`

**Scenario under test:** `Scenario: NDJSON file logs every app-server notification` + `Scenario: Execution completes with DONE notification`.

**Artifacts inspected:**
- `~/.codex-bridge/sessions/019d9a86-1c8a-7f41-8032-6c76bbe730a1.events`
- `~/.codex-bridge/sessions/019d9a86-1c8a-7f41-8032-6c76bbe730a1.ndjson`

---

## [BROKE] Events file emits `[ERROR]` while the sync envelope returns `ok:true`

The events stream (what Monitor consumes) contains:
```
[PIPELINE:diff] 08:22:14
[PIPELINE:review] 08:22:14
[ERROR] 019d9a86-... failed | ClientTimeout
  auto-review exceeded 300000ms
  phase: pipeline (completed: diff)
```

The sync `task --json` call returned:
```json
{"ok": true, "result": {"phase": "incomplete", "pipeline": {"error": "auto-review exceeded 300000ms"}}}
```

A Monitor reading the events file self-terminates on `[ERROR]` and concludes the task failed. The caller of the sync CLI, reading stdout, concludes the task succeeded-with-gaps. Two concurrent observers of the same run reach contradictory conclusions.

**Root cause in skill text:** `references/notification-format.md` defines `[ERROR]` as the terminal-failure tag. `references/monitor-patterns.md` tells you to break on `[ERROR]`. Neither file mentions that a pipeline sub-stage timeout emits `[ERROR]` *without* the task actually failing. The SKILL.md exit-code table says exit 7 = transient; but this run exited 0.

**Fix target:** `references/notification-format.md` `[ERROR]` block — document that an auto-pipeline sub-stage failure emits `[ERROR]` while the main task may still be classified as successful/incomplete. Either rename the pipeline-failure tag (e.g. `[PIPELINE:error]`) or warn the reader.

---

## [BROKE] NDJSON misses `thread/started`, `turn/started`, `item/completed`

Gherkin `Scenario: NDJSON file logs every app-server notification` expects `thread/started`, `turn/started`, `item/completed`, `turn/completed` in chronological order.

Actual NDJSON has 4 entries, none of which are `thread/started`, `turn/started`, or `item/completed`:
```
TURN_COMPLETED   turn/completed
PIPELINE_STAGE   (null)  diff
PIPELINE_STAGE   (null)  review
PIPELINE_ERROR   (null)
```

Earlier notifications are not landing in NDJSON. `references/ndjson-guide.md` cannot be trusted for scenarios that require reconstructing per-turn history.

**Root cause in skill text:** `references/ndjson-guide.md` claims NDJSON is the full structured log. It is not — it only records a curated subset of tags (mostly lifecycle end-states and pipeline stages). An executor running a `jq` recipe to replay the turn history gets empty results.

**Fix target:** Rewrite `references/ndjson-guide.md` opening paragraph to be honest about coverage: NDJSON captures terminal tags + pipeline events, not every wire-level notification. The Gherkin `09-session-logging.feature` also needs a rewrite or the writer needs to actually log every notification.

---

## [GUESSED] Plan mode expected to produce `{threadId}.plan.md`; zero bytes were written

`SKILL.md` ⟶ "Session Files" says `{threadId}.plan.md` is created "if plan mode". My run was plan mode but no `.plan.md` exists on disk — only `.events`, `.ndjson`, and an empty `.diff`. Because Codex's internal skills routed around `item/completed{ type: "plan" }`, no plan item was written.

**Fix target:** SKILL.md `## Session Files` — clarify that `.plan.md` is written only when Codex emits a typed plan item, which its internal `brainstorming`/`writing-plans` skills frequently bypass.
