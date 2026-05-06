// hooks/lib/hook-format.mjs
// Single canonical hook-output emitter. Always wraps in hookSpecificOutput.
// See hooks/README.md for the bare-shape silent-drop issue this fixes.

/**
 * Emit a wrapped hookSpecificOutput envelope to stdout.
 * @param {string} eventName - The hook event name (e.g. "PreToolUse", "PostToolUse", "Stop").
 * @param {object} payload - Additional fields merged into hookSpecificOutput.
 */
export function emit(eventName, payload = {}) {
  const wrapped = {
    hookSpecificOutput: {
      hookEventName: eventName,
      ...payload,
    },
  };
  process.stdout.write(JSON.stringify(wrapped) + "\n");
}

/**
 * Emit a continue-only response with no hook-specific output.
 */
export function emitContinue() {
  process.stdout.write('{"continue":true}');
}

/**
 * Emit a PreToolUse deny decision.
 * @param {string} reason - Human-readable reason for the denial.
 * @param {object} details - Additional fields (e.g. additionalContext, updatedInput).
 */
export function emitDeny(reason, details = {}) {
  emit("PreToolUse", {
    permissionDecision: "deny",
    permissionDecisionReason: reason,
    ...details,
  });
}

/**
 * Emit a PreToolUse allow decision.
 * @param {string|null} reason - Optional human-readable reason.
 * @param {object|null} updatedInput - Optional mutated input to substitute.
 */
export function emitAllow(reason = null, updatedInput = null) {
  emit("PreToolUse", {
    permissionDecision: "allow",
    ...(reason && { permissionDecisionReason: reason }),
    ...(updatedInput && { updatedInput }),
  });
}

/**
 * Emit a context-injection payload for PostToolUse or other events.
 * @param {string} eventName - The hook event name.
 * @param {string} additionalContext - Context text to inject.
 */
export function emitContextInjection(eventName, additionalContext) {
  emit(eventName, { additionalContext });
}
