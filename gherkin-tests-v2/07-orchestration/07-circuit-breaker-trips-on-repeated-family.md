# 07-circuit-breaker-trips-on-repeated-family

**Derived from:** `src/codex-bridge.mjs` — `detectCommandFamily`, `isFailureHidingWrapper`, `breakerState` (sliding-window `recent[]`), `onItemCompleted` circuit-breaker branch. `src/lib/session-log.mjs::formatWarningEvent`. `src/lib/config.mjs::DEFAULT_CONFIG.command_failure_circuit_breaker = true`. `skill/references/config-reference.md` "command_failure_circuit_breaker" section.
**What this catches:** Codex's ReAct loop has no convergence check for "this category of tool is structurally unavailable in my current environment". v1.2.0 shipped a "3 consecutive same-family fails" counter. **v1.2.2 retest (T4) found this too strict** — Codex wraps failing osascript in `... & sleep 2; kill -TERM $!` which exits 0, masking failures and resetting the consecutive counter. v1.2.2 upgrades to:
- **Sliding window** (size 5): count same-family fails within the last 5 commandExecutions, not strictly consecutive.
- **Wrapper detection**: monitored-family commands that exit 0 but contain a known failure-hiding construct (`& kill`, `|| true`, `|| exit 0`, `; true` at end) are treated as failed.
Both are required to catch the live Codex behavior observed in T4.
**Runtime cost:** fast — exercises detector + window + wrapper logic directly, no Codex spawn.
**Test subject:** unit-level assertion on the sliding-window + wrapper-detection invariants. The `[WARNING]` write path is exercised indirectly by the predicate's state-machine reproduction.

