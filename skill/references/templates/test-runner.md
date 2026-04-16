# Test Runner Template

Copy this into a prompt file for verification tasks.

```markdown
## Objective
Run the required verification commands and explain the result precisely.

## Scope
- Commands to run:
- Files to inspect if a check fails:

## Constraints
- Prefer diagnosis over speculative fixes unless the task explicitly asks for repair.
- Do not edit unrelated files.

## Required Checks
npm run test:unit

## Deliverable
- Report pass or fail.
- Include the failing command when relevant.
- Include the smallest useful file references or logs that explain the result.
```
