#!/usr/bin/env node
// Production-safe compatibility alias. The legacy Pi launcher is intentionally not part of the
// published package; `cheater` now forwards to the standalone Kitten command without importing it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const kitten = join(dirname(fileURLToPath(import.meta.url)), "kitten.js");
process.stderr.write("Cheater is now Kitten — forwarding to `kitten`.\n");
const child = spawnSync(process.execPath, [kitten, ...process.argv.slice(2)], { stdio: "inherit" });
if (child.error) {
  process.stderr.write(`Could not start Kitten: ${child.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = child.status ?? 1;
}
