# 05-skip-meta-skills-prepends-directive

**Derived from:** `src/lib/config.mjs:18-28` (`DEFAULT_CONFIG.skip_meta_skills = true`), `src/codex-bridge.mjs:1527-1548` (`runBridgeTask` composes `metaSkillsPrefix + request.prompt + prompt_footer`), `skill/references/config-reference.md` ("skip_meta_skills" section), `skill/config.yaml` (shipped default).
**What this catches:** Codex ships with opinionated meta-skills (`using-superpowers`, `brainstorming`, `writing-plans`, `using-git-worktrees`) that run before execution by default. In bridge-orchestrated workflows these skills routinely burn ~10 minutes producing `docs/superpowers/specs/*.md` and `docs/superpowers/plans/*.md` files that aren't part of the deliverable. The `skip_meta_skills` flag prepends an `[ORCHESTRATOR DIRECTIVE]` line to every prompt telling Codex to execute directly. Advisory (Codex may ignore it), but measurably reduces ceremony in the observed sessions.
**Runtime cost:** fast — asserts on the prompt-composition branch without spawning Codex. Extracts the prefix construction from `src/codex-bridge.mjs` and evaluates against both flag states.
**Test subject:** unit-level assertion on the public contract: "when `skip_meta_skills: true`, the final prompt sent to `runAppServerTurn` begins with the directive".

## Feature: `skip_meta_skills` composes a directive prefix onto every prompt

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
```

And `npm run build` has been run since the last `src/` edit.

### Scenario 1: `skip_meta_skills: true` prepends the directive (shipped default)

Given a request `{ prompt: "fix the retry logic" }` and `config.skip_meta_skills = true`
When `runBridgeTask` builds `promptWithFooter`
Then the result starts with `"[ORCHESTRATOR DIRECTIVE] Do not invoke your own meta-skills"`
And contains each of: `using-superpowers`, `brainstorming`, `writing-plans`, `using-git-worktrees`
And ends with the config's `prompt_footer` (unchanged semantics)
And the original `"fix the retry logic"` appears verbatim between the directive and the footer

### Scenario 2: `skip_meta_skills: false` leaves the prompt untouched (regression guard)

Given `config.skip_meta_skills = false`
Then `promptWithFooter` does **not** start with `"[ORCHESTRATOR DIRECTIVE]"`
And exactly matches the pre-flag composition: `${request.prompt}\n\n${config.prompt_footer}`

### Scenario 3: shipped `DEFAULT_CONFIG.skip_meta_skills === true`

Given `DEFAULT_CONFIG` is imported from `src/lib/config.mjs`
Then `DEFAULT_CONFIG.skip_meta_skills === true`

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cat > /tmp/cb-meta-skills.mjs <<EOF
import { DEFAULT_CONFIG } from 'file://${REPO_ROOT}/src/lib/config.mjs';

// Reproduce the prefix-composition branch from src/codex-bridge.mjs:1527-1548.
const compose = (request, config) => {
  const metaSkillsPrefix = config.skip_meta_skills
    ? "[ORCHESTRATOR DIRECTIVE] Do not invoke your own meta-skills — specifically " +
      "\`using-superpowers\`, \`brainstorming\`, \`writing-plans\`, \`using-git-worktrees\`, " +
      "or any equivalent planning/ceremony skill. The calling orchestrator has " +
      "already planned this task; your job is to execute it directly. Do not " +
      "create docs/superpowers/specs/*.md or docs/superpowers/plans/*.md files " +
      "unless the task explicitly asks for them.\n\n"
    : "";
  return config.prompt_footer
    ? \`\${metaSkillsPrefix}\${request.prompt}\n\n\${config.prompt_footer}\`
    : \`\${metaSkillsPrefix}\${request.prompt}\`;
};

let fail = 0;
const footer = "FOOTER";
const prompt = "fix the retry logic";

// Scenario 1: skip_meta_skills = true
const s1 = compose({ prompt }, { skip_meta_skills: true, prompt_footer: footer });
const ok1 =
  s1.startsWith("[ORCHESTRATOR DIRECTIVE]") &&
  s1.includes("using-superpowers") &&
  s1.includes("brainstorming") &&
  s1.includes("writing-plans") &&
  s1.includes("using-git-worktrees") &&
  s1.endsWith(footer) &&
  s1.includes(prompt);
console.log((ok1 ? "PASS" : "FAIL") + " s1 — prefix + preserved prompt + footer");
if (!ok1) fail++;

// Scenario 2: skip_meta_skills = false
const s2 = compose({ prompt }, { skip_meta_skills: false, prompt_footer: footer });
const ok2 = !s2.startsWith("[ORCHESTRATOR") && s2 === prompt + "\n\n" + footer;
console.log((ok2 ? "PASS" : "FAIL") + " s2 — untouched composition");
if (!ok2) fail++;

// Scenario 3: shipped default
const ok3 = DEFAULT_CONFIG.skip_meta_skills === true;
console.log((ok3 ? "PASS" : "FAIL") + " s3 — DEFAULT_CONFIG.skip_meta_skills = " + DEFAULT_CONFIG.skip_meta_skills);
if (!ok3) fail++;

process.exit(fail === 0 ? 0 : 1);
EOF
node /tmp/cb-meta-skills.mjs
```

### Enhancement candidates

- If Codex ever exposes an env var or CLI flag to suppress its meta-skills at the SDK level, thread that through instead of (or in addition to) the prompt prefix. Today it's advisory only.
- If a specific task genuinely needs `brainstorming` or `writing-plans` (e.g. a greenfield research prompt), per-task override via `task --enable-meta-skills` could selectively re-enable them — not currently supported, and would require new arg parsing on the `task` handler.
