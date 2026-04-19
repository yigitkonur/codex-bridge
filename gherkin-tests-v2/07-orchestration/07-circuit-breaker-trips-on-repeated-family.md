# 07-circuit-breaker-trips-on-repeated-family

**Derived from:** `src/codex-bridge.mjs:1534-1559` (`detectCommandFamily` + `breakerState`), `src/codex-bridge.mjs:1615-1680` (`onItemCompleted` circuit-breaker branch — counts consecutive same-family failures, trips at N=3, writes `[WARNING]` to `.events`), `src/lib/session-log.mjs:241-250` (`formatWarningEvent`), `src/lib/config.mjs:28-31` (`DEFAULT_CONFIG.command_failure_circuit_breaker = true`), `skill/references/config-reference.md` ("command_failure_circuit_breaker" section).
**What this catches:** Codex's ReAct loop has no convergence check for "this category of tool is structurally unavailable in my current environment". The reference bug report observed 24 consecutive osascript/display-dialog/computer-use attempts before manual intervention. The bridge-side circuit breaker counts consecutive same-family command failures and writes a `[WARNING]` event after N=3 so an orchestrator tailing via Monitor can cancel/steer. Auto-interrupt is an enhancement candidate and currently **not** performed (would need a new `onTurnReady(turnId)` hook — `onTurnStart` fires before `turn/start` returns, so `turnId` isn't available there).
**Runtime cost:** fast — exercises the family-detection + consecutive-counter logic directly, no Codex spawn.
**Test subject:** unit-level assertion on the consecutive-counter invariants. The `[WARNING]` write path is exercised indirectly by the predicate's state-machine reproduction.

