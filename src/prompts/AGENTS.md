# src/prompts/AGENTS.md

Prompt templates consumed by Codex turns. Every file here is a `{{UPPERCASE_PLACEHOLDER}}`-templated markdown document loaded by `src/lib/prompts.mjs::loadPromptTemplate` and interpolated via `interpolateTemplate`. Build copies them verbatim into `skill/prompts/` (see `esbuild.config.mjs`).

Root build and authoring rules live in `/AGENTS.md`. The output schema binding lives in `src/schemas/AGENTS.md`.

## Current files

- `adversarial-review.md` — the sole review prompt. Used by the `review` and `adversarial-review` subcommands in `src/codex-bridge.mjs` via `buildAdversarialReviewPrompt(context, focusText)` (line ~309).

## Placeholder contract

`interpolateTemplate(template, vars)` replaces `{{KEY}}` with `vars[KEY]` or the empty string. Missing keys silently become `""` — there is no validation. Keep the placeholder set small and check every caller when adding a new one.

Placeholders in `adversarial-review.md`:

| Placeholder | Provided by | Empty-string effect |
|---|---|---|
| `{{TARGET_LABEL}}` | `context.target.label` from `git.mjs::resolveReviewTarget` | "Target: " renders blank — review runs but scope is undocumented. |
| `{{USER_FOCUS}}` | CLI focus-text (positional args joined) | Line says "User focus: " with no content — model will still review broadly. |
| `{{REVIEW_COLLECTION_GUIDANCE}}` | `context.collectionGuidance` from `git.mjs::collectReviewContext` | No downgrade notice when diff exceeded inline budget — model won't know to ask for summary. |
| `{{REVIEW_INPUT}}` | `context.content` (inline diff or summary) | Entire review has no content — model has nothing to analyze. Fail loud here. |

Callers in `src/codex-bridge.mjs`:
- `buildAdversarialReviewPrompt(context, focusText)` (line 309–317) builds the variable map.
- `executeReviewRun` (line 425–525) feeds the prompt to `runAppServerTurn` with `outputSchema: readOutputSchema(REVIEW_SCHEMA)`.

## Schema coupling

The `<structured_output_contract>` block (lines 48–59 of `adversarial-review.md`) dictates the JSON fields the model must return. **Those fields are the schema.** Any change to the list below requires a matching change in `src/schemas/review-output.schema.json` AND the parser in `src/lib/codex.mjs::parseStructuredOutput`:

- `verdict` ∈ `{approve, needs-attention}`
- `summary`: terse ship/no-ship string
- `findings[]` each with: `severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence` (0–1), `recommendation`
- `next_steps[]`: array of strings

Drop any one of these in the prompt without updating the schema and the model either stops emitting it (→ schema error surfaced by upstream) or keeps emitting an unexpected field (→ additionalProperties: false rejects).

## Authoring rules

1. **Imperative, second-person tone.** Codex responds well to `<role>…</role>`-style instructions with explicit modes (`Default to skepticism.`, `Do not give credit for…`). Don't soften.
2. **Every section tag must close.** The prompt uses XML-ish wrappers (`<role>`, `<task>`, `<operating_stance>`, `<attack_surface>`, `<review_method>`, `<finding_bar>`, `<structured_output_contract>`, `<grounding_rules>`, `<calibration_rules>`, `<final_check>`, `<repository_context>`). Claude and Codex both treat these as soft section boundaries; unclosed tags break the stance.
3. **`<finding_bar>` lines 38–46 are the review quality gate.** Removing "Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence" inflates noise to the point where verdicts become useless.
4. **`<grounding_rules>` is non-negotiable.** "Every finding must be defensible from the provided repository context." Don't allow the model to invent attacks — this is how REVIEW.md rules keep the bar high.
5. **Keep the prompt adversarial, not neutral.** Neutral review prompts produce neutral reviews. The whole point is to break confidence.

## When to add a new prompt here

Create a new template file when a new review kind or task mode needs its own first-class prompt. File naming: `<kind>.md` (e.g., `security-triage.md`). Then:

1. Add the file to `src/prompts/`.
2. Load in a handler via `loadPromptTemplate(ROOT_DIR, "kind-name")` — the `.md` extension is appended automatically.
3. Add to `esbuild.config.mjs`'s `copies` array.
4. If the prompt has a schema contract, add the corresponding JSON schema in `src/schemas/` and a parser branch in `codex.mjs`.
5. Document the placeholders and the user-facing subcommand in `skill/SKILL.md` and `skill/references/command-reference.md`.

## Things to avoid

- **Don't interpolate anything user-controlled into the role or task blocks.** Focus text lives inside `{{USER_FOCUS}}` on purpose — injecting arbitrary user content into `<role>` would let a crafted prompt rewrite the review stance.
- **Don't switch to handlebars or another templating engine.** The simplicity of `{{UPPER}}` is load-bearing (no escaping rules to remember, no dependency).
- **Don't store model output formatting hints anywhere except `<structured_output_contract>`.** If you need to change the contract, do it there — the schema and parser will follow.
