# Monitor Patterns

## Before Setting Up a Monitor

Always verify the events file exists before attaching a Monitor:
```bash
test -f "$EVENTS_FILE" && echo "ready" || echo "waiting"
```

If not ready, wait 1-2 seconds and check again. The events file is created when the task starts.

## Preset A: `events --follow` (default, preferred)

Use for every task. Self-terminates on any terminal tag (`[DONE]`, `[ERROR]`, `[INCOMPLETE]`), even if the tag was already present in the initial dump. Handles file rotation; filter is prefix-aware (`PIPELINE` matches `[PIPELINE:review]`, `[PIPELINE:fix]`, …).

```bash
node "$SCRIPT_PATH" events "$JOB_ID" --follow \
  --filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION --timeout-ms 600000
```

Monitor params: `persistent: false, timeout_ms: 3600000` (the `events` subcommand has its own `--timeout-ms` that the Monitor's outer deadline can still interrupt).

Every `task --json` launch returns `result.monitor.tool_hint` — an object with exactly the shape the `Monitor` tool expects (`description`, `command`, `timeout_ms`, `persistent`). Paste it verbatim instead of re-templating.

Events received: `[PLAN]`, `[QUESTION]`, `[CONFIRMED]`, `[PIPELINE:*]`, `[DONE]` / `[ERROR]` / `[INCOMPLETE]`.
Typical volume: 2–5 events per task.

## Preset A-raw: `tail -f` fallback

Use only when the bundled script isn't available (e.g. you're operating outside the skill's harness).

```bash
tail -f "$EVENTS_FILE" | while IFS= read -r line; do
  echo "$line"
  case "$line" in
    *"[DONE]"*|*"[ERROR]"*|*"[INCOMPLETE]"*) break ;;
  esac
done
```

## Preset B: Progress (long tasks)

Same as Preset A. The `events --follow` command with no `--filter` (or with a looser `--filter PIPELINE,PLAN,QUESTION,DONE,ERROR,INCOMPLETE` list) shows every actionable tag as it lands.

## Preset C: Heartbeat (session-long)

Use alongside task monitors for long dev sessions. Persistent. Only emits when something changes.

```bash
LAST_COMMITS=0
while true; do
  COMMITS=$(cd "$PROJECT_DIR" && git log --oneline "${BASE_REF}..HEAD" 2>/dev/null | wc -l | tr -d ' ')
  CODEX_PROCS=$(pgrep -f "codex" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${COMMITS}" != "${LAST_COMMITS}" ]; then
    echo "[HEARTBEAT] commits=${COMMITS} (+$((COMMITS - LAST_COMMITS))) codex=${CODEX_PROCS}"
    LAST_COMMITS=${COMMITS}
  fi
  sleep 60
done
```

Monitor params: `persistent: true, timeout_ms: 300000`

## Preset D: `wait` (blocking, no streaming)

When the agent only needs the single terminal signal and doesn't care about intermediate tags, block with the built-in `wait` subcommand instead of running a full Monitor:

```bash
node "$SCRIPT_PATH" wait "$JOB_ID" --timeout-ms 600000 --json
```

Returns `{terminalTag, elapsedMs, lastEventLine, eventsPath, jobId, threadId}` on stdout, exit 0. On deadline: exit 7 `WAIT_TIMEOUT`. Cheapest way to gate follow-up work on terminal completion.

## Preset E: Custom polling (deep fallback)

Use only if both `events --follow` and `wait` are unavailable.

```bash
# Poll on a job id or thread UUID — resolver accepts either.
# The success envelope wraps result under `.result.job.status`.
while true; do
  STATUS=$(node "$SCRIPT_PATH" status "$JOB_ID" --json 2>/dev/null | jq -r '.result.job.status // "unknown"')
  echo "[POLL] status=${STATUS}"
  if [ "${STATUS}" = "completed" ] || [ "${STATUS}" = "failed" ] || [ "${STATUS}" = "cancelled" ]; then
    break
  fi
  sleep 30
done
```

## Parallel Tasks

Each task gets its own `events --follow` (Preset A). Heartbeat (Preset C) runs once for the session.

```
Session:
  Monitor: Heartbeat (Preset C, persistent)
  Task A → Monitor: events task-aaa… --follow (Preset A)
  Task B → Monitor: events task-bbb… --follow (Preset A)
```
Thread IDs are UUID v7; truncate for display as needed. The `events` subcommand accepts either the job id or the thread id.

## Stopping a Monitor

- Terminal tag ([DONE]/[ERROR]/[INCOMPLETE]) → self-terminates via `break`
- TaskStop → kill by task ID
- Session end → all monitors die
- Auto-kill for volume → restart with tighter filter
- **Timeout (no terminal tag)** → Monitor times out after `timeout_ms`. Use 600000 (10 min) as safety net. The bridge's own 120 s idle watchdog usually surfaces a `[ERROR] … | ClientTimeout` first; if Monitor is silent past ~3 min assume a deeper stall and `status`/`cancel` the job.

## When No Events Arrive

If Monitor starts but no events appear within 2-3 minutes:

1. Check job status: `node <scriptPath> status <id> --json` (either job id or thread UUID). Omit the id to list all jobs.
2. If status is "running" — Codex is working but hasn't produced actionable events yet. Wait, or switch to `wait <id>` for a blocking signal.
3. If status is "completed" — the task finished but no events were written (possible wiring issue). Read the result: `node <scriptPath> result <id>` (or with no id to pick the latest in the session).
4. If status is "failed" — cancel and retry.

If Codex completed instantly with `[DONE]` and 0 file changes, it likely asked a question via text output instead of the `requestUserInput` tool. Read the stdout from the task launch and respond via `send`.
