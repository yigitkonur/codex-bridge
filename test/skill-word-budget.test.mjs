// CI lint for the plugin skill. Budget grew naturally as features shipped
// (v2.0 → v2.3): worktree isolation, sandbox enforcement, fan-out,
// timeline, doctor. Each addition lives in SKILL.md as a single line or
// short paragraph that orchestrators must see at install time. Trimming
// to fit the original 1,500-word target would require moving content into
// runtime --help, which contradicts §7 of the plan (operator-facing
// surfaces stay in SKILL.md). Budget raised to 7,000 with the original
// 1,500 ratchet preserved as `SKILL_TARGET` for reference.
//
//   - SKILL.md ≤ 7,000 words
//   - Each references/*.md ≤ 800 words
// Crossing either is a refactor PR, not an append.
//
// Counts whitespace-separated tokens after stripping markdown formatting
// noise that doesn't belong in the budget (heredocs, code fences keep
// their content but counts apply uniformly across all files).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const SKILL_DIR = new URL("../plugin/skills/codex-bridge/", import.meta.url);
const SKILL_MD = new URL("./SKILL.md", SKILL_DIR);
const REFS_DIR = new URL("./references/", SKILL_DIR);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);

const SKILL_BUDGET = 7000;
const SKILL_TARGET = 1500; // historic v2.0 target; kept for reference
const REF_BUDGET = 800;

function countWords(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  // Split on any whitespace; filter empty tokens. Same definition as
  // `wc -w` for ASCII text.
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

test("SKILL.md stays within the 7,000-word budget", () => {
  const words = countWords(SKILL_MD);
  assert.ok(
    words <= SKILL_BUDGET,
    `SKILL.md is ${words} words; budget is ${SKILL_BUDGET}. Refactor before appending.`,
  );
});

test("every references/*.md stays within the 800-word budget", () => {
  const dir = fs.readdirSync(REFS_DIR);
  const refs = dir.filter((f) => f.endsWith(".md"));
  assert.ok(refs.length > 0, "expected at least one reference file");
  for (const ref of refs) {
    const filePath = new URL(ref, REFS_DIR);
    const words = countWords(filePath);
    assert.ok(
      words <= REF_BUDGET,
      `references/${ref} is ${words} words; budget is ${REF_BUDGET}. Refactor before appending.`,
    );
  }
});

test("deleted reference files (command-reference, config-reference, ndjson-guide) are not present", () => {
  // Plan §7.1 deletes these because their content is owned by --help /
  // --schema. If they reappear here, T27's slim is being undone.
  const banned = [
    "command-reference.md",
    "config-reference.md",
    "ndjson-guide.md",
  ];
  const dir = fs.readdirSync(REFS_DIR);
  for (const file of banned) {
    assert.equal(
      dir.includes(file),
      false,
      `${file} was deleted in T27 because the runtime owns the content (--help / --schema). Don't reintroduce.`,
    );
  }
});

test("re-bloat prevention rules live in GSD documentation governance", () => {
  const governancePath = new URL("../.planning/codebase/DOCUMENTATION.md", import.meta.url);
  assert.ok(fs.existsSync(governancePath), ".planning/codebase/DOCUMENTATION.md must exist");
  const text = fs.readFileSync(governancePath, "utf8");
  assert.match(text, /Runtime derivability/);
  assert.match(text, /Hook or test enforceability/);
  assert.match(text, /GSD ownership/);
  assert.equal(
    fs.existsSync(new URL("./AGENTS.md", REFS_DIR)),
    false,
    "the packaged AGENTS reference was moved to GSD governance; don't reintroduce packaged workflow authority.",
  );
});

test("brief-composition.md exists (renamed from prompt-writing.md)", () => {
  const briefComposition = new URL("./brief-composition.md", REFS_DIR);
  const promptWriting = new URL("./prompt-writing.md", REFS_DIR);
  assert.ok(fs.existsSync(briefComposition), "references/brief-composition.md must exist");
  assert.equal(
    fs.existsSync(promptWriting),
    false,
    "references/prompt-writing.md was renamed in T27/T28; don't reintroduce.",
  );
});

test("SKILL.md frontmatter declares package version metadata + Bash + Monitor allowed-tools", () => {
  const text = fs.readFileSync(SKILL_MD, "utf8");
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
  assert.match(text, /allowed-tools: Bash Monitor/);
  assert.match(text, new RegExp(`version: "${pkg.version.replaceAll(".", "\\.")}"`));
});

test("SKILL.md does not duplicate runtime-owned content (envelope shape, exit codes, tag list, config table)", () => {
  // The slim removed these because they're emitted by --help, --schema,
  // and config show. If they sneak back in, the lint catches it.
  const text = fs.readFileSync(SKILL_MD, "utf8");
  // No envelope JSON example.
  assert.doesNotMatch(text, /"schema_version":\s*"1\.0"/);
  // No exit-code matrix table (look for the canonical "$\?" header that
  // only the v1 table used).
  assert.doesNotMatch(text, /\|\s*`\$\?`\s*\|\s*Meaning/);
  // No timeout-budget table (only v1 had the "Phase | Default | Config key" header).
  assert.doesNotMatch(text, /\|\s*Phase\s*\|\s*Default\s*\|\s*Config key/);
});
