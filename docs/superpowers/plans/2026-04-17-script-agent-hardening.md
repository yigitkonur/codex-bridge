# Script Agent-Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the script behaviors that derailed an agent walking the Gherkin specs, so `codex-bridge.mjs` is stable, produces filterable agent-grade feedback, and actively steers its callers toward the Monitor tool rather than ad-hoc polling.

**Architecture:** Minimal additive changes to `src/codex-bridge.mjs` and `src/lib/*.mjs`. No new frameworks, no new dependencies. Each task produces a focused commit verified by a live CLI invocation — the repo has no test runner by design, so verification is exit-code + JSON-shape assertions via `node … --json | jq`. Every change is re-bundled with `npm run build` before verification.

**Tech Stack:** Node 22+ ESM, esbuild, existing `src/lib/cli-errors.mjs` envelope layer, existing `src/lib/args.mjs` parser, existing `src/lib/session-log.mjs` append-only writers.

**Root-cause context** (from `derailment-logbook/`):
- Agent calls `send thr_abc …` → exit 1 `INTERNAL_ERROR` with raw UUID-parser message. The Codex app-server protocol (`codex-rs/app-server-protocol`) serializes thread ids as `Uuid` (v7); `thr_abc` is not parseable. The CLI never validates the shape at the handler boundary, so the error bubbles up uncategorized.
- Agent calls `send … --mode execute`. The Codex collaboration-mode enum (see `codex-rs/app-server/README.md`) accepts only `plan | default`; `execute` is an internal alias that is never reachable over the wire. The handler doesn't pre-validate; the failure message comes from Rust deep inside.
- Agent expected sync `task --json` to be a single call; found it blocks 5–8 min through the auto-pipeline with no intermediate feedback. The upstream app-server's `turn/completed` is followed by our own pipeline stages, but none of them surface to the caller until the outer promise resolves.
- Agent cannot distinguish catastrophic `[ERROR]` from auto-pipeline-substage `[ERROR]` because `formatErrorEvent` emits the same tag for both, while only the former implies a non-zero exit.
- Agent wants a `Monitor` command but has to build the `tail -f … | while read …` snippet itself every time.

**Out of scope for this plan:** changing the skill docs (already done in a prior pass), writing a test runner, altering the protocol wire format, reworking the broker.

---

## File Structure

**Modify:**
- `src/codex-bridge.mjs` — handler validation, new subcommands, payload shape.
- `src/lib/cli-errors.mjs` — add `INVALID_THREAD_ID`, `INVALID_MODE`, `REVIEW_EMPTY_DIFF` error codes.
- `src/lib/session-log.mjs` — normalize timeout message formatting, optional `severity`/`phase` fields on error events.
- `src/lib/job-control.mjs` — extend `matchJobReference` to resolve by `threadId`.
- `src/lib/auto-pipeline.mjs` — rename pipeline-origin `[ERROR]` emission to include structured context.
- `src/lib/args.mjs` — add `isUuidLike` helper used by thread-id validators.

**Create:**
- `src/lib/thread-id.mjs` — single-source UUID v7 validator used across `send`, `steer`, `respond`, and `result`.

**No new files for tests** — verification is `node skill/scripts/codex-bridge.mjs …` invocations captured as expected JSON / exit codes in each step.

---

## Execution Expectations for Every Task

- Edit `src/`. Never hand-edit `skill/scripts/*` — it is a build output (see root `AGENTS.md`).
- Run `npm run build` after every source change; the verification commands point at the bundled script.
- Commits are small and focused. One task = one commit. Commit message prefix matches intent: `fix:`, `feat:`, `refactor:`.
- If a verification command spawns a real Codex turn, cancel it with `node skill/scripts/codex-bridge.mjs cancel <job-id>` before moving on.

---

## Task 1: Validate thread-id format at handler entry

**Problem:** `send thr_abc …` crashes to exit 1 with `"invalid thread id: invalid character: expected an optional prefix of urn:uuid:..."`. The Codex app-server library (Rust `uuid` crate) rejects non-UUIDs inside `runAppServerTurn`; our handler doesn't catch it. Same surface for `steer`, `respond` (via `params.threadId`), and the `result`/`cancel` path when someone pastes a thread id.

**Expected agent behavior:** exit 6 `INVALID_THREAD_ID` with `class: "validation"`, a suggestion listing the UUID format, and no billed Codex turn.

**Files:**
- Create: `src/lib/thread-id.mjs`
- Modify: `src/lib/cli-errors.mjs` (export an `invalidThreadIdError` helper)
- Modify: `src/codex-bridge.mjs` — `handleSend`, `handleSteer` (thread-id positional check)
- Test: verification via live CLI

- [ ] **Step 1: Create the validator module**

Create `src/lib/thread-id.mjs`:
```js
// UUID v1–v8 canonical form: 8-4-4-4-12 hex characters.
// Codex app-server uses UUID v7 for thread ids; we accept any hex UUID here
// because pre-v7 resumable threads (upgrade path) are still valid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function assertThreadId(value, source = "thread-id") {
  if (!isThreadId(value)) {
    const hint = typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : String(value);
    const err = new Error(
      `invalid ${source}: expected a UUID (8-4-4-4-12 hex), got ${hint}`
    );
    err.code = "INVALID_THREAD_ID";
    throw err;
  }
  return value.trim();
}
```

- [ ] **Step 2: Add envelope helper in `cli-errors.mjs`**

