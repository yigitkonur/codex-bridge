# aider Implementation Notes

Status: **stub** — see [`../_interface/INTERFACE.md`](../_interface/INTERFACE.md) for the canonical adapter contract.

## Native protocol summary

`aider --message "..." --yes` runs a single edit turn and exits. With `--yes` (auto-confirm), Aider applies suggested edits without prompting. Output is line-buffered to stdout; structured progress is implicit (parse "Applied edit to <file>", "Committed: <sha>", "Cost: $X").

Reference: <https://aider.chat/docs/usage.html>

## Mapping to bridge tags

| Native output | Bridge tag |
|---|---|
| `Applied edit to <file>` | `[ADAPTER:aider:apply-edit]` |
| `Committed: <sha>` | `[ADAPTER:aider:commit]` |
| `Cost: $X.XX` | (suppress; surface in `result.usage`) |
| `Error: ...` line | `[ERROR]` with `error.class="upstream"` |
| Clean exit code 0 | `[DONE]` |
| Non-zero exit code | `[ERROR]` |
| `Tokens used: ...` | (surface in `result.usage.{input_tokens, output_tokens}`) |

## Open questions

- Does Aider have a JSON-output mode, or do we screen-scrape? (Last checked: no `--json` flag.)
- How to handle Aider's interactive `/ask` mode without a TTY? (Likely: don't expose; emit `WARNING` if user prompt suggests Q&A.)
- `.aider.chat.history.md` is per-cwd — does it integrate cleanly with worktree-per-dispatch? (Probably yes, but worth a smoke test.)
- Aider commits on its own; how does `merge` subcommand reconcile with that? (Prefer Aider commits + bridge merge later, vs amending.)
