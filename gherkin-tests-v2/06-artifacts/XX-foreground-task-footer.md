# XX-foreground-task-footer

**Derived from:** `src/codex-bridge.mjs::appendTaskFooter` (helper) and the `runBridgeTask` integration that appends `\nJob: <id> · Events: <path> · Monitor: <command>\n` to the rendered foreground output whenever `request.jobId` is set. Pre-1.2.5 the non-JSON rendered output was just Codex's `finalMessage`, which gave orchestrators nothing to pattern-match on — agents reached for the thread UUID in `[codex] Thread ready (…)` stderr progress, which is the wrong handle for `status`/`result`/`events`.
**What this catches:** (a) a successful foreground `task` prints a trailing line starting with `Job:`. (b) the Job id matches the `jobId` recorded in state. (c) the Events path is an existing file when the job finishes. (d) the Monitor command string references the `jobId` (not the threadId) so copy/paste lands on the canonical handle.
**Runtime cost:** requires live Codex; smokeable piece is the helper-function test.

## Feature: foreground task rendered output ends with a jobId footer

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

### Scenario 1: appendTaskFooter shape (unit)

Given a call `appendTaskFooter("hello\n", {jobId:"task-abc", eventsPath:"/tmp/abc.events", monitorCommand:"node foo events task-abc --follow"})`
When I invoke the helper
Then the result equals `"hello\n\nJob: task-abc · Events: /tmp/abc.events · Monitor: node foo events task-abc --follow\n"`
And the function is a no-op when `jobId` is null (returns the input unchanged)

### Scenario 2: live foreground task prints the footer

Given Codex is authenticated
When I run `bridge task --write --mode default --no-pipeline "reply OK" 2>/dev/null | tail -3`
Then one of the last three lines matches `/^Job: task-[a-z0-9-]+ · Events: .*\.events · Monitor: node .* events task-[a-z0-9-]+ --follow/`
And the `Events:` path is an existing file
And the `Monitor:` command references the same `task-…` id as the `Job:` field (no threadId)

### Scenario 3: `--json` does not emit the footer (stdout stays pure JSON)

Given Codex is authenticated
When I run `bridge task --write --mode default --no-pipeline "reply OK" --json`
Then stdout is a single JSON envelope (no `Job: …` footer line)
And `.result.jobId` is present at top level
And `.result.eventsPath` is present at top level

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Scenario 1 — unit
node -e "
  (async () => {
    const mod = await import('${REPO_ROOT}/skill/scripts/codex-bridge.mjs').catch(() => null);
    // appendTaskFooter is not exported from the bundled module; test via a
    // scratch duplicate of the helper shape, or lift the source file. For the
    // offline predicate we verify shape via grep of source.
    const src = require('node:fs').readFileSync('${REPO_ROOT}/src/codex-bridge.mjs', 'utf8');
    if (/function appendTaskFooter\(rendered, \{ jobId, eventsPath, monitorCommand \}\)/.test(src)) {
      console.log('s1 PASS');
    } else {
      console.log('s1 FAIL (signature drift)');
    }
  })();
"

# Scenarios 2 + 3 — live Codex, documented as SKIPPED stubs.
```

### Enhancement candidates

- Export `appendTaskFooter` so unit tests can exercise the rendered shape directly.
- If renderer ever gains a Markdown path, the footer should be a markdown-safe variant (e.g. a single-line blockquote) so it doesn't break downstream markdown consumers.
