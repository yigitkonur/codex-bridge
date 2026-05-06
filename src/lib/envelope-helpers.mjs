// Small, broadly-shared helpers used by both the task runtime and several
// command handlers. Each helper here is called from at least two distinct
// surfaces (e.g. runBridgeTask + handleReviewCommand). Helpers used only by
// runBridgeTask live with it in src/lib/task-runtime.mjs (Phase 1 of the
// dispatcher refactor).

import { renderBriefAsMarkdown } from "./brief.mjs";
import {
  DEFAULT_MONITOR_EXCLUDE,
  TERMINAL_TAGS,
  formatTailCommand,
} from "./session-log.mjs";
import { SCRIPT_PATH } from "./runtime-paths.mjs";

export function buildRecovery({ reason, retryable, nextActions = [], artifacts = {}, details = {} }) {
  return {
    schema_version: "1.0",
    reason,
    retryable: Boolean(retryable),
    next_actions: nextActions,
    artifacts,
    details,
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function bridgeCommand(subcommand, cwd = null) {
  return `node ${shellQuote(SCRIPT_PATH)} ${subcommand}${cwd ? ` --cwd ${shellQuote(cwd)}` : ""}`;
}

export function appendRenderedBriefToPrompt(prompt, brief) {
  if (!brief) return prompt ?? "";
  const rendered = renderBriefAsMarkdown(brief);
  return [
    prompt ?? "",
    "[CODEX-BRIDGE STRUCTURED BRIEF]",
    "The following brief is part of the worker instructions. Follow the worker_assignment and verify the acceptance_criteria before finishing.",
    rendered,
    "[/CODEX-BRIDGE STRUCTURED BRIEF]",
  ].filter((part) => String(part).trim()).join("\n\n");
}

// Produces a ready-to-paste Monitor hint so agents don't have to assemble one
// from eventsPath + terminal tags. Prefers the bundled `events --follow`
// subcommand (stable, filtered) over raw `tail -f`. `eventsPath` may be null
// when the thread id isn't known yet (background launches); in that case the
// shell fallback is omitted but the CLI command still works via the job id.
export function buildMonitorHint({ eventsPath, jobId, threadId, cwd = null }) {
  const identifier = jobId ?? threadId;
  if (!identifier) return null;
  // v1.4.0 filter contract: exclusion-based, not inclusion-based. Every
  // tag the bridge emits passes through Monitor by default except those
  // in the exclude list — so new tags added in future versions reach
  // existing orchestrators without a filter update.
  // - HEARTBEAT excluded by default: 60-s liveness pulse is pure signal
  //   for the .events file (and the 90-s liveness heuristic), but
  //   floods an LLM's context in a long run.
  // - CHECKPOINT stays in the stream: it's the primary LLM-facing
  //   summary (every ~5 min, content-rich).
  // - All interrupt tags (DONE/ERROR/INCOMPLETE/PLAN/QUESTION) pass
  //   through unconditionally.
  // Callers who specifically want the old inclusion model can pass
  // `--filter <tags>` explicitly; the two flags are mutually exclusive.
  const cliCommand = formatTailCommand({
    scriptPath: SCRIPT_PATH,
    jobId: identifier,
    timeoutMs: 1800000,
    exclude: DEFAULT_MONITOR_EXCLUDE,
    cwd,
  });
  const shellFallback = eventsPath
    ? `tail -f ${JSON.stringify(eventsPath)} | while IFS= read -r line; do ` +
      `echo "$line"; case "$line" in "[DONE]"*|"[ERROR]"*|"[INCOMPLETE]"*|"[PLAN]"*) break ;; esac; done`
    : null;
  return {
    command: cliCommand,
    shell_fallback: shellFallback,
    terminal_tags: [...TERMINAL_TAGS],
    exclude_tags: [...DEFAULT_MONITOR_EXCLUDE],
    timeout_ms: 1800000,
    tool_hint: {
      description: "codex-bridge task events (excludes heartbeat noise; passes interrupts + checkpoints through)",
      command: cliCommand,
      timeout_ms: 3600000,
      persistent: false
    }
  };
}

// Extracts a small, retrospective-replay-friendly text preview from an
// `item/completed` payload. Keep the slices tight — NDJSON is a transcript
// replay store, not a verbatim mirror of the wire protocol.
export function extractItemText(item) {
  if (!item || typeof item !== "object") return null;
  switch (item.type) {
    case "agentMessage":
      return typeof item.text === "string" ? item.text.slice(0, 500) : null;
    case "commandExecution":
      return typeof item.command === "string" ? item.command.slice(0, 200) : null;
    case "fileChange": {
      // item.changes[] carries per-path details; summarize first change.
      const changes = Array.isArray(item.changes) ? item.changes : [];
      if (changes.length === 0) {
        return typeof item.path === "string" ? item.path : null;
      }
      const first = changes[0] ?? {};
      const kind = first.kind ?? first.change ?? first.op ?? "";
      const path = first.path ?? "";
      const summary = `${kind ? kind + " " : ""}${path}`.trim();
      if (!summary) return null;
      const suffix = changes.length > 1 ? ` (+${changes.length - 1} more)` : "";
      return `${summary}${suffix}`.slice(0, 200);
    }
    case "plan":
      if (typeof item.title === "string" && item.title.trim()) {
        return item.title.slice(0, 200);
      }
      if (typeof item.text === "string") {
        const firstLine = item.text.split("\n").find((line) => line.trim()) ?? "";
        return firstLine ? firstLine.slice(0, 200) : null;
      }
      return null;
    case "reasoning":
      // Reasoning summaries are arrays of blocks; pick the first textual one.
      if (typeof item.summary === "string") {
        return item.summary.slice(0, 200);
      }
      if (Array.isArray(item.summary)) {
        for (const section of item.summary) {
          if (typeof section === "string" && section.trim()) {
            return section.slice(0, 200);
          }
          if (section && typeof section === "object" && typeof section.text === "string" && section.text.trim()) {
            return section.text.slice(0, 200);
          }
        }
      }
      return null;
    case "mcpToolCall":
      if (item.server || item.tool) {
        return `${item.server ?? ""}/${item.tool ?? ""}`.slice(0, 200);
      }
      return null;
    case "commandExecutionOutput":
    case "webSearch":
      if (typeof item.query === "string") return item.query.slice(0, 200);
      return null;
    default:
      return null;
  }
}
