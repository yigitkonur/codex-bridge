# Coder Mission Template

Copy this into a prompt file for implementation tasks.

```markdown
## Objective
Make the required code change and carry it through verification.

## Scope
- Files or directories the worker owns:
- Existing files it may edit:
- New files it may create:

## Constraints
- Do not touch:
- Preserve:
- Follow any repo conventions already present in the touched files.

## Required Checks
Run these commands before finishing:
npm test

## Deliverable
- Implement the change.
- Report the touched files.
- Report the verification results.
```

## Use it

Save the markdown block above into `mission.md`, then dispatch:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs" task \
  --write --mode default --json --prompt-file mission.md
```

`--prompt-file` is required here — passing the multi-paragraph body as positional argv joins lines with single spaces and drops the section structure. See [prompt-writing.md](../prompt-writing.md#how-to-deliver-the-prompt).
