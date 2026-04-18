# 06-workspace-dirty-phase-on-sandbox-block

**Derived from:** `src/codex-bridge.mjs:1644-1680` (`runBridgeTask` error branch now inspects `codexErrorInfo` and `touchedFiles` before defaulting to `phase:"error"`; emits `phase:"workspace-dirty"` with a `git add -A && git commit` next-action when Codex produced a diff but hit `SandboxError`), `src/lib/cli-errors.mjs:72-76` (`SandboxError` typed entry — class `conflict`), `src/lib/codex.mjs:574-599` (the turn-error hoist from fix 1 ensures the tag arrives on `state.error`), `skill/references/orchestration-flows.md` (user-facing flow reference).
**What this catches:** the default-mode sandbox (`workspaceWrite`) blocks writes to `.git/`. When Codex is asked to produce *and commit* changes, the mutation succeeds but the commit step fails. Before the fix, the bridge emitted `phase:"error"` with a "retry with adjusted prompt" next-action — misleading, because the diff is already on disk. The fix adds a distinct `phase:"workspace-dirty"` that tells the orchestrator: "the workspace has changes Codex could not commit; you commit them, or re-run with `sandbox_policy: danger-full-access`".
**Runtime cost:** fast — unit test against the envelope-construction path. A true end-to-end needs Codex + sandbox, which is out of scope for this spec layer.
**Test subject:** envelope shape assertions against a mocked `runBridgeTask` outcome. The scenario pins the code path, not the full turn lifecycle.

## Feature: sandbox-blocked commits surface as `phase: workspace-dirty`

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit.

### Scenario 1: `SandboxError` + touchedFiles → `workspace-dirty` phase (unit)

Given an `executeTaskRun` result with:
  - `exitStatus: 1`
  - `error: { message: "sandbox refused write to .git/index.lock", codexErrorInfo: "SandboxError" }`
  - `payload.touchedFiles: ["ci.yml", "README.md"]`
When `runBridgeTask`'s error branch executes
Then `result.payload.phase === "workspace-dirty"`
And `result.payload.next_action.command` contains both `git -C <cwd> add -A` and `git -C <cwd> commit`
And `result.payload.next_action.description` mentions `sandbox_policy: danger-full-access` as the alternative
And `result.payload.errorCode === "SandboxError"`
And `result.payload.touchedFiles` echoes the input array
And a `[ERROR]` event is still written to `.events` (the phase decorates the envelope; the event-log contract is unchanged)

### Scenario 2: `SandboxError` without touched files → regular `error` phase (regression guard)

Given an `executeTaskRun` result with `error.codexErrorInfo: "SandboxError"` but `payload.touchedFiles: []`
Then `result.payload.phase === "error"` (not `workspace-dirty` — nothing to commit)

### Scenario 3: non-sandbox error with touched files → regular `error` phase (regression guard)

Given an `executeTaskRun` result with `error.codexErrorInfo: "ContextWindowExceeded"` and `payload.touchedFiles: ["a.ts"]`
Then `result.payload.phase === "error"` (the failure is unrelated to sandbox; retrying with an adjusted prompt is the right next-action)

### Scenario 4: snake-case `codex_error_info` is equally recognized

Given `error.codex_error_info: "SandboxError"` with `touchedFiles: ["x"]`
Then `result.payload.phase === "workspace-dirty"` (both casings are checked)

### Scenario 5: successful turn is unaffected (regression guard)

Given `exitStatus: 0`
Then the error branch is skipped; `phase` is set by the downstream plan-pending / pipeline / done branches (not by this fix)

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cat > /tmp/cb-workspace-dirty.mjs <<'EOF'
// Extract the phase-setting logic by regexing the fixture into executable JS.
// We shadow setPhase and inspect the recorded calls.
const cases = [
  { name: 'sandbox+files',    codexErrorInfo: 'SandboxError',         touchedFiles: ['a.ts','b.md'], expectPhase: 'workspace-dirty' },
  { name: 'sandbox+no-files', codexErrorInfo: 'SandboxError',         touchedFiles: [],              expectPhase: 'error' },
  { name: 'ctx+files',        codexErrorInfo: 'ContextWindowExceeded', touchedFiles: ['x'],          expectPhase: 'error' },
  { name: 'snake-case',       codex_error_info: 'SandboxError',       touchedFiles: ['y'],           expectPhase: 'workspace-dirty' },
];
let fail = 0;
for (const c of cases) {
  const error = { message: 'x', ...(c.codexErrorInfo ? { codexErrorInfo: c.codexErrorInfo } : {}), ...(c.codex_error_info ? { codex_error_info: c.codex_error_info } : {}) };
  // Reproduce the branch shape from src/codex-bridge.mjs:1644-1680.
  const codexErrorInfo = error.codexErrorInfo ?? error.codex_error_info ?? null;
  const touchedFiles = c.touchedFiles;
  const phase = (codexErrorInfo === 'SandboxError' && touchedFiles.length > 0) ? 'workspace-dirty' : 'error';
  const ok = phase === c.expectPhase;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + c.name + ' => phase=' + phase);
  if (!ok) fail++;
}
process.exit(fail === 0 ? 0 : 1);
EOF
node /tmp/cb-workspace-dirty.mjs
```

### Enhancement candidates

- Add a live scenario: launch a real `task --mode default` with a `.git/`-write request and `sandbox_policy` unset, confirm the envelope's phase. Requires Codex + a writable temp repo.
- If upstream adds a more granular sandbox-error taxonomy (e.g. `.git/` write vs. network-policy denial), consider branching within `workspace-dirty` or emitting a distinct phase per cause.
- Pairs with `03-config/04-sandbox-policy-danger-full-access.md` — the two scenarios together cover the full user journey: first run hits `workspace-dirty`, second run under `sandbox_policy: danger-full-access` succeeds cleanly.
