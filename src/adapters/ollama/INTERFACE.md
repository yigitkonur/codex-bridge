# ollama Implementation Notes

Status: **stub** — see [`../_interface/INTERFACE.md`](../_interface/INTERFACE.md) for the canonical adapter contract.

## Native protocol summary

Ollama exposes an HTTP API at `http://localhost:11434`. Relevant endpoints:

- `POST /api/chat` — multi-turn chat with `{model, messages[], stream}`
- `POST /api/generate` — single completion
- `GET /api/tags` — list installed models

With `stream: true`, responses are NDJSON: one JSON object per line, each with `{message?, done, ...}`. The final object has `done: true` and aggregate stats.

Reference: <https://github.com/ollama/ollama/blob/main/docs/api.md>

## Mapping to bridge tags

| Native event | Bridge tag |
|---|---|
| First chunk arrives | `[ADAPTER:ollama:stream-start]` |
| Each `message.content` chunk | (suppressed unless verbose) |
| `{done: true}` | `[DONE]` |
| HTTP non-2xx | `[ERROR]` with `error.class="upstream"` |
| `eval_count` / `prompt_eval_count` | (surface in `result.usage`) |

## Open questions

- Tool-use: Ollama's `/api/chat` supports `tools` arg in newer versions but model-dependent. Probably skip in v1.
- Worktree mapping: Ollama doesn't read files itself; the adapter must inject file contents into the prompt. Define a contract for which files to include (via brief `worker_assignment` glob hints, perhaps).
- Long-running models: Ollama can take 30+ seconds for first token on cold cache. Surface `[CHECKPOINT]` periodically.
- Model availability: validate `model` arg against `/api/tags` at dispatch time; pull on miss is heavy and should require explicit opt-in.
- Cost reporting: `billing_model: "local"` means free, but surface inference time + tokens for observability.
