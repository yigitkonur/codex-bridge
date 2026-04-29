# claude-cli Implementation Notes

Status: **stub** — see [`../_interface/INTERFACE.md`](../_interface/INTERFACE.md) for the canonical adapter contract.

## Native protocol summary

Claude Code CLI exposes a headless mode (`claude -p "..." --output-format stream-json`) that emits one JSON object per line with `{type, ...}` payloads. Types include `assistant`, `tool_use`, `tool_result`, `result`. The `result` object closes the stream.

Reference: <https://code.claude.com/docs/en/headless>

## Mapping to bridge tags

| Native event | Bridge tag |
|---|---|
| `{"type":"assistant"}` | (intermediate; surface only on first chunk as `[ADAPTER:claude-cli:assistant-start]`) |
| `{"type":"tool_use","tool":"Edit\|Write"}` | `[ADAPTER:claude-cli:edit]` |
| `{"type":"tool_use","tool":"Read"}` | (suppress unless verbose) |
| `{"type":"tool_use","tool":"AskUserQuestion"}` | `[QUESTION]` |
| `{"type":"tool_use","tool":"ExitPlanMode"}` | `[PLAN]` |
| `{"type":"tool_result","is_error":true}` | `[WARNING]` (tool failed; assistant may recover) |
| `{"type":"result","subtype":"success"}` | `[DONE]` |
| `{"type":"result","subtype":"error_max_turns"}` | `[INCOMPLETE]` |
| `{"type":"result","is_error":true}` | `[ERROR]` |

## Open questions

- Does `--continue` work cleanly across worktree-bound sessions, or does it look up by transcript path?
- How to surface `cost_usd` from the result object? (Map to `result.usage.cost_usd`.)
- `--permission-mode bypassPermissions` vs `acceptEdits`: what's the safe default for unattended dispatch? (Probably `acceptEdits` with a sandboxed worktree.)
- Plan-mode flow: emit `[PLAN]` on `ExitPlanMode` tool_use, then await `respond` from orchestrator. Round-trip via `--continue` with the response text.
- Does `claude -p` honor `MAX_THINKING_TOKENS` env? (Worth testing for cost control.)
