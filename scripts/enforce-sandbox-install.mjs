#!/usr/bin/env node
import { installSandboxEnforcement } from "../src/lib/sandbox-enforcement.mjs";

const result = installSandboxEnforcement();
process.stdout.write(
  `${result.alreadyInstalled ? "Codex Bridge sandbox enforcement already installed" : "Codex Bridge sandbox enforcement installed"} in ${result.status.settingsPath}.\n`,
);