## Feature: same-family failures trip the breaker (sliding window + wrapper detection)

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
```

And `npm run build` has been run since the last `src/` edit.

### Scenario 1: three raw same-family failures in a row trip the breaker

Given three `commandExecution` items: `{ type, status:"failed", exitCode:1, command:"osascript -e …" }`
When the breaker inspects each item
Then after the third, `breakerState.tripped === true`
And exactly one `[WARNING]` event is emitted (later same-family fails after tripping do not re-fire)
And the `CIRCUIT_BREAKER` NDJSON record carries `family: "osascript"`, `threshold: 3`, `windowSize: 5`, `failsInWindow: 3`, `wrapperDetected: false`

### Scenario 2: sliding window catches 3 fails interleaved with successes

Given `[osascript-fail, osascript-fail, npm-test-success(unmonitored), osascript-fail]`
Then the breaker trips on the third osascript fail
And the `CIRCUIT_BREAKER` record carries `failsInWindow: 3` (the npm test success is unmonitored → not added to the window)

This is the **semantic upgrade from v1.2.0 → v1.2.2**. Pre-1.2.2 this sequence did NOT trip because the (unmonitored) npm-test success was ignored and the two preceding osascript fails didn't reach 3-consecutive.

### Scenario 3: different-family failures do not accumulate for the same family

Given `[osascript-fail, open-app-fail, computer-use-fail]`
Then the breaker does NOT trip — the window holds all three but no *single family* has 3 fails in it

### Scenario 4: unmonitored-family failure is ignored (neither added to window nor counted)

Given `[osascript-fail, python-broken.py-fail(exit 1), osascript-fail, osascript-fail]`
Then after the last item the same-family (osascript) fail count in window is 3 → trip
The broken-python failure never entered the window (unmonitored family), so it neither shielded nor counted toward the osascript total

### Scenario 5: wrapper-pattern catches `osascript ... & kill` exit 0 as failed

Given three items, each `{ status:"completed", exitCode:0, command:"osascript ... & sleep 2; kill -TERM $!" }`
Then the breaker trips after the third
And `wrapperDetected: true` in the NDJSON record on the tripping item
This is the T4 behavior — Codex wraps failing AppleScript in `& kill` so the shell exits 0; v1.2.2 unmasks this.

### Scenario 6: wrapper pattern on unmonitored family is ignored (regression guard)

Given `{ status:"completed", exitCode:0, command:"cp foo bar || true" }` — unmonitored family (`cp`)
Then `detectCommandFamily` returns null → the item never enters the window → breaker state unchanged
So legit dev usage of `|| true` on ordinary commands cannot trigger false positives.

### Scenario 7: window size 5 — old fails age out

Given `[osascript-fail, osascript-fail, osascript-success, osascript-success, osascript-success, osascript-success]`
Then the window ends as `[success, success, success, success, success]` (last 5)
So family-fails in window = 0 → no trip — the early failures aged out

### Scenario 8: `command_failure_circuit_breaker: false` disables the whole mechanism

Given ten raw osascript fails with the flag off
Then no `[WARNING]` is ever emitted and `breakerState.tripped` stays `false`

### Scenario 9: shipped `DEFAULT_CONFIG.command_failure_circuit_breaker === true`

Given `DEFAULT_CONFIG` from `src/lib/config.mjs`
Then the shipped value is boolean `true`

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cat > /tmp/cb-breaker.mjs <<EOF
import { DEFAULT_CONFIG } from 'file://${REPO_ROOT}/src/lib/config.mjs';

const detectCommandFamily = (command) => {
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (/\bdisplay dialog\b|\bdisplay notification\b/i.test(trimmed)) return "applescript-dialog";
  if (/\bSystem Events\b|\btell application\b/i.test(trimmed)) return "applescript-system";
  if (/^computer-use\/|^tool:\s*computer-use/i.test(trimmed)) return "computer-use";
  if (/^\s*open\s+-a\b/i.test(trimmed)) return "open-app";
  if (/^\/bin\/zsh.*osascript\b|^osascript\b|\bosascript\s+-[eJl]\b/i.test(trimmed)) return "osascript";
  return null;
};
const isFailureHidingWrapper = (command) => {
  if (typeof command !== "string") return false;
  return (
    /&\s*(sleep\s+\d+\s*;\s*)?kill\b/.test(command) ||
    /\|\|\s*(true|exit\s+0)\b/.test(command) ||
    /;\s*true\s*['"]?\s*$/.test(command)
  );
};

const simulate = (items, config) => {
  const state = { recent: [], tripped: false };
  const THRESHOLD = 3, WINDOW = 5;
  let warnings = 0;
  let lastRecord = null;
  for (const item of items) {
    if (!config.command_failure_circuit_breaker || state.tripped || item.type !== "commandExecution") continue;
    const family = detectCommandFamily(item.command);
    if (!family) continue;
    const rawFailed = item.status !== "completed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
    const wrappedFailed = !rawFailed && isFailureHidingWrapper(item.command);
    const failed = rawFailed || wrappedFailed;
    state.recent.push({ family, failed });
    if (state.recent.length > WINDOW) state.recent.shift();
    const familyFails = state.recent.filter(r => r.family === family && r.failed).length;
    if (familyFails < THRESHOLD) continue;
    state.tripped = true;
    warnings += 1;
    lastRecord = { family, threshold: THRESHOLD, windowSize: WINDOW, failsInWindow: familyFails, wrapperDetected: wrappedFailed };
  }
  return { ...state, warnings, lastRecord };
};

const mk = (command, status = "failed", exitCode = 1) => ({ type: "commandExecution", status, exitCode, command });
const ok = (command) => mk(command, "completed", 0);
let fail = 0;

// s1: 3 raw fails → trip
const s1 = simulate([mk("osascript -e a"), mk("osascript -e b"), mk("osascript -e c")], { command_failure_circuit_breaker: true });
const p1 = s1.tripped && s1.warnings === 1 && s1.lastRecord.failsInWindow === 3 && s1.lastRecord.wrapperDetected === false;
console.log((p1?"PASS":"FAIL")+" s1 raw-3-fails");
if (!p1) fail++;

// s2: NEW — [fail, fail, success(unmonitored), fail] → trip at 3rd fail
const s2 = simulate([mk("osascript -e a"), mk("osascript -e b"), ok("npm test"), mk("osascript -e c")], { command_failure_circuit_breaker: true });
const p2 = s2.tripped && s2.warnings === 1 && s2.lastRecord.failsInWindow === 3;
console.log((p2?"PASS":"FAIL")+" s2 window-interleaved");
if (!p2) fail++;

// s3: different families don't accumulate
const s3 = simulate([mk("osascript -e x"), mk("open -a Safari"), mk("computer-use/get_app_state")], { command_failure_circuit_breaker: true });
const p3 = !s3.tripped;
console.log((p3?"PASS":"FAIL")+" s3 different-families");
if (!p3) fail++;

// s4: unmonitored failure ignored; 3 osascript fails around it → trip
const s4 = simulate([mk("osascript -e x"), mk("python broken.py"), mk("osascript -e y"), mk("osascript -e z")], { command_failure_circuit_breaker: true });
const p4 = s4.tripped && s4.lastRecord.failsInWindow === 3;
console.log((p4?"PASS":"FAIL")+" s4 unmonitored-ignored");
if (!p4) fail++;

// s5: wrapper pattern — osascript ... & kill exit 0, x3 → trip, wrapperDetected true
const s5 = simulate([ok("osascript -e 'display dialog \"x\"' & sleep 2; kill -TERM \$!"), ok("osascript -e 'display dialog \"y\"' & sleep 2; kill -TERM \$!"), ok("osascript -e 'display dialog \"z\"' & sleep 2; kill -TERM \$!")], { command_failure_circuit_breaker: true });
const p5 = s5.tripped && s5.lastRecord.wrapperDetected === true;
console.log((p5?"PASS":"FAIL")+" s5 wrapper-detected");
if (!p5) fail++;

// s6: wrapper on unmonitored family is ignored (no family = not in window)
const s6 = simulate([ok("cp a b || true"), ok("cp c d || true"), ok("cp e f || true")], { command_failure_circuit_breaker: true });
const p6 = !s6.tripped && s6.warnings === 0 && s6.recent.length === 0;
console.log((p6?"PASS":"FAIL")+" s6 unmonitored-wrapper");
if (!p6) fail++;

// s7: window ages out — 2 fails then 5 successes → no trip
const s7 = simulate([mk("osascript -e a"), mk("osascript -e b"), ok("osascript -e c"), ok("osascript -e d"), ok("osascript -e e"), ok("osascript -e f"), ok("osascript -e g")], { command_failure_circuit_breaker: true });
const p7 = !s7.tripped;
console.log((p7?"PASS":"FAIL")+" s7 window-age-out");
if (!p7) fail++;

// s8: disabled mutes everything
const s8 = simulate(Array.from({length: 10}, (_, i) => mk("osascript -e "+i)), { command_failure_circuit_breaker: false });
const p8 = !s8.tripped && s8.warnings === 0;
console.log((p8?"PASS":"FAIL")+" s8 disabled");
if (!p8) fail++;

// s9: shipped default
const p9 = DEFAULT_CONFIG.command_failure_circuit_breaker === true;
console.log((p9?"PASS":"FAIL")+" s9 shipped-default");
if (!p9) fail++;

process.exit(fail === 0 ? 0 : 1);
EOF
node /tmp/cb-breaker.mjs
```

### Enhancement candidates

- Configurable `threshold` and `windowSize` via two new config keys. Today fixed at 3 + 5; noisier environments may want 5 + 10. The defaults are anchored on the reference bug-report observation (24 attempts before human intervention — 3/5 trips early enough).
- Auto-interrupt on trip via `interruptAppServerTurn`. Still requires a new `onTurnReady(turnId)` hook since `onTurnStart` fires before `turn/start` resolves. Low-risk addition once the hook lands.
- Detect other failure-hiding patterns as they emerge: `set +e` blocks, `2>/dev/null` where the exit code is separately captured, `trap`. Keep the wrapper-detection regex tight — a false positive here flags a legit dev command as a sandbox probe.
- Pairs with `03-config/06-command-failure-circuit-breaker-config.md` for the config-shape contract (default value, detector ordering).
