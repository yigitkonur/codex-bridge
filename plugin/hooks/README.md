# Bridge hook output convention

All hooks MUST use the wrapped `hookSpecificOutput` envelope. Bare-shape
output (e.g., `{"additionalContext":"..."}`) is silently dropped by the
platform when wrapped-form hooks coexist on the same matcher (platform issue
#53682). The bridge has multiple hooks; mixing shapes causes silent output loss.

## Canonical form

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "..."
  }
}
```

## Usage

Use the helpers in `lib/hook-format.mjs`:

```js
import { emit, emitDeny, emitAllow, emitContextInjection } from "./lib/hook-format.mjs";

// Inject context into PostToolUse
emitContextInjection("PostToolUse", "Arm Monitor with: ...");

// Deny a tool call
emitDeny("This invocation is forbidden by sandbox policy");

// Allow with updated input
emitAllow("Auto-approved", { command: rewrittenCommand });

// Emit a Stop block decision
emit("Stop", { decision: "block", reason: "pending review verdicts" });
```

Never write bare shapes via `process.stdout.write(JSON.stringify({...}))` directly.
The `lib/hook-format.mjs` helpers are the only approved output path.

## Migration

Hooks that previously emitted:

```js
process.stdout.write(JSON.stringify({ additionalContext: "..." }));
```

should use:

```js
emitContextInjection("PostToolUse", "...");
```

And hooks that emitted bare `{ decision: "block", reason: "..." }` for Stop
events should use:

```js
emit("Stop", { decision: "block", reason: "..." });
```
