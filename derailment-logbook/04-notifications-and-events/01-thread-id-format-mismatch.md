# 04 / 01 — Thread IDs are UUIDs, but every doc example uses `thr_abc`

**Scenarios under test:**
- `Scenario: Default task starts in plan mode` — `stdout should contain a thread ID matching "thr_"`
- `Scenario: DONE tag format` — `[DONE] thr_abc completed in {N}s`
- All Gherkin `Given a task is running on thread "thr_abc"` clauses
- `references/ndjson-guide.md` sample record with `"threadId": "thr_abc123"`
- SKILL.md quick-start showing `Thread ID (e.g., thr_abc123)`

---

## [BROKE] `thr_abc*` thread-id placeholder has never been real

**Evidence:** Every session file on disk uses UUID-v7 style:
```
019d9818-423d-7b61-b8cc-764314b41823
019d9a86-1c8a-7f41-8032-6c76bbe730a1
...
```

Node CLI output also emits the bare UUID: `[codex] Thread ready (019d9a86-1c8a-7f41-8032-6c76bbe730a1).` — no `thr_` prefix anywhere.

**Impact:**
- `Scenario: Default task starts in plan mode` asserts `matching "thr_"` — would fail against real output.
- Every `Given a task is running on thread "thr_abc"` in features 01–10 is a placeholder a reader can easily misread as the real shape of thread IDs.
- SKILL.md's "e.g., `thr_abc123`" actively trains executors to pattern-match on a prefix that doesn't exist; a regex-based extractor looking for `thr_[A-Za-z0-9]+` finds nothing and throws.
- `ndjson-guide.md`'s sample record is wrong.

**Root cause in skill text:** The placeholder was used once in one file and copy-pasted. Nobody checked real Codex IDs.

**Fix target:**
- SKILL.md `## Starting a Task` — change "e.g., `thr_abc123`" to "UUID, e.g. `019d9a86-1c8a-7f41-8032-6c76bbe730a1`".
- `references/ndjson-guide.md` sample record.
- Gherkin specs may keep `thr_abc` as a *syntactic* placeholder but should add a one-line note: "thread IDs in practice are UUIDs; `thr_abc` is a readable placeholder."
- `01-task-lifecycle.feature:17` should drop the `matching "thr_"` assertion.

---

## [NICE] Events file `[ERROR] {threadId} failed | {errorCode}` shape is correct

The format helper produces:
```
[ERROR] 019d9a86-... failed | ClientTimeout
  auto-review exceeded 300000ms
  phase: pipeline (completed: diff)
  actions:
    retry: node <abs-path>/codex-bridge.mjs send 019d9a86-... "<revised prompt>"
    log:   node <abs-path>/codex-bridge.mjs result task-mo2n0i8z-cbefzo
    cancel: node <abs-path>/codex-bridge.mjs cancel task-mo2n0i8z-cbefzo
```
Absolute script path ✓, job id on `result`/`cancel` ✓, thread id on `send` ✓. Keep.
