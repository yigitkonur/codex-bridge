# gemini Implementation Notes

Status: **stub** — see [`../_interface/INTERFACE.md`](../_interface/INTERFACE.md) for the canonical adapter contract.

## Native protocol summary

The `gemini` CLI accepts a prompt via `--prompt "..."` (or stdin) and streams tokens to stdout. JSON output is opt-in via `--format json`. There is no JSON-RPC layer; communication is line-oriented.

Reference: <https://ai.google.dev/gemini-api/docs/cli>

## Mapping to bridge tags

| Native event / output | Bridge tag |
|---|---|
| First token chunk | `[ADAPTER:gemini:stream-start]` |
| Each token chunk | (suppressed unless verbose) |
| `--format json` finalization | `[DONE]` |
| Non-zero exit code | `[ERROR]` with `error.class="upstream"` |
| Search-tool result (if `--web` flag) | `[ADAPTER:gemini:search-result]` |
| Image-generation step | `[ADAPTER:gemini:image-generated]` |

## Open questions

- Does `--format json` emit a single completion object, or is it streaming JSONL? (verify against latest CLI version)
- Can we set a system prompt via flag, or only via API mode?
- Token-counting: surface `result.usage.{input_tokens, output_tokens}` from the JSON output?
- Should image inputs be staged via `--file` arg or base64-inlined?
