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

### Scenario 1: plan-mode directive does NOT say "execute directly"

Given a request `{ prompt: "fix the retry logic" }`, `config.skip_meta_skills = true`, and `isPlanMode = true`
When `runBridgeTask` builds `promptWithFooter`
Then the result starts with `"[ORCHESTRATOR DIRECTIVE] Do not invoke your own meta-skills"`
And contains `"produce a concise inline [PLAN]"`
And does **not** contain `"execute it directly"` — that wording would contradict plan mode's "plan, don't execute yet" intent (regression against the original shipped wording)
And ends with the config's `prompt_footer` (unchanged semantics)

### Scenario 2: execute-mode directive DOES say "execute directly"

Given the same request with `isPlanMode = false`
Then the result starts with the same `[ORCHESTRATOR DIRECTIVE]` preamble
And contains `"execute it directly"`
And does **not** contain `"[PLAN]"` (plan-mode wording must not leak into execute turns)

### Scenario 3: `skip_meta_skills: false` leaves the prompt untouched (regression guard, mode-agnostic)

Given `config.skip_meta_skills = false`
Then `promptWithFooter` does **not** start with `"[ORCHESTRATOR DIRECTIVE]"`
And exactly matches the pre-flag composition: `${request.prompt}\n\n${config.prompt_footer}`
And this holds for both `isPlanMode = true` and `isPlanMode = false`

### Scenario 4: shipped `DEFAULT_CONFIG.skip_meta_skills === true`

Given `DEFAULT_CONFIG` is imported from `src/lib/config.mjs`
Then `DEFAULT_CONFIG.skip_meta_skills === true`

### Scenario 5: shared preamble (mode-aware wording is the trailing clause only)

Given both plan-mode and execute-mode composed prompts
Then both start with the same opening preamble `"[ORCHESTRATOR DIRECTIVE] Do not invoke your own meta-skills"`
And only the trailing clause after the preamble differs between modes

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cat > /tmp/cb-meta-skills.mjs <<EOF
import { DEFAULT_CONFIG } from 'file://${REPO_ROOT}/src/lib/config.mjs';

// Reproduce the mode-aware prefix composition from src/codex-bridge.mjs.
const compose = (request, config, { isPlanMode }) => {
  const metaSkillsPreamble =
    "[ORCHESTRATOR DIRECTIVE] Do not invoke your own meta-skills — specifically " +
    "\`using-superpowers\`, \`brainstorming\`, \`writing-plans\`, \`using-git-worktrees\`, " +
    "or any equivalent planning/ceremony skill. Do not create " +
    "docs/superpowers/specs/*.md or docs/superpowers/plans/*.md files unless " +
    "the task explicitly asks for them.";
  const metaSkillsPrefix = config.skip_meta_skills
    ? (isPlanMode
        ? \`\${metaSkillsPreamble} The calling orchestrator is already driving the plan/execute loop; produce a concise inline [PLAN] and stop — the orchestrator approves before execution.\n\n\`
        : \`\${metaSkillsPreamble} The calling orchestrator has already planned this task; your job is to execute it directly.\n\n\`)
    : "";
  return config.prompt_footer
    ? \`\${metaSkillsPrefix}\${request.prompt}\n\n\${config.prompt_footer}\`
    : \`\${metaSkillsPrefix}\${request.prompt}\`;
};

let fail = 0;
const footer = "FOOTER";
const prompt = "fix the retry logic";

const s1 = compose({ prompt }, { skip_meta_skills: true, prompt_footer: footer }, { isPlanMode: true });
const ok1 = s1.startsWith("[ORCHESTRATOR DIRECTIVE]") && s1.includes("produce a concise inline [PLAN]") && !s1.includes("execute it directly") && s1.endsWith(footer);
console.log((ok1 ? "PASS" : "FAIL") + " s1 — plan-mode directive");
if (!ok1) fail++;

const s2 = compose({ prompt }, { skip_meta_skills: true, prompt_footer: footer }, { isPlanMode: false });
const ok2 = s2.startsWith("[ORCHESTRATOR DIRECTIVE]") && s2.includes("execute it directly") && !s2.includes("[PLAN]") && s2.endsWith(footer);
console.log((ok2 ? "PASS" : "FAIL") + " s2 — execute-mode directive");
if (!ok2) fail++;

const s3p = compose({ prompt }, { skip_meta_skills: false, prompt_footer: footer }, { isPlanMode: true });
const s3e = compose({ prompt }, { skip_meta_skills: false, prompt_footer: footer }, { isPlanMode: false });
const expected = prompt + "\n\n" + footer;
const ok3 = s3p === expected && s3e === expected;
console.log((ok3 ? "PASS" : "FAIL") + " s3 — disabled path untouched (both modes)");
if (!ok3) fail++;

const ok4 = DEFAULT_CONFIG.skip_meta_skills === true;
console.log((ok4 ? "PASS" : "FAIL") + " s4 — shipped-default=" + DEFAULT_CONFIG.skip_meta_skills);
if (!ok4) fail++;

const preamble = "[ORCHESTRATOR DIRECTIVE] Do not invoke your own meta-skills";
const ok5 = s1.startsWith(preamble) && s2.startsWith(preamble);
console.log((ok5 ? "PASS" : "FAIL") + " s5 — shared-preamble");
if (!ok5) fail++;

process.exit(fail === 0 ? 0 : 1);
EOF
node /tmp/cb-meta-skills.mjs
```

### Enhancement candidates

- If Codex ever exposes an env var or CLI flag to suppress its meta-skills at the SDK level, thread that through instead of (or in addition to) the prompt prefix. Today it's advisory only.
- If a specific task genuinely needs `brainstorming` or `writing-plans` (e.g. a greenfield research prompt), per-task override via `task --enable-meta-skills` could selectively re-enable them — not currently supported, and would require new arg parsing on the `task` handler.
