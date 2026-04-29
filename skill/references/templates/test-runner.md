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

## Use it

Save the markdown block above into `mission.md`, then dispatch (add `--write` only if the task may repair failures, not just diagnose):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs" task \
  --mode default --json --prompt-file mission.md
```

`--prompt-file` is required here — passing the multi-paragraph body as positional argv joins lines with single spaces and drops the section structure. See [prompt-writing.md](../prompt-writing.md#how-to-deliver-the-prompt).
