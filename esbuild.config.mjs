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
// bundles next to the main CLI at plugin/scripts/app-server-broker.mjs.
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
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  console.log(`Build complete: ${target.label} -> ${target.cliOut}`);
}
