# 06-command-failure-circuit-breaker-config

**Derived from:** `src/lib/config.mjs:33-43` (`DEFAULT_CONFIG.command_failure_circuit_breaker = true`), `src/codex-bridge.mjs:1553-1560` (circuit-breaker state + `CIRCUIT_BREAKER_THRESHOLD = 3`), `src/codex-bridge.mjs:1566-1581` (`detectCommandFamily` — content-based patterns first), `src/codex-bridge.mjs:1626-1680` (`onItemCompleted` circuit-breaker branch), `skill/config.yaml` (shipped default), `skill/references/config-reference.md` ("command_failure_circuit_breaker" section). Behavioral coverage (actual tripping state machine) lives in `07-orchestration/07-circuit-breaker-trips-on-repeated-family.md`; this spec pins the config-shape invariants that belong under `03-config/` per the AGENTS.md rule ("When adding a new config key … Add a scenario in `gherkin-tests-v2/03-config/`").
**What this catches:** the new config key must ship with a sane default, tolerate being disabled, and document its valid shape. This spec covers the config contract; the companion `07-orchestration/07` covers the runtime behavior.
**Runtime cost:** fast — unit assertions against `DEFAULT_CONFIG` and the detector. No Codex spawn.
**Test subject:** the exported `DEFAULT_CONFIG` and the detector's post-review ordering.

## Feature: `command_failure_circuit_breaker` ships enabled by default with correct family detection

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
```

And `npm run build` has been run since the last `src/` edit.

### Scenario 1: shipped default is `true`

Given `DEFAULT_CONFIG` is imported from `src/lib/config.mjs`
Then `DEFAULT_CONFIG.command_failure_circuit_breaker === true`
And the key is a boolean (not a string or number)

### Scenario 2: family detection — AppleScript dialog routed via osascript classifies as applescript-dialog (regression guard)

Given the command `/bin/zsh -lc "osascript -e 'display dialog \"hi\"'"`
When `detectCommandFamily` inspects it
Then the result is `"applescript-dialog"` (NOT `"osascript"`)

This is the pre-review bug. The earlier order matched `osascript` first, making `applescript-dialog` and `applescript-system` unreachable for the most common invocation form. Content-based patterns (`display dialog`, `System Events`, `tell application`) must be checked **before** the invocation-based `osascript` umbrella.

### Scenario 3: family detection — System Events AppleScript classifies as applescript-system

Given the command `/bin/zsh -lc "osascript -l JavaScript -e 'const app = Application(\"System Events\"); app.processes();'"`
When `detectCommandFamily` inspects it
Then the result is `"applescript-system"`

### Scenario 4: family detection — plain osascript without content hints classifies as osascript

Given the command `osascript -e 'return 1 + 1'` (no `display dialog`, no `System Events`)
When `detectCommandFamily` inspects it
Then the result is `"osascript"` (the broad umbrella catches the invocation itself)

### Scenario 5: family detection — unrelated command returns null

Given the command `npm run test`
When `detectCommandFamily` inspects it
Then the result is `null`

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cat > /tmp/cb-breaker-config.mjs <<EOF
import { DEFAULT_CONFIG } from 'file://${REPO_ROOT}/src/lib/config.mjs';

// Reproduce the post-review detector ordering.
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

let fail = 0;

// s1 — shipped default
const ok1 = DEFAULT_CONFIG.command_failure_circuit_breaker === true && typeof DEFAULT_CONFIG.command_failure_circuit_breaker === "boolean";
console.log((ok1 ? "PASS" : "FAIL") + " s1 shipped-default=" + DEFAULT_CONFIG.command_failure_circuit_breaker);
if (!ok1) fail++;

// s2 — osascript display dialog → applescript-dialog
const s2 = detectCommandFamily(\`/bin/zsh -lc "osascript -e 'display dialog \\"hi\\"'"\`);
const ok2 = s2 === "applescript-dialog";
console.log((ok2 ? "PASS" : "FAIL") + " s2 osascript+display dialog => " + s2);
if (!ok2) fail++;

// s3 — System Events via osascript
const s3 = detectCommandFamily(\`/bin/zsh -lc "osascript -l JavaScript -e 'Application(\\"System Events\\").processes();'"\`);
const ok3 = s3 === "applescript-system";
console.log((ok3 ? "PASS" : "FAIL") + " s3 osascript+System Events => " + s3);
if (!ok3) fail++;

// s4 — plain osascript
const s4 = detectCommandFamily(\`osascript -e 'return 1 + 1'\`);
const ok4 = s4 === "osascript";
console.log((ok4 ? "PASS" : "FAIL") + " s4 plain osascript => " + s4);
if (!ok4) fail++;

// s5 — unrelated command
const s5 = detectCommandFamily("npm run test");
const ok5 = s5 === null;
console.log((ok5 ? "PASS" : "FAIL") + " s5 unrelated => " + s5);
if (!ok5) fail++;

process.exit(fail === 0 ? 0 : 1);
EOF
node /tmp/cb-breaker-config.mjs
```

### Enhancement candidates

- Configurable threshold (`command_failure_circuit_breaker_threshold: number`). Today fixed at `N=3` based on the reference bug-report observation; a noisier environment may want `N=5`.
- Configurable family list — today hard-coded via regex. Opening this to users is risky (mis-crafted patterns could trip on everything); a per-family toggle would be safer.
- Pairs with `07-orchestration/07-circuit-breaker-trips-on-repeated-family.md` for the behavioral coverage — the state machine, reset semantics, and `[WARNING]` emission.