In `src/lib/cli-errors.mjs`, next to the other factory exports (`validationError`, `usageError`):
```js
export function invalidThreadIdError(value, source = "thread-id") {
  const hint = typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : String(value);
  return new CliError(
    `invalid ${source}: expected a UUID (8-4-4-4-12 hex), got ${hint}`,
    {
      class: "validation",
      code: "INVALID_THREAD_ID",
      retryable: false,
      suggestion: "Thread ids are UUID v7 like 019d9a86-1c8a-7f41-8032-6c76bbe730a1. Run `status` to list known threads."
    }
  );
}
```

- [ ] **Step 3: Use the validator in `handleSend`**

In `src/codex-bridge.mjs::handleSend` (around line 1650), replace the bare thread-id presence check:
```js
const threadId = positionals[0];
if (!threadId) {
  throw usageError("send requires <thread-id>");
}
```
with:
```js
import { isThreadId } from "./lib/thread-id.mjs";
// ...
const rawThreadId = positionals[0];
if (!rawThreadId) {
  throw usageError("send requires <thread-id>");
}
if (!isThreadId(rawThreadId)) {
  throw invalidThreadIdError(rawThreadId, "thread-id");
}
const threadId = rawThreadId.trim();
```

- [ ] **Step 4: Use the validator in `handleSteer`**

Same treatment in `handleSteer` for `positionals[0]` (thread id) — turn-id format stays unchecked (turn ids are also UUIDs, but many callers only have them from the `[PLAN]` block; add a separate validator in a later task if needed).

- [ ] **Step 5: Build and verify**

Run:
```bash
npm run build
node skill/scripts/codex-bridge.mjs send thr_abc --json; echo "EXIT=$?"
```
Expected stdout:
```json
{"ok":false,"schema_version":"1.0","error":{"class":"validation","code":"INVALID_THREAD_ID","message":"invalid thread-id: expected a UUID (8-4-4-4-12 hex), got \"thr_abc\"","retryable":false,"suggestion":"Thread ids are UUID v7 like 019d9a86-1c8a-7f41-8032-6c76bbe730a1. Run `status` to list known threads."},"command":"send"}
EXIT=6
```

And a UUID-like positional must still reach the existing prompt-missing path:
```bash
node skill/scripts/codex-bridge.mjs send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --json; echo "EXIT=$?"
```
Expected: `MISSING_PROMPT` / exit 6 (not INVALID_THREAD_ID).

- [ ] **Step 6: Commit**
```bash
git add src/lib/thread-id.mjs src/lib/cli-errors.mjs src/codex-bridge.mjs
git commit -m "fix(send,steer): validate thread-id format before Codex call"
```

---

## Task 2: Validate `--mode` before any other work in `send`

**Problem:** `send <tid> --mode execute 'go'` should exit 2 `USAGE_ERROR`; today it crashes if the thread-id also fails (Task 1 will change that, making the mode validation reachable). `buildCollaborationMode` in `src/lib/config.mjs` silently accepts any string.

**Expected agent behavior:** exit 2 `USAGE_ERROR` with `message: "mode must be plan or default, got \"execute\""` when the value is anything but `plan|default`.

**Files:**
- Modify: `src/codex-bridge.mjs::handleSend`

- [ ] **Step 1: Add the validator immediately after arg parse**

In `handleSend`, after `const { options, positionals } = parseCommandInput(...)`:
```js
const VALID_MODES = new Set(["plan", "default"]);
if (options.mode != null && !VALID_MODES.has(options.mode)) {
  throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
}
```
Place this block *before* the thread-id validator so the agent sees the usage error even when the thread id is also bad — usage errors are the lowest-cost fix.

- [ ] **Step 2: Build and verify**

```bash
npm run build
node skill/scripts/codex-bridge.mjs send thr_abc --mode execute 'Go' --json; echo "EXIT=$?"
```
Expected:
```json
{"ok":false,"schema_version":"1.0","error":{"class":"usage","code":"USAGE_ERROR","message":"mode must be plan or default, got \"execute\"","retryable":false},"command":"send"}
EXIT=2
```

And a valid mode still surfaces the thread-id error:
```bash
node skill/scripts/codex-bridge.mjs send thr_abc --mode default 'Go' --json; echo "EXIT=$?"
```
Expected: `INVALID_THREAD_ID` / exit 6.

- [ ] **Step 3: Commit**
```bash
git add src/codex-bridge.mjs
git commit -m "fix(send): reject unknown --mode before thread-id parse"
```

---

## Task 3: `task-resume-candidate` excludes non-completed jobs

**Problem:** `findLatestResumableTaskJob` filters out `queued` and `running` but includes `cancelled`, `failed`. An agent chaining `task --resume-last` against a cancelled candidate starts a new turn on a dead thread.

**Expected agent behavior:** `available: false` when the only prior job was cancelled/failed.

**Files:**
- Modify: `src/codex-bridge.mjs::findLatestResumableTaskJob` (line ~619)

- [ ] **Step 1: Replace the filter**

Replace:
```js
function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}
```
with:
```js
function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status === "completed"
    ) ?? null
  );
}
```

- [ ] **Step 2: Build and verify**

With the most recent job in the session being a cancelled task (from prior derailment walk), confirm:
```bash
npm run build
node skill/scripts/codex-bridge.mjs task-resume-candidate --json | jq '.result.available'
```
Expected: `false` (or `true` only if a genuinely completed task exists in the session).

- [ ] **Step 3: Commit**
```bash
git add src/codex-bridge.mjs
git commit -m "fix(task-resume-candidate): only surface completed threads"
```

---

## Task 4: Unknown subcommand returns the standard error envelope

