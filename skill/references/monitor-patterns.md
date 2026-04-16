# Monitor Patterns

## Before Setting Up a Monitor

Always verify the events file exists before attaching a Monitor:
```bash
test -f "$EVENTS_FILE" && echo "ready" || echo "waiting"
```

If not ready, wait 1-2 seconds and check again. The events file is created when the task starts.

## Preset A: Minimal (default)

Use for every task. Self-terminates on completion.

```bash
tail -f "$EVENTS_FILE" | while IFS= read -r line; do
  echo "$line"
  case "$line" in
    *"[DONE]"*|*"[ERROR]"*|*"[INCOMPLETE]"*) break ;;
  esac
done
```

Monitor params: `persistent: false, timeout_ms: 3600000`

Events received: [PLAN], [QUESTION], [CONFIRMED], [PIPELINE:*], [DONE]/[ERROR]/[INCOMPLETE]
Typical volume: 2-5 events per task.

## Preset B: Progress (long tasks)

Same script as Preset A. The difference is that [PHASE] events are also written when the task involves many file changes or commands.

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

## Preset D: Custom Polling (fallback)

Use when the events file approach isn't working.

```bash
while true; do
  STATUS=$(node "$SCRIPT_PATH" status "$THREAD_ID" --json 2>/dev/null | jq -r '.job.status // "unknown"')
  echo "[POLL] status=${STATUS}"
  if [ "${STATUS}" = "completed" ] || [ "${STATUS}" = "failed" ] || [ "${STATUS}" = "cancelled" ]; then
    break
  fi
  sleep 30
done
```

## Parallel Tasks

Each task gets its own Monitor (Preset A). Heartbeat (Preset C) runs once for the session.

```
Session:
  Monitor: Heartbeat (Preset C, persistent)
  Task A → Monitor: thr_aaa events (Preset A)
  Task B → Monitor: thr_bbb events (Preset A)
```

## Stopping a Monitor

- Terminal tag ([DONE]/[ERROR]/[INCOMPLETE]) → self-terminates via `break`
- TaskStop → kill by task ID
- Session end → all monitors die
- Auto-kill for volume → restart with tighter filter
- **Timeout (no terminal tag)** → Monitor times out after `timeout_ms`. Use 600000 (10 min) as safety net.

## When No Events Arrive

If Monitor starts but no events appear within 2-3 minutes:

1. Check task status: `node <scriptPath> status <thread-id> --json`
2. If status is "running" — Codex is working but hasn't produced actionable events yet. Wait.
3. If status is "completed" — the task finished but no events were written (possible wiring issue). Read the result: `node <scriptPath> result <thread-id>`
4. If status is "failed" — cancel and retry.

If Codex completed instantly with `[DONE]` and 0 file changes, it likely asked a question via text output instead of the `requestUserInput` tool. Read the stdout from the task launch and respond via `send`.
