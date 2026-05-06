#!/usr/bin/env node
// Bump the package version per the project's roll-over rule:
//   - Default: patch+1   (2.2.0 → 2.2.1)
//   - Patch caps at 9: roll over to minor+1 with patch=0   (2.4.9 → 2.5.0)
//
// Updates every file that carries a copy of the version, then writes
// `previous=<old>` / `next=<new>` to $GITHUB_OUTPUT for the calling workflow
// to consume. No commit, no tag — that's the workflow's job.
//
// Usage:
//   node scripts/bump-version.mjs           # bump and write files
//   node scripts/bump-version.mjs --dry-run # compute next version, write nothing

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// Single source of truth for every place we stamp the version.
// Keep aligned with CLAUDE.md's "version-bearing files" list.
const VERSION_FILES = [
  { path: "package.json", kind: "json" },
  { path: ".claude-plugin/plugin.json", kind: "json" },
  { path: "plugin/.claude-plugin/plugin.json", kind: "json" },
  { path: "skill/SKILL.md", kind: "yaml-frontmatter" },
  { path: "plugin/skills/codex-bridge/SKILL.md", kind: "yaml-frontmatter" },
];

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  if (!m) {
    throw new Error(`invalid semver: ${v}`);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function nextVersion({ major, minor, patch }) {
  if (patch >= 9) {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function bumpJsonFile(file, expectedCurrent, next) {
  // Verify the file's parsed `version` matches what we expect, then mutate
  // ONLY the version line via in-place text replacement. Re-serializing the
  // JSON would drift formatting (inline arrays, key order, trailing newline).
  const obj = readJson(file);
  if (obj.version !== expectedCurrent) {
    throw new Error(
      `${file}: expected version ${expectedCurrent}, found ${obj.version} (drift — fix manually)`,
    );
  }
  const text = fs.readFileSync(file, "utf8");
  const escaped = expectedCurrent.replace(/\./g, "\\.");
  const re = new RegExp(`("version"\\s*:\\s*")${escaped}(")`);
  const updated = text.replace(re, `$1${next}$2`);
  if (updated === text) {
    throw new Error(`${file}: version field text replacement failed`);
  }
  fs.writeFileSync(file, updated, "utf8");
}

function bumpYamlFrontmatter(file, expectedCurrent, next) {
  const text = fs.readFileSync(file, "utf8");
  // Only match inside the YAML frontmatter block at the top of the file —
  // a `version:` mention later in prose must NOT be rewritten.
  if (!text.startsWith("---\n")) {
    throw new Error(`${file}: file does not start with --- frontmatter delimiter`);
  }
  const closeIdx = text.indexOf("\n---\n", 4);
  if (closeIdx === -1) {
    throw new Error(`${file}: no closing --- delimiter for YAML frontmatter`);
  }
  const frontmatter = text.slice(0, closeIdx + 5);
  const body = text.slice(closeIdx + 5);
  const escaped = expectedCurrent.replace(/\./g, "\\.");
  const re = new RegExp(`^(\\s*version:\\s*["']?)${escaped}(["']?\\s*)$`, "m");
  const updatedFrontmatter = frontmatter.replace(re, `$1${next}$2`);
  if (updatedFrontmatter === frontmatter) {
    throw new Error(`${file}: version ${expectedCurrent} not found in YAML frontmatter`);
  }
  fs.writeFileSync(file, updatedFrontmatter + body, "utf8");
}

function bumpFile(file, kind, expectedCurrent, next) {
  const full = path.join(REPO_ROOT, file);
  if (kind === "json") {
    bumpJsonFile(full, expectedCurrent, next);
  } else if (kind === "yaml-frontmatter") {
    bumpYamlFrontmatter(full, expectedCurrent, next);
  } else {
    throw new Error(`${file}: unknown kind ${kind}`);
  }
}

function emitOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function main() {
  const dryRun = process.argv.includes("--dry-run");

  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  const current = pkg.version;
  const next = nextVersion(parseVersion(current));

  process.stdout.write(`bump: ${current} → ${next}${dryRun ? " (dry run)" : ""}\n`);

  if (dryRun) {
    emitOutput("previous", current);
    emitOutput("next", next);
    return;
  }

  for (const f of VERSION_FILES) {
    bumpFile(f.path, f.kind, current, next);
    process.stdout.write(`  updated ${f.path}\n`);
  }

  // Bundles bake the version string into their output. Without this rebuild
  // the committed bundles drift one version behind every patch bump and the
  // "committed bundle matches fresh build" CI gate fails on every open PR.
  process.stdout.write("  regenerating bundles...\n");
  const build = spawnSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (build.status !== 0) {
    throw new Error(`npm run build exited with status ${build.status}`);
  }

  emitOutput("previous", current);
  emitOutput("next", next);
}

try {
  main();
} catch (err) {
  process.stderr.write(`bump-version failed: ${err.message}\n`);
  process.exit(1);
}