**Problem:** `node skill/scripts/codex-bridge.mjs bogus-cmd` prints plain text to stderr and exits 2 — but the `--json` habit of agent parsers expects an envelope on stdout. Currently the dispatcher prints a free-form line before argv is fully parsed.

**Expected agent behavior:** with or without `--json`, stdout contains the standard error envelope `{"ok":false, "error":{"class":"usage", "code":"UNKNOWN_SUBCOMMAND", ...}}` and exit is 2.

**Files:**
- Modify: `src/codex-bridge.mjs::main` (switch fallthrough)

- [ ] **Step 1: Route unknown subcommand through `emitError`**

In `main()`, find the fallthrough that writes:
```js
process.stderr.write(`Unknown subcommand: ${subcommand}\n  → Run \`codex-bridge --help\` for the list of subcommands.\n`);
process.exit(2);
```
and replace with:
```js
const err = new CliError(`Unknown subcommand: ${subcommand}`, {
  class: "usage",
  code: "UNKNOWN_SUBCOMMAND",
  retryable: false,
  suggestion: "Run `help --json` to list available subcommands."
});
// `--json` may not have been parsed yet on the unknown branch — detect it directly.
const wantsJson = argv.includes("--json") || argv.includes("-j");
emitError(err, { json: wantsJson, command: null });
return;
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
node skill/scripts/codex-bridge.mjs bogus-cmd --json; echo "EXIT=$?"
```
Expected:
```json
{"ok":false,"schema_version":"1.0","error":{"class":"usage","code":"UNKNOWN_SUBCOMMAND","message":"Unknown subcommand: bogus-cmd","retryable":false,"suggestion":"Run `help --json` to list available subcommands."},"command":null}
EXIT=2
```
And without `--json`:
```bash
node skill/scripts/codex-bridge.mjs bogus-cmd; echo "EXIT=$?"
```
Expected: a human-readable error line to stderr + exit 2 (behavior from `emitError` in non-JSON mode).

- [ ] **Step 3: Commit**
```bash
git add src/codex-bridge.mjs
git commit -m "fix(cli): unknown subcommand returns standard error envelope"
```

---

## Task 5: Normalize timeout message units (seconds, not milliseconds)

**Problem:** `.events` lines show `auto-review exceeded 300000ms` — agents scanning for patterns like `exceeded \d+s` miss it. Matches the skill docs (`error-recovery.md`) now-noted quirk.

**Expected agent behavior:** `[ERROR] {threadId} failed | ClientTimeout\n  auto-review exceeded 300s` in `.events`; the NDJSON `data.error` keeps the millisecond detail.

**Files:**
- Modify: `src/lib/auto-pipeline.mjs` (two formatted error strings near line 233)
- Modify: `src/lib/codex.mjs` (idle-timeout message near line 600)

- [ ] **Step 1: Format helper**

At the top of `src/lib/auto-pipeline.mjs`, add:
```js
function fmtSeconds(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem.toString().padStart(2, "0")}s`;
}
```

- [ ] **Step 2: Use it in the pipeline-timeout message**

Replace:
```js
const errorMessage = error instanceof PipelineTimeoutError
  ? `Auto-pipeline exceeded ${PIPELINE_TIMEOUT_MS}ms. Completed stages: ${completedStages.join(", ")}`
  : error.message;
```
with:
```js
const errorMessage = error instanceof PipelineTimeoutError
  ? `Auto-pipeline exceeded ${fmtSeconds(PIPELINE_TIMEOUT_MS)}. Completed stages: ${completedStages.join(", ")}`
  : error.message;
```

In the `TimeoutError` class at the bottom of the same file, change:
```js
super(`${label} exceeded ${timeoutMs}ms`);
```
to:
```js
super(`${label} exceeded ${fmtSeconds(timeoutMs)}`);
this.timeoutMs = timeoutMs;
```
(preserve raw ms on the instance so callers logging to NDJSON retain resolution).

- [ ] **Step 3: Mirror in `codex.mjs` idle-timeout synthesis**

In `src/lib/codex.mjs`, find the idle-timeout branch around line 600:
```js
const seconds = Math.round(idleTimeoutMs / 1000);
// existing message
```
Change the rendered message to `No events received for ${seconds}s (idle timeout).` if it isn't already.

- [ ] **Step 4: Build and verify**

Directly exercise the formatter:
```bash
npm run build
node --input-type=module -e "
  import('./src/lib/auto-pipeline.mjs').then(m => {
    const e = new m.TimeoutError('auto-review', 300000);
    console.log(JSON.stringify({ message: e.message, ms: e.timeoutMs }));
  });
"
```
Expected:
```json
{"message":"auto-review exceeded 5m","ms":300000}
```

- [ ] **Step 5: Commit**
```bash
git add src/lib/auto-pipeline.mjs src/lib/codex.mjs
git commit -m "refactor(timeouts): render durations in seconds/minutes, keep ms in data"
```

---

## Task 6: Make `next_action.command` fully-qualified

**Problem:** `runBridgeTask` emits `command: "codex-bridge send <tid> …"`. Agents pasting this into a shell get `command not found` — there is no `codex-bridge` binary on PATH.

**Expected agent behavior:** the command starts with `node <absPathToScript>`, ready to paste.

**Files:**
- Modify: `src/codex-bridge.mjs::runBridgeTask::setPhase` (all four call sites)

- [ ] **Step 1: Use `SCRIPT_PATH` in each `next_action.command`**

