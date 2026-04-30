import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

// Dual-output build during the v2.0 plugin migration.
//
//   skill/   legacy install layout for ~/.claude/skills/codex-bridge.
//            Maintained through the Phase 3 overlap; dropped in Phase 4.
//   plugin/  canonical Claude Code plugin install layout (Phase 1+).
//            Distributed via /plugin marketplace add github:yigitkonur/codex-bridge.
//
// Within skill/, the broker bundles to skill/app-server-broker.mjs (one level
// up from skill/scripts/codex-bridge.mjs). Within plugin/, the broker
// bundles next to the main CLI at plugin/scripts/app-server-broker.mjs, and
// the plugin command/agent surfaces are copied under the paths declared by
// plugin/.claude-plugin/plugin.json.
// src/lib/broker-lifecycle.mjs::resolveBrokerScriptPath() probes both
// layouts (plus the source-mode location) so the bundled CLI resolves the
// broker correctly regardless of distribution shape.

const targets = [
  {
    label: "skill (legacy, deprecated in Phase 4)",
    cliOut: "skill/scripts/codex-bridge.mjs",
    brokerOut: "skill/app-server-broker.mjs",
    assetsRoot: "skill",
  },
  {
    label: "plugin (canonical from v2.0.0)",
    cliOut: "plugin/scripts/codex-bridge.mjs",
    brokerOut: "plugin/scripts/app-server-broker.mjs",
    assetsRoot: "plugin",
  },
];

const staticAssets = [
  ["src/prompts/adversarial-review.md", "prompts/adversarial-review.md"],
  ["src/schemas/review-output.schema.json", "schemas/review-output.schema.json"],
  ["src/templates/execute-instructions.md", "templates/execute-instructions.md"],
  ["src/templates/plan-enforcement.md", "templates/plan-enforcement.md"],
];

const pluginOnlyAssets = [
  ["skill/config.yaml", "config.yaml"],
];

function copyFile(src, dest, transform = (value) => value) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, transform(fs.readFileSync(src, "utf8")));
}

function copyDirectory(srcDir, destDir, transform) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(src, dest, transform);
    } else if (entry.isFile()) {
      copyFile(src, dest, transform);
    }
  }
}

function toPluginRuntimePath(content) {
  return content
    .replaceAll(
      "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs",
      "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs",
    )
    .replaceAll(
      'path.resolve(SCRIPT_DIR, "..", "skill", "scripts", "codex-bridge.mjs")',
      'path.resolve(SCRIPT_DIR, "..", "scripts", "codex-bridge.mjs")',
    );
}

for (const target of targets) {
  await build({
    entryPoints: ["src/codex-bridge.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: target.cliOut,
    external: [],
    minify: false,
    sourcemap: false,
    logLevel: "info",
  });

  await build({
    entryPoints: ["src/adapters/codex/broker.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: target.brokerOut,
    external: [],
    minify: false,
    sourcemap: false,
    logLevel: "info",
  });

  for (const [src, suffix] of staticAssets) {
    const dest = `${target.assetsRoot}/${suffix}`;
    copyFile(src, dest);
  }

  if (target.assetsRoot === "plugin") {
    for (const [src, suffix] of pluginOnlyAssets) {
      copyFile(src, `${target.assetsRoot}/${suffix}`);
    }

    // T9+: commands are now authored under plugin/commands/ directly. Only
    // copy from root if the legacy directory still exists during overlap.
    if (fs.existsSync("commands")) {
      copyDirectory("commands", "plugin/commands", toPluginRuntimePath);
    }
    if (fs.existsSync("agents")) {
      copyDirectory("agents", "plugin/agents", toPluginRuntimePath);
    }
    if (fs.existsSync("hooks")) {
      copyDirectory("hooks", "plugin/hooks", toPluginRuntimePath);
    }
  }

  console.log(`Build complete: ${target.label} -> ${target.cliOut}`);
}
