# 04-sandbox-policy-danger-full-access

**Derived from:** `src/lib/config.mjs:132-170` (`buildSandboxPolicy(mode, config)` now consults `config.sandbox_policy`; unknown values fall back to mode-derived default), `src/codex-bridge.mjs:1527-1529` (`runBridgeTask` passes config), `src/codex-bridge.mjs:2473` (`send` handler passes config), `src/lib/auto-pipeline.mjs:112` (auto-pipeline fix stage passes config; the completion-check stage at `auto-pipeline.mjs:151` remains hard-coded `readOnly`), `skill/config.yaml` (user-facing documentation), `skill/references/config-reference.md` ("sandbox_policy" section).
**What this catches:** the pre-fix bridge offered only `read-only` and `workspace-write` sandboxes. `workspace-write` blocks writes to `.git/`, so a Codex turn asked to commit its own work failed with a raw POSIX error that Codex frequently misinterpreted (attempting `osascript` / `display dialog` etc. to recover). Users with `codex --dangerously-bypass-approvals-and-sandbox` set as a shell alias expected the bridge to mirror that; it did not. The fix adds a `sandbox_policy` config key that can emit upstream `SandboxPolicy::DangerFullAccess` (`{type:"dangerFullAccess"}`) without changing defaults.
**Runtime cost:** fast — exercises `buildSandboxPolicy` directly in node, no Codex spawn.
**Test subject:** pure unit test against the exported `buildSandboxPolicy`. No broker, no turn.