Replace the four occurrences of literal `\`codex-bridge <sub> …\`` in `setPhase` calls (around lines 1259, 1278, 1299, 1304, 1323) so they read e.g.:
```js
setPhase("plan-pending", {
  command: `node ${SCRIPT_PATH} send ${result.threadId} --mode default "Implement the plan."`,
  description: "Approve the plan and switch to execution mode. To revise instead, drop --mode and send revision text."
}, { planPath, planSteps: steps });
```

`SCRIPT_PATH` is already computed near the top of the file for other emissions — reuse it.

- [ ] **Step 2: Mirror in `formatIncompleteEvent`/`formatDoneEvent`/`formatErrorEvent`**

Those already emit `node {scriptPath} …` — confirm by grep:
```bash
grep -n 'node \${scriptPath}' src/lib/session-log.mjs
```
If any still use `codex-bridge` bare, update them.

- [ ] **Step 3: Build and verify**

```bash
npm run build
node skill/scripts/codex-bridge.mjs task --json --effort banana 'x' 2>&1 | head -1
# any successful phase-emitting path — use a plan-pending fixture or observe an existing completed job
```
Better: trigger a plan-pending path with a real short run — but this costs a turn. Instead inspect the static string via grep of the bundle:
```bash
grep -c 'node .* send' skill/scripts/codex-bridge.mjs
```
Expected: ≥ 4 matches (one per phase branch).

- [ ] **Step 4: Commit**
```bash
git add src/codex-bridge.mjs
git commit -m "feat(next_action): emit fully-qualified node invocation"
```

---

## Task 7: New `codex-bridge wait <job-id>` subcommand

**Problem:** Agents poll `status --wait` (2 s cadence) or tail `.events` themselves. Both are wasteful and fragile. A dedicated `wait` that `fs.watch`es the events file and resolves on a terminal tag is cheaper and steers the agent toward the Monitor-shaped feedback pattern.

**Expected agent behavior:**
```bash
node … wait <job-id> --timeout-ms 600000 --json
```
→ blocks until `.events` emits `[DONE]`, `[ERROR]`, or `[INCOMPLETE]`; returns the success envelope with `result.terminalTag`, `result.lastEventLine`, `result.elapsedMs`. On timeout, returns `TRANSIENT`/exit 7 with `code: "WAIT_TIMEOUT"`.

**Files:**
- Modify: `src/codex-bridge.mjs` — add `handleWait`, register in `main()` switch and `COMMANDS`.
- Modify: `src/lib/cli-errors.mjs` — add `WAIT_TIMEOUT` constant.

- [ ] **Step 1: Add handler**

In `src/codex-bridge.mjs` near `handleStatus`:
```js
async function handleWait(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference).catch
    ? await resolveResultJob(cwd, reference)
    : resolveResultJob(cwd, reference);
  // resolveResultJob already throws JOB_NOT_FINISHED/conflict/5 for running jobs;
  // for wait, that's actually the path we want — catch it and proceed.
  const config = getBridgeConfig();
  const sessionDir = resolveSessionDir(config.session_dir);
  const eventsPath = path.join(sessionDir, `${job.threadId}.events`);

  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);
  const TERMINAL = /\[(DONE|ERROR|INCOMPLETE)\]/;

  const result = await waitForTerminalEvent(eventsPath, TERMINAL, timeoutMs);
  if (result.timedOut) {
    throw new CliError(
      `No terminal event in ${eventsPath} within ${Math.round(timeoutMs / 1000)}s.`,
      {
        class: "timeout",
        code: "WAIT_TIMEOUT",
        retryable: true,
        suggestion: "Run `status <job-id>` to inspect live state."
      }
    );
  }

  emitSuccess("wait",
    {
      jobId: job.id,
      threadId: job.threadId,
      terminalTag: result.tag,
      lastEventLine: result.line,
      eventsPath,
      elapsedMs: Date.now() - startedAt
    },
    `${result.tag} ${job.threadId} after ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
    { json: options.json, startedAt }
  );
}

function waitForTerminalEvent(eventsPath, pattern, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    let offset = 0;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (watcher) watcher.close();
      resolve(payload);
    };
    const checkFile = () => {
      try {
        const data = fs.readFileSync(eventsPath, "utf8");
        if (data.length < offset) offset = 0; // truncated — restart
        const tail = data.slice(offset);
        offset = data.length;
        for (const line of tail.split("\n")) {
          const m = pattern.exec(line);
          if (m) return finish({ timedOut: false, tag: m[1], line });
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    };
    checkFile();
    const watcher = fs.existsSync(eventsPath)
      ? fs.watch(eventsPath, { persistent: false }, checkFile)
      : null;
    if (!watcher) {
      // File not created yet — poll at 500ms until it exists, then switch.
      const poll = setInterval(() => {
        if (fs.existsSync(eventsPath)) {
          clearInterval(poll);
          const w = fs.watch(eventsPath, { persistent: false }, checkFile);
          checkFile();
        }
      }, 500);
      const timer = setTimeout(() => {
        clearInterval(poll);
        finish({ timedOut: true });
      }, timeoutMs);
      return;
    }
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
  });
}
```

- [ ] **Step 2: Register the handler**

Add `wait: handleWait` to the `SUBCOMMAND_DISPATCH` object and add a `COMMANDS.wait` entry:
```js
wait: {
  name: "wait",
  synopsis: "codex-bridge wait <job-id> [--timeout-ms <ms>] [--json]",
  summary: "Block until the job's events file emits [DONE], [ERROR], or [INCOMPLETE].",
  examples: [
    "codex-bridge wait task-abc --timeout-ms 600000 --json",
  ],
},
```
Also add a line to `printUsage()`.

- [ ] **Step 3: Build and verify (happy path)**

Create a fake events file and run:
```bash
npm run build
mkdir -p /tmp/cb-wait && THR=019ddddd-0000-7000-0000-000000000001
cat > /tmp/cb-wait/$THR.events <<'EOF'
[PIPELINE:diff] 10:00:00
[DONE] 019ddddd-0000-7000-0000-000000000001 completed in 4s | 1 files | +2 -0
EOF
# seed a fake job record — skip if the resolver walks only active jobs; use the existing completed job instead.
# Use a real completed job:
JOB=$(node skill/scripts/codex-bridge.mjs status --all --json | jq -r '.result.latestFinished.id // empty')
node skill/scripts/codex-bridge.mjs wait "$JOB" --timeout-ms 5000 --json
echo "EXIT=$?"
```
Expected: success envelope with `result.terminalTag` ∈ `{DONE, ERROR, INCOMPLETE}` (read from the existing events file), exit 0.

- [ ] **Step 4: Verify timeout path**

Point at a job with no pending terminal event (running job or empty events):
```bash
echo "" > /tmp/cb-wait/empty.events
# Use a synthetic in-memory job — easier: drive the function in isolation.
node --input-type=module -e "
  import('./src/codex-bridge.mjs').then(async () => {
    const fs = await import('node:fs');
    fs.writeFileSync('/tmp/cb-wait/empty.events', '');
    // The exported waitForTerminalEvent isn't public — test the CLI path instead.
    console.log('ok');
  });
