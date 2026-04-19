# 05-upstream-disconnect-classified-transient

**Derived from:** `src/lib/cli-errors.mjs:140-210` (`classifyError` — typed `CODEX_ERROR_INFO` lookup, idle/process-death regexes, **new** transport-drop regex, internal fall-through), `src/lib/codex.mjs:574-599` (`turn/completed` handler now hoists `turn.error` onto `state.error` so `codexErrorInfo` survives into `runAppServerTurn`'s return), `src/lib/codex.mjs:1160-1174` (`runAppServerTurn` returns `{ error: turnState.error }` consumed by `runForegroundCommand`), `src/codex-bridge.mjs:1371-1403` (`runForegroundCommand` feeds `execution.error` to `emitError` → `classifyError`).
**What this catches:** upstream WebSocket drops mid-turn used to surface as `{class:"internal", code:"INTERNAL_ERROR", retryable:false, exit:1}` — suppressing the orchestrator's automatic retry for a textbook transient error. The fix has two layers: (a) when `turn/completed` arrives with `status != "completed"` and a `turn.error.codexErrorInfo` tag, that tag is merged into `state.error` so the typed `CODEX_ERROR_INFO` table resolves it (`ResponseStreamDisconnected` → `class:"network", retryable:true`); (b) when the transport dies before any `turn/completed` arrives, a regex fallback on the message text (`stream disconnected|websocket closed|no close frame|ECONNRESET|ETIMEDOUT|socket hang up`) maps to `{class:"network", code:"UPSTREAM_STREAM_DISCONNECTED", retryable:true, exit:7}`.
**Runtime cost:** fast — exercises `classifyError` directly in node, no Codex spawn.
**Test subject:** pure unit test against the exported `classifyError`. No broker, no network.

## Feature: transport-layer upstream drops classify as retryable transients

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
```

And `npm run build` has been run since the last `src/` edit.

### Scenario 1: text-only WS drop (no `codexErrorInfo`) classifies as transient (smokeable)

Given `classifyError` is imported from `src/lib/cli-errors.mjs`
When called with `{ message: "stream disconnected before completion: Upstream websocket closed before response.completed: no close frame received or sent" }`
Then the result has `class === "network"`
And `code === "UPSTREAM_STREAM_DISCONNECTED"`
And `retryable === true`
And `exitCode === 7`
And `suggestion` mentions that prior reasoning is lost but the workspace is unchanged

### Scenario 2: `turn/completed.turn.error.codexErrorInfo` reaches the classifier (smokeable)

Given the captor's `turn/completed` branch in `src/lib/codex.mjs` merges `turn.error` into `state.error` when `turn.status !== "completed"`
When `classifyError` is called with `{ message: "...", codexErrorInfo: "ResponseStreamDisconnected" }`
Then the typed lookup at `src/lib/cli-errors.mjs:55-59` resolves `class === "network"`, `retryable === true`, `code === "ResponseStreamDisconnected"`, `exitCode === 7`

### Scenario 3: snake-case `codex_error_info` is equally resolved (smokeable)

When `classifyError` is called with `{ message: "x", codex_error_info: "ResponseStreamDisconnected" }`
Then the result matches scenario 2 (both casings are tried at `cli-errors.mjs:155`)

### Scenario 4: ECONNRESET raw transport errors also classify as transient (smokeable)

When `classifyError` is called with `{ message: "read ECONNRESET" }`
Then `class === "network"`, `code === "UPSTREAM_STREAM_DISCONNECTED"`, `retryable === true`, `exitCode === 7`

### Scenario 5: non-matching plaintext still falls through to internal (regression guard)

When `classifyError` is called with `{ message: "some unrelated error" }`
Then `class === "internal"`, `code === "INTERNAL_ERROR"`, `retryable === false`, `exitCode === 1`

### Scenario 6: `Unauthorized` / auth errors are NOT accidentally downgraded (regression guard)

When `classifyError` is called with `{ message: "auth fail", codexErrorInfo: "Unauthorized" }`
Then `class === "auth"`, `retryable === false`, `exitCode === 4` (the typed table wins over the regex fallback)

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cat > /tmp/cb-classifier.mjs <<EOF
import { classifyError } from 'file://${REPO_ROOT}/src/lib/cli-errors.mjs';
const cases = [
  { name: 'ws-drop-text', err: { message: 'stream disconnected before completion: Upstream websocket closed before response.completed: no close frame received or sent' }, expect: { class: 'network', code: 'UPSTREAM_STREAM_DISCONNECTED', retryable: true, exitCode: 7 } },
  { name: 'codexErrorInfo', err: { message: 'x', codexErrorInfo: 'ResponseStreamDisconnected' }, expect: { class: 'network', retryable: true, exitCode: 7 } },
  { name: 'snake-case',    err: { message: 'x', codex_error_info: 'ResponseStreamDisconnected' }, expect: { class: 'network', retryable: true, exitCode: 7 } },
  { name: 'econnreset',    err: { message: 'read ECONNRESET' }, expect: { class: 'network', retryable: true, exitCode: 7 } },
  { name: 'fallthrough',   err: { message: 'some unrelated error' }, expect: { class: 'internal', retryable: false, exitCode: 1 } },
  { name: 'auth-typed',    err: { message: 'x', codexErrorInfo: 'Unauthorized' }, expect: { class: 'auth', retryable: false, exitCode: 4 } },
];
let fail = 0;
for (const c of cases) {
  const r = classifyError(c.err);
  const ok = Object.entries(c.expect).every(([k, v]) => r[k] === v);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + c.name + ' => class=' + r.class + ' retryable=' + r.retryable + ' exit=' + r.exitCode);
  if (!ok) fail++;
}
process.exit(fail === 0 ? 0 : 1);
EOF
node /tmp/cb-classifier.mjs
```

### Enhancement candidates

- When upstream adds a new `codexErrorInfo` variant (e.g., a new transport-level tag), add it to `CODEX_ERROR_INFO` at `src/lib/cli-errors.mjs:34-88` **before** the regex fallback — typed tags carry better suggestions.
- The hoist at `src/lib/codex.mjs:586-597` only merges on non-"completed" status. If upstream ever emits a `status:"completed"` with a non-null `turn.error` (partial success), we need a separate phase. Not currently observed.
- If the `error` notification payload ever starts carrying `codexErrorInfo` at the top level (upstream protocol evolution), the existing `state.error = err` at `codex.mjs:564` will already capture it — no change needed here. This scenario exists to pin the behavior either way.
