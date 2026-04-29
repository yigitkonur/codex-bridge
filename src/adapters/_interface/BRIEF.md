# Brief Contract

A "brief" is a structured handoff document for `task --brief @path.json`. The schema lives at `../../../plugin/schemas/brief.schema.json` (created in T16).

## Required fields

- **`goal`** — the user-facing outcome, distilled to one paragraph (1-2000 chars).
- **`worker_assignment`** — the actual work the adapter must do, written for the adapter's reading (1-4000 chars).

## Optional fields

- **`behavior_digest_seed`** — what the orchestrator already knows about prior worker behavior. Up to 8000 chars.
- **`specific_concerns`** — array of concrete issues the orchestrator wants the worker to address. Up to 16 strings, each up to 1000 chars. Surfaces in `prompts/adversarial-review.md` as `{{OPUS_CONCERNS}}`.
- **`acceptance_criteria`** — array of testable conditions for "done." Up to 16 strings.
- **`parent_task_id`** — for iteration loops; links a child task to its parent. Pattern: `^(task|review)-[a-z0-9-]+$`.
- **`backend_hint`** — preferred adapter (`codex` only in v2.0; expanded as adapters land).
- **`iteration_max`** — closed-loop cap, 1-10. Defaults to 3.
- **`trust_budget_override`** — task-specific budget for auto-merge gating.
- **`schema_version`** — currently `"1.0"` (single allowed value).

## Validation

`src/lib/brief.mjs::loadBrief(arg)` (created in T16) validates against the schema via AJV. Errors map to:

| Code | Cause |
|---|---|
| `BRIEF_FILE_NOT_FOUND` | `@path/...` resolved to nonexistent file |
| `BRIEF_INVALID_JSON` | File or inline arg failed JSON parse |
| `BRIEF_SCHEMA_VIOLATION` | AJV reported violations; details in `error.details` |
| `BRIEF_PARENT_NOT_FOUND` | `parent_task_id` doesn't exist in the registry |
| `BRIEF_BACKEND_UNAVAILABLE` | `backend_hint` adapter not installed |

## Rendering

Each adapter implements `src/adapters/<name>/brief-template.mjs` to convert the validated brief into the prompt shape its backend expects. Codex's renderer embeds the brief inline; future adapters (Aider) might emit `--read`/`--write` flag pairs; Gemini might format as system + user messages.

## Persistence

The verbatim brief is copied to `<task_dir>/brief.json` at dispatch. A markdown rendering (`brief.md`) is also written for human reading. This guarantees that even if a prompt template changes between releases, the original intent is recoverable.

## Example

```jsonc
{
  "schema_version": "1.0",
  "goal": "Add JWT auth to the Express API",
  "worker_assignment": "Implement /auth/login + /auth/refresh in src/auth/ following the middleware pattern in src/middleware/cors.ts",
  "specific_concerns": [
    "Don't change src/db/ or src/config/",
    "Use jsonwebtoken (already installed)",
    "Tokens 1h, refresh tokens 7d"
  ],
  "acceptance_criteria": [
    "POST /auth/login returns access + refresh tokens",
    "POST /auth/refresh rotates the refresh token",
    "Existing auth tests pass: npm test -- auth",
    "New tests cover token expiration"
  ],
  "iteration_max": 3,
  "backend_hint": "codex"
}
```
