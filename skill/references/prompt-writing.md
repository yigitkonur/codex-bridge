# Writing Effective Codex Prompts

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
