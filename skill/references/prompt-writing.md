# Writing Effective Codex Prompts

## What Codex sees before your prompt

Your prompt is not sent verbatim. Two bridge-side additions modify what Codex reads:

1. **`[ORCHESTRATOR DIRECTIVE]` preamble** (when `skip_meta_skills: true`, the shipped default). Roughly: "Don't invoke your own meta-skills — `using-superpowers`, `brainstorming`, `writing-plans`, `using-git-worktrees`. Don't create `docs/superpowers/specs/*.md` or `docs/superpowers/plans/*.md` files unless the task explicitly asks for them." Plan-mode turns get a "produce a concise inline [PLAN] and stop" tail; execute turns get "execute directly." Set `skip_meta_skills: false` in `config.yaml` if you specifically want Codex's default meta-skill ceremony.
2. **`prompt_footer`** (shipped default tells Codex to ask questions via the `requestUserInput` tool with distinct options rather than plain-text prose). If you disable this, Codex often asks mid-task questions as assistant text instead, and `[QUESTION]` events never fire. Customize in `config.yaml`.

So Codex actually reads: `[ORCHESTRATOR DIRECTIVE] …\n\n<your prompt>\n\n<prompt_footer>`. Write your prompt knowing those bookends already exist — don't repeat the directive; don't fight the footer.

Plan-mode vs execute-mode changes what Codex expects:

| Mode | Codex expects | Tuning |
|---|---|---|
| `--mode plan` (default) | Analyze, ask questions, produce a `[PLAN]` — no file writes | `effort: "xhigh"` forced; sandbox read-only; `turn_plan_ms` = 5 min default |
| `--mode default` | Execute directly; produce a diff; may still ask questions via `requestUserInput` | `effort` from `config.effort` (or `--effort`); sandbox per `sandbox_policy`; `turn_default_ms` = 10 min default |

## Every Prompt Should Answer

1. **What** — exactly what the worker should do
2. **Where** — which files or directories matter
3. **Boundaries** — what must not be touched
4. **Success** — what counts as done
5. **Verification** — which commands prove success

## Good Prompt Structure

```markdown
## Objective
Add JWT authentication to the Express API.

## Scope
- Files: src/auth/, src/middleware/
- New files allowed: src/auth/jwt.ts
- Do not touch: src/db/, src/config/

## Constraints
- Use jsonwebtoken package (already installed)
- Tokens expire in 1 hour, refresh tokens in 7 days
- Follow existing middleware pattern in src/middleware/cors.ts

## Required Checks
npm test
npm run lint

## Deliverable
- Implement the change
- Report touched files
- Report test results
```

## Strong Patterns

- Exact file paths
- Explicit non-goals ("do NOT refactor existing endpoints")
- Concrete acceptance criteria
- Concrete verification commands

## Weak Patterns

- "Fix this" without success criteria
- Mixing unrelated tasks in one prompt
- Vague scope with no file boundaries
- Relying on the worker to invent verification

## When to Split

- Two prompts can run independently → split
- One is implementation, another is verification → split
- One is research, another is coding → split
- Different effort levels needed → split
