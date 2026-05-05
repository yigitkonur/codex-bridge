#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST_DIR = path.join(ROOT, "dist");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function parseArgs(argv) {
  const options = { tag: null, distDir: DIST_DIR, skipBuild: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") {
      options.tag = argv[++i] ?? null;
    } else if (arg === "--dist") {
      options.distDir = path.resolve(argv[++i] ?? "");
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    "Usage: node scripts/package-release.mjs [--tag vX.Y.Z] [--dist <dir>] [--skip-build] [--json]\n"
  );
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function assertFile(relativePath) {
  const target = path.join(ROOT, relativePath);
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Missing or empty release input: ${relativePath}`);
  }
}

function copySkillPayload(stageDir) {
  const payloadDir = path.join(stageDir, "codex-bridge");
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.cpSync(path.join(ROOT, "skill"), payloadDir, { recursive: true });
  for (const maintainerFile of ["AGENTS.md", "CLAUDE.md"]) {
    fs.rmSync(path.join(payloadDir, maintainerFile), { force: true });
  }
  return payloadDir;
}

function createArchive({ format, tag, stageDir, distDir }) {
  const extension = format === "tar" ? "tar.gz" : "zip";
  const output = path.join(distDir, `codex-bridge-${tag}.${extension}`);
  fs.rmSync(output, { force: true });
  if (format === "tar") {
    run("tar", ["-czf", output, "-C", stageDir, "codex-bridge"]);
  } else {
    run("zip", ["-qr", output, "codex-bridge"], { cwd: stageDir });
  }
  return output;
}

function runZip(output, stageDir) {
  const result = spawnSync("zip", ["-qr", output, "codex-bridge"], { cwd: stageDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`zip exited ${result.status}`);
  }
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeChecksums(files, distDir) {
  const target = path.join(distDir, "SHA256SUMS");
  const lines = files.map((filePath) => `${sha256(filePath)}  ${path.basename(filePath)}`);
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
  return target;
}

function extractChangelogSection(version) {
  const changelogPath = path.join(ROOT, "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) return "";
  const lines = fs.readFileSync(changelogPath, "utf8").split(/\r?\n/);
  const header = `## [${version}]`;
  const start = lines.findIndex((line) => line.startsWith(header));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function writeReleaseNotes({ tag, version, distDir }) {
  const section = extractChangelogSection(version);
  const notes = [
    "## Install",
    "",
    "```sh",
    "npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y",
    "```",
    "",
    "Verify with `node ~/.claude/skills/codex-bridge/scripts/codex-bridge.mjs setup --json`.",
    "Check for later updates with `node ~/.claude/skills/codex-bridge/scripts/codex-bridge.mjs update` or `/codex-bridge:update`.",
    "",
    "---",
    "",
    section || `_No CHANGELOG section found for \`${version}\` / \`${tag}\`._`,
    "",
  ].join("\n");
  const target = path.join(distDir, "RELEASE_NOTES.md");
  fs.writeFileSync(target, notes, "utf8");
  return target;
}

export function packageRelease(options = {}) {
  const pkg = readJson("package.json");
  const tag = options.tag ?? process.env.GITHUB_REF_NAME ?? `v${pkg.version}`;
  const version = tag.replace(/^v/i, "");
  if (version !== pkg.version) {
    throw new Error(`Release tag ${tag} does not match package.json version ${pkg.version}`);
  }

  if (!options.skipBuild) run("npm", ["run", "build"]);

  for (const input of [
    "skill/SKILL.md",
    "skill/scripts/codex-bridge.mjs",
    "skill/app-server-broker.mjs",
    "skill/config.yaml",
  ]) {
    assertFile(input);
  }

  const distDir = path.resolve(options.distDir ?? DIST_DIR);
  const stageDir = path.join(distDir, "_stage");
  fs.mkdirSync(distDir, { recursive: true });
  const payloadDir = copySkillPayload(stageDir);
  const tarball = createArchive({ format: "tar", tag, stageDir, distDir });
  const zipPath = path.join(distDir, `codex-bridge-${tag}.zip`);
  fs.rmSync(zipPath, { force: true });
  runZip(zipPath, stageDir);
  const checksums = writeChecksums([tarball, zipPath], distDir);
  const notes = writeReleaseNotes({ tag, version, distDir });
  fs.rmSync(stageDir, { recursive: true, force: true });

  return {
    tag,
    version,
    distDir,
    payloadDir,
    artifacts: {
      tarball,
      zip: zipPath,
      checksums,
      releaseNotes: notes,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = packageRelease(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    } else {
      process.stdout.write(`Release package ready in ${result.distDir}\n`);
      for (const filePath of Object.values(result.artifacts)) {
        process.stdout.write(`  ${path.relative(ROOT, filePath)}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`package-release failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