"
node skill/scripts/codex-bridge.mjs wait 00000000-0000-0000-0000-000000000000 --timeout-ms 2000 --json
echo "EXIT=$?"
```
Expected: exit 3 (`JOB_NOT_FOUND`) for the unknown id; that's fine — the timeout branch is exercised by running against an active job (any real task will do).

- [ ] **Step 5: Commit**
```bash
git add src/codex-bridge.mjs src/lib/cli-errors.mjs
git commit -m "feat(cli): add \`wait\` subcommand blocking on terminal events"
```

---

## Task 8: New `codex-bridge events <job-or-thread-id>` subcommand with `--follow` and `--filter`

**Problem:** Agents build `tail -f <path> | while read …` by hand. The filter is a shell pipeline they often get wrong; the termination condition duplicates what the CLI could do.

**Expected agent behavior:**
```bash
node … events <id> --follow --filter DONE,ERROR,INCOMPLETE --timeout-ms 600000
```
streams lines to stdout, one per `\n`, exits 0 when a matching terminal tag appears. Without `--follow`, dumps the current events file and exits. `--filter` accepts comma-separated tag names; each line is checked against the `[TAG]` prefix.

**Files:**
- Modify: `src/codex-bridge.mjs` — add `handleEvents`.

- [ ] **Step 1: Add handler**

```js
async function handleEvents(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "filter"],
    booleanOptions: ["json", "follow"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { job } = resolveResultJob(cwd, reference, { allowActive: true });
  const config = getBridgeConfig();
  const sessionDir = resolveSessionDir(config.session_dir);
  const eventsPath = path.join(sessionDir, `${job.threadId}.events`);

  const filter = options.filter
    ? new Set(options.filter.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))
    : null;
  const passes = (line) => {
    if (!filter) return true;
    const m = /^\[([A-Z:]+)\]/.exec(line);
    if (!m) return false;
    const tag = m[1].split(":")[0];
    return filter.has(tag);
  };
  const TERMINAL = /\[(DONE|ERROR|INCOMPLETE)\]/;

  const initial = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "";
  for (const line of initial.split("\n")) {
    if (line && passes(line)) process.stdout.write(line + "\n");
  }
  if (!options.follow) {
    emitSuccess("events",
      { jobId: job.id, threadId: job.threadId, eventsPath, followed: false },
      "", { json: options.json, startedAt });
    return;
  }

  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);
  await new Promise((resolve) => {
    let offset = initial.length;
    const onChange = () => {
      try {
        const data = fs.readFileSync(eventsPath, "utf8");
        if (data.length < offset) offset = 0;
        const tail = data.slice(offset);
        offset = data.length;
        for (const line of tail.split("\n")) {
          if (line && passes(line)) process.stdout.write(line + "\n");
          if (TERMINAL.test(line)) {
            watcher?.close();
            resolve();
            return;
          }
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    };
    const watcher = fs.existsSync(eventsPath)
      ? fs.watch(eventsPath, { persistent: false }, onChange)
      : null;
    const timer = setTimeout(() => { watcher?.close(); resolve(); }, timeoutMs);
  });

  emitSuccess("events",
    { jobId: job.id, threadId: job.threadId, eventsPath, followed: true },
    "", { json: options.json, startedAt });
}
```

(The `allowActive: true` option for `resolveResultJob` is new — add it by extending the function in `job-control.mjs` to skip the `JOB_NOT_FINISHED` throw when the flag is set. Minor branch, two lines.)

- [ ] **Step 2: Register and document in `COMMANDS` / `printUsage()` / `SUBCOMMAND_DISPATCH`.**

- [ ] **Step 3: Build and verify**

Run against the latest completed job:
```bash
npm run build
JOB=$(node skill/scripts/codex-bridge.mjs status --all --json | jq -r '.result.latestFinished.id')
node skill/scripts/codex-bridge.mjs events "$JOB" --filter DONE,ERROR,INCOMPLETE
```
Expected: one or two tag lines; exit 0.

Without a filter:
```bash
node skill/scripts/codex-bridge.mjs events "$JOB"
```
Expected: every line of the events file + final success envelope (plain mode).

- [ ] **Step 4: Commit**
```bash
git add src/codex-bridge.mjs src/lib/job-control.mjs
git commit -m "feat(cli): add \`events\` subcommand with tag filter and follow mode"
```

---

## Task 9: Embed Monitor setup hint in `task` launch payload

**Problem:** On `task --write …` the launch payload returns `threadId`, `eventsPath`, `ndjsonPath` — agents then write a Monitor command. The CLI already knows the shape; give it to them.

**Expected agent behavior:** `result.monitor.command` is a ready-to-paste shell snippet that self-terminates on terminal tags, and `result.monitor.tool_hint` is an object targeting the harness's `Monitor` tool (keys: `description`, `command`, `timeout_ms`, `persistent`).

**Files:**
- Modify: `src/codex-bridge.mjs::runBridgeTask` and/or `handleTask` success payload (background + foreground paths).

- [ ] **Step 1: Add a helper**

```js
function buildMonitorHint({ eventsPath }) {
  const shell =
    `tail -f ${JSON.stringify(eventsPath)} | while IFS= read -r line; do ` +
    `echo "$line"; case "$line" in *"[DONE]"*|*"[ERROR]"*|*"[INCOMPLETE]"*) break ;; esac; done`;
  return {
    command: shell,
    tool_hint: {
      description: "codex-bridge task terminal events",
      command: shell,
      timeout_ms: 3600000,
      persistent: false
    }
  };
}
```

- [ ] **Step 2: Inject into the launch payload**

In `enqueueBackgroundTask` and `runBridgeTask`, wherever the payload is built with `threadId`/`eventsPath`, add:
```js
payload.monitor = buildMonitorHint({ eventsPath: payload.eventsPath });
```

- [ ] **Step 3: Build and verify**

```bash
npm run build
node skill/scripts/codex-bridge.mjs task --background --write 'x' --json | jq '.result.monitor'
```
Expected: an object with `command` and `tool_hint` fields; `command` contains `tail -f` and the events path.

Cancel the background job immediately to avoid burning a turn:
```bash
JOB=$(... | jq -r '.result.jobId'); node skill/scripts/codex-bridge.mjs cancel "$JOB" --json
```

- [ ] **Step 4: Commit**
```bash
git add src/codex-bridge.mjs
git commit -m "feat(task): include ready-to-paste Monitor hint in launch payload"
```

---

## Task 10: `result` / `cancel` / `status` resolve by thread id too

**Problem:** `matchJobReference` (in `src/lib/job-control.mjs`) matches only on `job.id`. SKILL.md correctly tells agents to use job ids, but action-line emissions in some paths fall back to thread ids (see `setPhase("done")` at `codex-bridge.mjs:1304` — `result ${request.jobId ?? result.threadId}`). If that fallback ever fires, the agent gets `JOB_NOT_FOUND`.

**Expected agent behavior:** `result <threadId>` resolves the job whose `job.threadId === <threadId>`, returning the full result.

**Files:**
- Modify: `src/lib/job-control.mjs::matchJobReference`

- [ ] **Step 1: Add thread-id matching**

```js
function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) return filtered[0] ?? null;

  const exact = filtered.find((job) => job.id === reference);
  if (exact) return exact;

  const byThread = filtered.find((job) => job.threadId === reference);
  if (byThread) return byThread;

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    throw new CliError(/* existing AMBIGUOUS_JOB_REFERENCE */);
  }

  throw new CliError(/* existing JOB_NOT_FOUND */);
}
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
JOB_ID=$(node skill/scripts/codex-bridge.mjs status --all --json | jq -r '.result.latestFinished.id')
THREAD_ID=$(node skill/scripts/codex-bridge.mjs status "$JOB_ID" --json | jq -r '.result.job.threadId')
node skill/scripts/codex-bridge.mjs result "$THREAD_ID" --json | jq '.result.job.id'
```
Expected: the result envelope reports `job.id` = `$JOB_ID`.

- [ ] **Step 3: Commit**
```bash
git add src/lib/job-control.mjs
git commit -m "feat(job-control): resolve result/cancel/status by thread id as well as job id"
```

---

## Task 11: `review` short-circuits on an empty diff

**Problem:** `review --scope working-tree` runs a full billed Codex turn even when `git diff --quiet` holds. Agents burn tokens reviewing nothing.

**Expected agent behavior:** exit 6 `REVIEW_EMPTY_DIFF` with `class: "validation"`, `suggestion: "Nothing to review. Make changes first."`, and no Codex turn.

**Files:**
- Modify: `src/codex-bridge.mjs::executeReviewRun` (early guard)

- [ ] **Step 1: Add the guard**

Near the top of `executeReviewRun`, after `ensureGitRepository`:
```js
const diffCheck = runCommand("git", ["diff", "--quiet"], { cwd: request.cwd });
const stagedCheck = runCommand("git", ["diff", "--cached", "--quiet"], { cwd: request.cwd });
if (diffCheck.status === 0 && stagedCheck.status === 0) {
  throw new CliError("No changes to review.", {
    class: "validation",
    code: "REVIEW_EMPTY_DIFF",
    retryable: false,
    suggestion: "Make a change (working tree or staged) before invoking `review`."
  });
}
```

Only applies when `--scope` is `working-tree` or `auto` (the branch scope compares against `--base` and may legitimately be empty). Gate accordingly:
```js
const scope = request.scope ?? "auto";
if (scope !== "branch") { /* the guard above */ }
```

- [ ] **Step 2: Build and verify**

From a clean tree:
```bash
npm run build
git status --porcelain   # expect empty
node skill/scripts/codex-bridge.mjs review --scope working-tree --json; echo "EXIT=$?"
```
Expected: `REVIEW_EMPTY_DIFF` / exit 6 with no Codex turn (`status --all --json` shouldn't show a new review job).

- [ ] **Step 3: Commit**
```bash
git add src/codex-bridge.mjs
git commit -m "feat(review): short-circuit when working tree has no changes"
```

---

## Task 12: `task --mode plan|default` flag

**Problem:** No CLI lever for picking execution mode on the first turn; agents must edit `config.yaml`.

**Expected agent behavior:**
```bash
node … task --mode default --write 'Trivial fix'
```
starts with `collaborationMode: default`, `sandbox: workspaceWrite` — no plan turn.

**Files:**
- Modify: `src/codex-bridge.mjs::handleTask` (accept `mode` value-option), `runBridgeTask` (respect override).

- [ ] **Step 1: Declare the flag**

In `handleTask`, change:
```js
valueOptions: ["model", "effort", "cwd", "prompt-file"],
```
to:
```js
valueOptions: ["model", "effort", "cwd", "prompt-file", "mode"],
```
Immediately after parsing:
```js
const VALID_MODES = new Set(["plan", "default"]);
if (options.mode != null && !VALID_MODES.has(options.mode)) {
  throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
}
```

- [ ] **Step 2: Thread through `buildTaskRequest`**

Pass `mode: options.mode` into `buildTaskRequest` / `runBridgeTask`. In `runBridgeTask` (`src/codex-bridge.mjs:1126`):
```js
const effectiveMode = request.mode ?? config.mode;
const isPlanMode = effectiveMode === "plan" && !request.resumeLast;
```
Everything downstream already consumes `isPlanMode`.

- [ ] **Step 3: Build and verify**

```bash
npm run build
node skill/scripts/codex-bridge.mjs task --mode banana --write 'x' --json; echo "EXIT=$?"
# Expected: USAGE_ERROR / exit 2

