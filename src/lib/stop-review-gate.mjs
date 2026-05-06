import fs from "node:fs";
import path from "node:path";

import { detectOfficialOpenAICodexPlugin, OFFICIAL_PLUGIN_STATUS } from "./official-plugin.mjs";
import { getConfig, setConfig, updateState } from "./state.mjs";
import { STOP_REVIEW_GATE_LOCK_FILE } from "./runtime-paths.mjs";

export function resolveStopReviewGateLockPath(workspaceRoot) {
  return path.join(workspaceRoot, STOP_REVIEW_GATE_LOCK_FILE);
}

export function readStopReviewGate(workspaceRoot, officialPlugin = detectOfficialOpenAICodexPlugin({ cwd: workspaceRoot })) {
  const lockPath = resolveStopReviewGateLockPath(workspaceRoot);
  let lockExists = fs.existsSync(lockPath);
  // Legacy migration: workspaces that enabled the gate before the lock-file
  // change only have `config.stopReviewGate: true` persisted in state.json.
  // Honor that intent and write the lock once so subsequent reads are
  // canonical without forcing the user to rerun setup --enable-review-gate.
  let migratedFromLegacyConfig = false;
  if (!lockExists) {
    let legacyEnabled = false;
    try {
      legacyEnabled = getConfig(workspaceRoot)?.stopReviewGate === true;
    } catch {
      legacyEnabled = false;
    }
    if (legacyEnabled) {
      try {
        fs.writeFileSync(
          lockPath,
          [
            "# Codex Bridge stop-time review gate",
            "# Presence of this file enables the Claude Code Stop hook for this project.",
            "# Migrated from legacy state.json config.stopReviewGate=true.",
            ""
          ].join("\n"),
          "utf8"
        );
        lockExists = true;
        migratedFromLegacyConfig = true;
      } catch {
        // Best-effort migration; even if the lock cannot be written we still
        // honor the user's recorded intent for this read.
        lockExists = true;
        migratedFromLegacyConfig = true;
      }
    }
  }
  const reviewGateSuppressionReason =
    officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE
      ? "official-openai-codex-plugin-active"
      : officialPlugin.status === OFFICIAL_PLUGIN_STATUS.UNKNOWN
        ? "official-openai-codex-plugin-status-unknown"
        : null;
  return {
    enabled: lockExists && reviewGateSuppressionReason == null,
    lockPath,
    lockExists,
    migratedFromLegacyConfig,
    officialOpenAICodexPluginStatus: officialPlugin.status,
    officialOpenAICodexPlugin: officialPlugin.plugin ?? null,
    officialOpenAICodexPluginDetail: officialPlugin.detail ?? null,
    reviewGateSuppressedByOfficialPlugin: officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE,
    reviewGateLockIgnored: lockExists && reviewGateSuppressionReason != null,
    reviewGateSuppressionReason
  };
}

export function setStopReviewGate(workspaceRoot, enabled, officialPlugin = detectOfficialOpenAICodexPlugin({ cwd: workspaceRoot })) {
  const lockPath = resolveStopReviewGateLockPath(workspaceRoot);
  if (enabled) {
    try {
      fs.writeFileSync(
        lockPath,
        [
          "# Codex Bridge stop-time review gate",
          "# Presence of this file enables the Claude Code Stop hook for this project.",
          ""
        ].join("\n"),
        "utf8"
      );
    } catch {
      // Setup reports the lock absence; a failed gate write must not crash the
      // otherwise-useful setup health check.
    }
  } else {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Setup reports if the lock remains present after the removal attempt.
    }
    // Clear any legacy `config.stopReviewGate: true` persisted before the
    // lock-file rollout. Without this, readStopReviewGate's migration path
    // (lines 763-792) sees the stale flag, recreates the lock, and turns
    // disable into a no-op for users on migrated state.
    try {
      setConfig(workspaceRoot, "stopReviewGate", false);
    } catch {
      // Best-effort: if state can't be written, the lock is already gone
      // and the next read will still report the gate as disabled — only
      // workspaces that re-trigger the migration would see the flag flip
      // back. Don't fail the disable command.
    }
  }
  return readStopReviewGate(workspaceRoot, officialPlugin);
}

export function applyStopReviewGateSnapshot(snapshot) {
  const gate = readStopReviewGate(snapshot.workspaceRoot);
  return {
    ...snapshot,
    officialOpenAICodexPluginStatus: gate.officialOpenAICodexPluginStatus,
    officialOpenAICodexPlugin: gate.officialOpenAICodexPlugin,
    officialOpenAICodexPluginDetail: gate.officialOpenAICodexPluginDetail,
    reviewGateSuppressedByOfficialPlugin: gate.reviewGateSuppressedByOfficialPlugin,
    reviewGateLockIgnored: gate.reviewGateLockIgnored,
    reviewGateSuppressionReason: gate.reviewGateSuppressionReason,
    config: {
      ...snapshot.config,
      stopReviewGate: gate.enabled,
      stopReviewGateLockPath: gate.lockPath,
      stopReviewGateLockExists: gate.lockExists,
      officialOpenAICodexPluginStatus: gate.officialOpenAICodexPluginStatus,
      reviewGateSuppressedByOfficialPlugin: gate.reviewGateSuppressedByOfficialPlugin,
      reviewGateLockIgnored: gate.reviewGateLockIgnored,
      reviewGateSuppressionReason: gate.reviewGateSuppressionReason
    },
    needsReview: gate.enabled
  };
}
