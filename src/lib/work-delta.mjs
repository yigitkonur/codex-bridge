import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runGit(cwd, args) {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) {
      return null;
    }
    return result.stdout ?? "";
  } catch {
    return null;
  }
}

function resolveInsideCwd(cwd, relativePath) {
  const root = path.resolve(cwd);
  const absolutePath = path.resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
    return null;
  }
  return absolutePath;
}

function collectUntrackedStats(cwd, output) {
  const stats = [];
  for (const relativePath of String(output ?? "").split("\0").filter(Boolean)) {
    const absolutePath = resolveInsideCwd(cwd, relativePath);
    if (!absolutePath) {
      continue;
    }
    try {
      const stat = fs.lstatSync(absolutePath);
      stats.push([
        relativePath,
        stat.isDirectory() ? "dir" : "file",
        stat.size,
        Math.trunc(stat.mtimeMs),
      ]);
    } catch {
      stats.push([relativePath, "missing", 0, 0]);
    }
  }
  return stats;
}

export function captureWorkFingerprint(cwd) {
  const status = runGit(cwd, ["status", "--porcelain=v1", "-z"]);
  if (status == null) {
    return null;
  }

  const diff = runGit(cwd, ["diff", "--binary", "HEAD"]) ?? "";
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "";
  const untrackedStats = collectUntrackedStats(cwd, untracked);
  return {
    signature: JSON.stringify({ status, diff, untrackedStats }),
  };
}

export function hasWorkChangedSince(cwd, startFingerprint, touchedFiles = []) {
  if (Array.isArray(touchedFiles) && touchedFiles.some((file) => typeof file === "string" && file.length > 0)) {
    return true;
  }
  if (!startFingerprint?.signature) {
    return false;
  }
  const current = captureWorkFingerprint(cwd);
  return Boolean(current?.signature && current.signature !== startFingerprint.signature);
}