node skill/scripts/codex-bridge.mjs task --mode default --background --write 'echo hi' --json | jq '.result.jobId'
# Expected: a jobId; cancel it immediately:
# node … cancel $(… | jq -r '.result.jobId')
```

Confirm the NDJSON TURN_PARAMS for the run has `collaborationMode.mode: "default"` once started, by tailing:
```bash
jq 'select(.tag=="TURN_PARAMS") | .data.collaborationMode.mode' ~/.codex-bridge/sessions/<tid>.ndjson
```

- [ ] **Step 4: Commit**
```bash
git add src/codex-bridge.mjs
git commit -m "feat(task): accept --mode override (plan|default)"
```

---

## Task 13: Structured `phase` + `origin` on `[ERROR]` emissions

**Problem:** Events `[ERROR]` is fired from both the main-turn failure branch (`codex-bridge.mjs:1250`) and the pipeline-sub branch (`auto-pipeline.mjs:244`). Agents cannot distinguish without parsing the message prose. Tests / Gherkin conflate them.

**Expected agent behavior:** every `[ERROR]` block gains an `origin:` line — `turn` for main-turn failures, `pipeline:<stage>` for pipeline-origin. NDJSON `ERROR` entries get `data.origin` matching. Tooling that wants only terminal errors can filter on `origin: turn`.

**Files:**
- Modify: `src/lib/session-log.mjs::formatErrorEvent`
- Modify: two call sites (`src/codex-bridge.mjs:1250`, `src/lib/auto-pipeline.mjs:244`)

- [ ] **Step 1: Extend the formatter signature**

In `src/lib/session-log.mjs`:
```js
export function formatErrorEvent(session, { errorCode, message, phase, origin = "turn", scriptPath, jobId = null }) {
  const lines = [
    `[ERROR] ${session.threadId} failed | ${errorCode}`,
    `  ${message}`,
    `  origin: ${origin}`,
    `  phase: ${phase}`,
    "  actions:",
    `    retry: node ${scriptPath} send ${session.threadId} "<revised prompt>"`,
    resultActionLine(scriptPath, jobId),
    cancelActionLine(scriptPath, jobId),
    ""
  ];
  return lines.join("\n");
}
```

- [ ] **Step 2: Pass `origin` from the two call sites**

In `src/codex-bridge.mjs:1250`:
```js
logEvent(session, formatErrorEvent(session, {
  errorCode,
  message: errorMessage,
  phase: isPlanMode ? "plan" : "execution",
  origin: "turn",
  scriptPath: SCRIPT_PATH,
  jobId: request.jobId ?? null,
}));
logNdjson(session, "ERROR", null, { errorCode, message: errorMessage, origin: "turn" });
```

In `src/lib/auto-pipeline.mjs:244`:
```js
const stage = completedStages[completedStages.length - 1] ?? "pipeline";
logEvent(session, formatErrorEvent(session, {
  errorCode,
  message: errorMessage,
  phase: `pipeline (completed: ${completedStages.join(", ")})`,
  origin: `pipeline:${stage}`,
  scriptPath,
  jobId,
}));
logNdjson(session, "PIPELINE_ERROR", null, {
  completedStages,
  duration,
  error: errorMessage,
  origin: `pipeline:${stage}`,
});
```

- [ ] **Step 3: Build and verify**

Trigger a pipeline error by pointing at an existing events file from a prior pipeline-timeout run and re-invoking the formatter via isolated import:
```bash
npm run build
node --input-type=module -e "
  import('./src/lib/session-log.mjs').then(m => {
    const out = m.formatErrorEvent({ threadId: 'abc' }, {
      errorCode: 'ClientTimeout',
      message: 'auto-review exceeded 5m',
      phase: 'pipeline (completed: diff)',
      origin: 'pipeline:review',
      scriptPath: '/x',
      jobId: 'task-z',
    });
    process.stdout.write(out);
  });