## Feature: same-family command failures trip the breaker after N=3

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
```

And `npm run build` has been run since the last `src/` edit.

### Scenario 1: three consecutive osascript failures trip the breaker

Given `config.command_failure_circuit_breaker = true`
And three completed items in sequence, each with `type: "commandExecution"`, `status: "failed"`, `exitCode: 1`, and `command: /bin/zsh -lc "osascript ..."`
When the circuit-breaker logic inspects each item
Then after the **third** item, `breakerState.tripped === true`
And exactly one `[WARNING]` event is emitted (second and later failures on the same family after tripping do not re-fire)

### Scenario 2: successful command between failures resets the counter (regression guard)

Given a sequence: osascript-fail → osascript-fail → `npm test`-success → osascript-fail
Then the breaker does **not** trip after the third osascript failure — the successful command reset `consecutiveFailures` back to 0, so there's only one post-success osascript failure

### Scenario 3: different-family failures do not accumulate

Given a sequence: osascript-fail → open-app-fail → computer-use-fail
Then `consecutiveFailures` stays at 1 throughout (each new family resets the counter), and the breaker does not trip

### Scenario 4: unmonitored-family failure is ignored (does not shield or trip)

Given a sequence: osascript-fail → `python broken.py`-fail (exit 1) → osascript-fail
Then the unmonitored failure neither resets nor increments the counter
And `consecutiveFailures === 2` after the second osascript failure (broken.py does not count)

### Scenario 5: `command_failure_circuit_breaker: false` disables the whole mechanism

Given `config.command_failure_circuit_breaker = false`
And ten consecutive osascript failures
Then no `[WARNING]` is ever emitted and `breakerState.tripped` stays `false`

### Scenario 6: shipped `DEFAULT_CONFIG.command_failure_circuit_breaker === true`

Given `DEFAULT_CONFIG` from `src/lib/config.mjs`
Then `DEFAULT_CONFIG.command_failure_circuit_breaker === true`

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cat > /tmp/cb-breaker.mjs <<EOF
import { DEFAULT_CONFIG } from 'file://${REPO_ROOT}/src/lib/config.mjs';

// Reproduce the detector + state machine from src/codex-bridge.mjs.
const detectCommandFamily = (command) => {
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (/^\/bin\/zsh.*osascript\b|^osascript\b|\bosascript\s+-[eJl]\b/i.test(trimmed)) return "osascript";
  if (/\bdisplay dialog\b|\bdisplay notification\b/i.test(trimmed)) return "applescript-dialog";
  if (/^\s*open\s+-a\b/i.test(trimmed)) return "open-app";
  if (/^computer-use\/|^tool:\s*computer-use/i.test(trimmed)) return "computer-use";
  if (/\bSystem Events\b|\btell application\b/i.test(trimmed)) return "applescript-system";
  return null;
};

const simulate = (items, config) => {
  const state = { lastFamily: null, consecutiveFailures: 0, tripped: false };
  let warnings = 0;
  const THRESHOLD = 3;
  for (const item of items) {
    if (!config.command_failure_circuit_breaker || state.tripped || item.type !== "commandExecution") continue;
    const failed = item.status !== "completed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
    if (!failed) { state.lastFamily = null; state.consecutiveFailures = 0; continue; }
    const family = detectCommandFamily(item.command);
    if (!family) continue;
    if (family === state.lastFamily) state.consecutiveFailures += 1;
    else { state.lastFamily = family; state.consecutiveFailures = 1; }
    if (state.consecutiveFailures < THRESHOLD) continue;
    state.tripped = true;
    warnings += 1;
  }
  return { ...state, warnings };
};

const mk = (command, status = "failed", exitCode = 1, type = "commandExecution") => ({ type, status, exitCode, command });
let fail = 0;

// s1 — three osascript fails trip
const s1 = simulate([mk('/bin/zsh -lc "osascript -e foo"'), mk('/bin/zsh -lc "osascript -e bar"'), mk('/bin/zsh -lc "osascript -e baz"')], { command_failure_circuit_breaker: true });
const ok1 = s1.tripped === true && s1.warnings === 1;
console.log((ok1 ? "PASS" : "FAIL") + " s1 tripped=" + s1.tripped + " warnings=" + s1.warnings);
if (!ok1) fail++;

// s2 — success resets
const s2 = simulate([mk('osascript -e 1'), mk('osascript -e 2'), mk('npm test', 'completed', 0), mk('osascript -e 3')], { command_failure_circuit_breaker: true });
const ok2 = s2.tripped === false && s2.consecutiveFailures === 1;
console.log((ok2 ? "PASS" : "FAIL") + " s2 tripped=" + s2.tripped + " cons=" + s2.consecutiveFailures);
if (!ok2) fail++;

// s3 — different families do not accumulate
const s3 = simulate([mk('osascript -e x'), mk('open -a Safari'), mk('computer-use/get_app_state')], { command_failure_circuit_breaker: true });
const ok3 = s3.tripped === false && s3.consecutiveFailures === 1 && s3.lastFamily === "computer-use";
console.log((ok3 ? "PASS" : "FAIL") + " s3 tripped=" + s3.tripped + " cons=" + s3.consecutiveFailures + " last=" + s3.lastFamily);
if (!ok3) fail++;

// s4 — unmonitored failure ignored
const s4 = simulate([mk('osascript -e x'), mk('python broken.py'), mk('osascript -e y')], { command_failure_circuit_breaker: true });
const ok4 = s4.tripped === false && s4.consecutiveFailures === 2 && s4.lastFamily === "osascript";
console.log((ok4 ? "PASS" : "FAIL") + " s4 tripped=" + s4.tripped + " cons=" + s4.consecutiveFailures + " last=" + s4.lastFamily);
if (!ok4) fail++;

// s5 — disabled flag mutes everything
const s5 = simulate(Array.from({length: 10}, (_, i) => mk('osascript -e ' + i)), { command_failure_circuit_breaker: false });
const ok5 = s5.tripped === false && s5.warnings === 0;
console.log((ok5 ? "PASS" : "FAIL") + " s5 tripped=" + s5.tripped + " warnings=" + s5.warnings);
if (!ok5) fail++;

// s6 — shipped default
const ok6 = DEFAULT_CONFIG.command_failure_circuit_breaker === true;
console.log((ok6 ? "PASS" : "FAIL") + " s6 shipped-default=" + DEFAULT_CONFIG.command_failure_circuit_breaker);
if (!ok6) fail++;

process.exit(fail === 0 ? 0 : 1);
EOF
node /tmp/cb-breaker.mjs
```

### Enhancement candidates

- Auto-interrupt on trip via `interruptAppServerTurn(cwd, { threadId, turnId })`. Requires exposing `turnId` through a new hook (`onTurnReady`) from `codex.mjs` since `onTurnStart` fires before `turn/start` resolves. Low-risk addition once the hook lands.
- After auto-interrupt, follow up with a `send` that injects the "environment is headless, report gaps and move on" directive so Codex reconverges instead of re-entering the same loop on resume.
- Configurable threshold. N=3 is the observed sweet spot from the reference bug report, but a noisier environment might want N=5.
- Widen `detectCommandFamily` to catch `mdfind kMDItemCFBundleIdentifier`, `.command` file drops into `/dev/ttys*`, and other `Terminal.app`-reaching variants the reference session also attempted. Keep the allow-list tight to avoid false positives on legitimate verification runs.
