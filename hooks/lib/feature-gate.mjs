// Shared kill-switch helper for codex-bridge hook scripts.
//
// CODEX_BRIDGE_HOOK_DISABLE accepts a comma-separated list of hook names.
// Any element matching the caller's hook name OR the literal "all" disables
// the hook for that invocation, giving operators an emergency escape hatch
// without editing config or removing the plugin.
//
// Usage in a hook script:
//
//   import { isDisabled } from "./lib/feature-gate.mjs";
//   if (isDisabled("session-lifecycle-hook")) process.exit(0);

import process from "node:process";

/**
 * Returns true when the hook named `hookName` should be skipped.
 *
 * The CODEX_BRIDGE_HOOK_DISABLE env var is a comma-separated list.
 * "all" disables every hook; a specific name disables only that hook.
 *
 * @param {string} hookName  - the canonical name for this hook (no .mjs suffix)
 * @returns {boolean}
 */
export function isDisabled(hookName) {
  const list = (process.env.CODEX_BRIDGE_HOOK_DISABLE ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.includes("all") || list.includes(hookName);
}