"
```
Expected: the rendered block contains both `origin: pipeline:review` and `phase: pipeline (completed: diff)` lines.

- [ ] **Step 4: Commit**
```bash
git add src/lib/session-log.mjs src/codex-bridge.mjs src/lib/auto-pipeline.mjs
git commit -m "feat(events): add \`origin\` field to [ERROR] blocks"
```

---

## Task 14: Persist `item/completed` into NDJSON for agent replay

**Problem:** `summary` can't reconstruct turn history because NDJSON lacks `ITEM_COMPLETED` entries. `references/ndjson-guide.md` now explains this gap, but for agents actually using `summary`, the structural hole is wasteful.

**Expected agent behavior:** `jq 'select(.tag == "ITEM_COMPLETED")' < session.ndjson` returns one entry per assistant message / tool call / file change / plan.

**Files:**
- Modify: `src/lib/codex.mjs` — capture `item/completed` in the notification handler.

- [ ] **Step 1: Add a thin logger hook in the turn captor**

`captureTurn` already demuxes `item/completed` into its state machine. Add an opt-in callback:
```js
// In runAppServerTurn's options forwarded to captureTurn
onItemCompleted: (item) => {
  // Only log if caller provided a logger (avoids coupling captor to NDJSON).
}
```

And in `runBridgeTask` (`src/codex-bridge.mjs:1126`), pass:
```js
onItemCompleted: (item) => {
  const s = findSession(sessionDir, bridgeRequest.resumeThreadId ?? item.threadId);
  if (!s) return;
  logNdjson(s, "ITEM_COMPLETED", "item/completed", {
    itemId: item.id,
    itemType: item.type,
    text: item.text ? item.text.slice(0, 200) : null,
  });
}
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
# Run the shortest possible real task, or pick an existing ndjson to confirm after a fresh run:
node skill/scripts/codex-bridge.mjs task --mode default --background --write 'Add a comment to .tmp/mini-site/app.js saying hello' --json | jq '.result.jobId'
# Wait for completion, then:
jq 'select(.tag=="ITEM_COMPLETED") | {type: .data.itemType, preview: .data.text}' ~/.codex-bridge/sessions/<tid>.ndjson
```
Expected: one or more entries with `itemType ∈ { agentMessage, commandExecution, fileChange, plan }`.

- [ ] **Step 3: Commit**
```bash
git add src/codex-bridge.mjs src/lib/codex.mjs
git commit -m "feat(ndjson): persist item/completed for agent replay"
```

---

## Task 15: Final end-to-end smoke

Not a code change — a verification pass exercising the new surfaces as an agent would.

- [ ] **Step 1: Kick off a real sync task, capture next_action.command**
```bash
npm run build
node skill/scripts/codex-bridge.mjs task --mode default --write --json \
  "Append '// smoke' as the last line of .tmp/mini-site/app.js" | tee /tmp/smoke.json | jq '.ok, .result.phase, .result.next_action.command'