## Feature: config.sandbox_policy overrides the mode-derived sandbox

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
```

And `npm run build` has been run since the last `src/` edit.

### Scenario 1: default unset falls through to mode-derived policy (regression guard)

Given `buildSandboxPolicy` is imported from `src/lib/config.mjs`
When called as `buildSandboxPolicy("plan", {})`
Then the result is `{ type: "readOnly" }`
When called as `buildSandboxPolicy("default", {})`
Then the result is `{ type: "workspaceWrite" }`

### Scenario 2: `sandbox_policy: "danger-full-access"` emits upstream DangerFullAccess

When called as `buildSandboxPolicy("default", { sandbox_policy: "danger-full-access" })`
Then the result is `{ type: "dangerFullAccess" }`
When called as `buildSandboxPolicy("plan", { sandbox_policy: "danger-full-access" })`
Then the result is still `{ type: "dangerFullAccess" }` — the override wins over the mode

### Scenario 3: explicit `"read-only"` and `"workspace-write"` values are honored

When called as `buildSandboxPolicy("default", { sandbox_policy: "read-only" })`
Then the result is `{ type: "readOnly" }` (override narrows default-mode's write policy)
When called as `buildSandboxPolicy("plan", { sandbox_policy: "workspace-write" })`
Then the result is `{ type: "workspaceWrite" }` (override widens plan-mode's read-only)

### Scenario 4: unknown override silently falls back to mode-derived default (safety)

When called as `buildSandboxPolicy("plan", { sandbox_policy: "nonsense" })`
Then the result is `{ type: "readOnly" }` (unknown value never widens permissions)
When called as `buildSandboxPolicy("default", { sandbox_policy: "danger_full_access" })` (wrong spelling with underscore)
Then the result is `{ type: "workspaceWrite" }` (no match on the allow-list → default)

### Scenario 5: null / missing config is equivalent to unset

When called as `buildSandboxPolicy("default", null)` or `buildSandboxPolicy("default")` (no second arg)
Then both return `{ type: "workspaceWrite" }`

### Scenario 6: shipped DEFAULT_CONFIG ships with `sandbox_policy: "danger-full-access"`

Given `DEFAULT_CONFIG` is imported from `src/lib/config.mjs`
Then `DEFAULT_CONFIG.sandbox_policy === "danger-full-access"`
And `buildSandboxPolicy("plan", DEFAULT_CONFIG)` returns `{ type: "dangerFullAccess" }`
And `buildSandboxPolicy("default", DEFAULT_CONFIG)` returns `{ type: "dangerFullAccess" }`

This pins the shipped default: new installs get no sandbox blocker. Users who want a stricter profile set `sandbox_policy: "workspace-write"` or `"read-only"` in their `config.yaml` (the workspace/cwd layers override `DEFAULT_CONFIG`).

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cat > /tmp/cb-sandbox.mjs <<'EOF'
import { buildSandboxPolicy } from 'file://REPO/src/lib/config.mjs';
const cases = [
  { name: 'plan-unset',      args: ['plan', {}],                                    expect: { type: 'readOnly' } },
  { name: 'default-unset',   args: ['default', {}],                                 expect: { type: 'workspaceWrite' } },
  { name: 'default+danger',  args: ['default', { sandbox_policy: 'danger-full-access' }], expect: { type: 'dangerFullAccess' } },
  { name: 'plan+danger',     args: ['plan',    { sandbox_policy: 'danger-full-access' }], expect: { type: 'dangerFullAccess' } },
  { name: 'default+ro',      args: ['default', { sandbox_policy: 'read-only' }],    expect: { type: 'readOnly' } },
  { name: 'plan+ww',         args: ['plan',    { sandbox_policy: 'workspace-write' }], expect: { type: 'workspaceWrite' } },
  { name: 'plan+unknown',    args: ['plan',    { sandbox_policy: 'nonsense' }],     expect: { type: 'readOnly' } },
  { name: 'default+typo',    args: ['default', { sandbox_policy: 'danger_full_access' }], expect: { type: 'workspaceWrite' } },
  { name: 'default+null',    args: ['default', null],                               expect: { type: 'workspaceWrite' } },
  { name: 'default+noarg',   args: ['default'],                                     expect: { type: 'workspaceWrite' } },
];
// Scenario 6: shipped default pinning — imports DEFAULT_CONFIG and asserts the key + resolution.
import('file://REPO/src/lib/config.mjs').then(({ DEFAULT_CONFIG, buildSandboxPolicy }) => {
  const cfgHasDefault = DEFAULT_CONFIG.sandbox_policy === 'danger-full-access';
  const planResolvesToDanger = buildSandboxPolicy('plan', DEFAULT_CONFIG).type === 'dangerFullAccess';
  const execResolvesToDanger = buildSandboxPolicy('default', DEFAULT_CONFIG).type === 'dangerFullAccess';
  const ok = cfgHasDefault && planResolvesToDanger && execResolvesToDanger;
  console.log((ok ? 'PASS' : 'FAIL') + ' shipped-default cfg=' + DEFAULT_CONFIG.sandbox_policy + ' plan=' + planResolvesToDanger + ' exec=' + execResolvesToDanger);
});
let fail = 0;
for (const c of cases) {
  const r = buildSandboxPolicy(...c.args);
  const ok = r.type === c.expect.type;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + c.name + ' => ' + r.type);
  if (!ok) fail++;
}
process.exit(fail === 0 ? 0 : 1);
EOF
sed -i '' "s|file://REPO|file://${REPO_ROOT}|" /tmp/cb-sandbox.mjs
node /tmp/cb-sandbox.mjs
```

### Enhancement candidates

- Add a `--sandbox <policy>` CLI flag on `task` and `send` so a single run can opt in without editing `config.yaml`. Cost: arg-parsing surface on two handlers + validation. Not currently needed — the config override is sufficient for the reported use case.
- Consider allowing `sandbox_policy: "external-sandbox"` if users opt into upstream's `SandboxPolicy::ExternalSandbox`. Requires UX for the elevated trust prompt (see `src/lib/AGENTS.md` sandbox section).
- The completion-check stage hard-codes `{type: "readOnly"}` at `src/lib/auto-pipeline.mjs:151`. If a future user wants the completion check to also observe `.git/` state under `dangerFullAccess`, pipe the config through — for now the safe-by-design read-only check stands.
