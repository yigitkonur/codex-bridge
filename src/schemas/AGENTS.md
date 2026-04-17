# src/schemas/AGENTS.md

JSON Schema files that constrain Codex structured output. Loaded via `src/lib/codex.mjs::readOutputSchema(path)` and passed as `turn/start.params.outputSchema` to the upstream app-server.

Upstream semantics: `outputSchema` is **per-turn** (explicit in `codex-rs/app-server/tests/suite/v2/output_schema.rs::turn_start_output_schema_is_per_turn_v2`). It forwards to the Responses API as `text.format = { name: "codex_output_schema", type: "json_schema", strict: true, schema: <your schema> }`. Strict mode is enforced by the model provider — missing fields trigger model-side retry; extra fields fail the schema.

## Current files

- `review-output.schema.json` — adversarial review result schema. Copied to `skill/schemas/` by build; consumed by the `review` / `adversarial-review` subcommands.

## `review-output.schema.json` contract

Strict JSON Schema 2020-12. Top-level `additionalProperties: false`. Required fields: `verdict`, `summary`, `findings`, `next_steps`.

```
verdict        : "approve" | "needs-attention"
summary        : string, minLength 1
findings[]     : Finding   (additionalProperties: false)
next_steps[]   : string, minLength 1

Finding = {
  severity      : "critical" | "high" | "medium" | "low"
  title         : string, minLength 1
  body          : string, minLength 1
  file          : string, minLength 1
  line_start    : integer ≥ 1
  line_end      : integer ≥ 1
  confidence    : number ∈ [0, 1]
  recommendation: string
}
```

## Coupling with other parts of the repo

| Field | Used by | Broken if renamed |
|---|---|---|
| `verdict` | `src/lib/render.mjs` (display), `src/lib/auto-pipeline.mjs` (branch: findings → fix turn) | Auto-pipeline stops choosing the fix stage; review verdict disappears from `[DONE]`. |
| `severity` | `render.mjs` (sort critical → low) | Findings display in arbitrary order; UX regression. |
| `file`, `line_start`, `line_end` | `auto-pipeline.mjs` fix prompt builder | Fix turn gets unanchored findings; the model can't locate the problem. |
| `confidence` | `auto-pipeline.mjs` (filter weak findings before fix) | Every finding becomes fix-worthy; noise explodes. |
| `next_steps` | `render.mjs` DONE tail | Developer-facing next actions vanish. |
| `body`, `title`, `recommendation` | `render.mjs` (display) | Silent display regression; only visual. |

## Prompt coupling

The schema is the second half of a contract whose first half is `src/prompts/adversarial-review.md` (the `<structured_output_contract>` block, lines 48–59). Changes require syncing both: add a field to one → add it to the other + the parser in `src/lib/codex.mjs::parseStructuredOutput`.

## Why strict + `additionalProperties: false`

- Strict mode catches model regressions fast. A new Codex version that emits `finding.impact_category` instead of `finding.severity` will fail loud, not silently drop data.
- Closed schemas make the parser simple: `findings[i].foo` doesn't exist by design, so we don't need defensive lookups.
- The downstream renderer and auto-pipeline both assume a closed shape; opening it would require defensive coding everywhere.

## Authoring rules when adding a new schema

1. Draft the JSON Schema in a separate file per output type (don't multiplex one schema across turn kinds).
2. Use `draft/2020-12` (matches the existing one).
3. Keep `additionalProperties: false` unless you have a concrete extensibility need.
4. Use `minLength: 1` on required string fields to refuse empty strings.
5. Use `enum` for every string that has a finite set of allowed values.
6. Register the schema in `esbuild.config.mjs`'s `copies` list and reference it through `ROOT_DIR` (see `src/codex-bridge.mjs:104` for the `REVIEW_SCHEMA` pattern).
7. Add a branch in `src/lib/codex.mjs::parseStructuredOutput` that handles the new shape.
8. Update the matching prompt's `<structured_output_contract>` block.
9. Add a renderer in `src/lib/render.mjs`.

## Things to avoid

- **No `oneOf`/`anyOf` at the top level.** Upstream's structured-output plumbing works best with a single closed object; composition nests fine.
- **No `$ref` to external URIs.** The schema must be fully self-contained — it's sent over the wire to the model provider.
- **No optional fields in `Finding`.** Either make them required (the parser and renderer become simpler) or split the schema.
- **Never weaken `line_start`/`line_end` to `nullable`** without updating every consumer that assumes a 1-based integer.