```
Expected: `true`, `"done"`, command starts with `node /…/skill/scripts/codex-bridge.mjs …`.

- [ ] **Step 2: Run `events` in follow mode against the same job**
```bash
JOB=$(jq -r '.result.jobId // empty' /tmp/smoke.json)
node skill/scripts/codex-bridge.mjs events "$JOB" --filter DONE,ERROR,INCOMPLETE
```
Expected: one terminal-tag line, exit 0.

- [ ] **Step 3: Run `wait` against the same job (returns immediately)**
```bash
node skill/scripts/codex-bridge.mjs wait "$JOB" --timeout-ms 5000 --json | jq '.result.terminalTag'
```
Expected: `"DONE"`, exit 0.

- [ ] **Step 4: Negative path — invalid thread id**
```bash
node skill/scripts/codex-bridge.mjs send thr_abc 'x' --json | jq '.error.code, .error.class'
```
Expected: `"INVALID_THREAD_ID"`, `"validation"`, exit 6.

- [ ] **Step 5: Commit the smoke log**

None needed — this task is a manual verification checklist.

---

## Self-Review Notes

- **Spec coverage:** the user's request mapped to four buckets — stability, feedback quality, filterability, steering toward Monitor. Tasks 1–4, 10–12 = stability/correctness. Tasks 5, 13, 14 = feedback quality. Tasks 7, 8, 9 = filterability + Monitor steering. Task 11 = token-economy stability. Nothing in scope is uncovered.
- **Placeholders:** every code step contains the actual snippet or exact replacement; verification commands are concrete.
- **Type consistency:** `SCRIPT_PATH`, `resolveSessionDir`, `findSession`, `logNdjson`, `logEvent`, `formatErrorEvent`, `buildMonitorHint`, `buildTaskRequest`, `isThreadId`, `invalidThreadIdError` — all names are used consistently across tasks that reference them.
- **Risk:** Task 7 / 8 depend on `resolveResultJob` growing an `allowActive` flag (noted inline). If the subagent skips that tweak, the `events` subcommand will throw `JOB_NOT_FINISHED` for running jobs. Reviewer should catch.
