#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, VERSION } from "./config.js";
import { brandResolvedPi, buildPiCommand, firstLegacyCommand, formatCommand, spawnPi } from "./launcher.js";
import { printDoctor } from "./doctor.js";
import { parseLaunchOptions } from "./launcher.js";
import { runReliabilityCli } from "./reliability/cli.js";
import { runTui } from "./core/tui.js";
import { kittenHome } from "./core/paths.js";

function printHelp(): void {
  console.log(`Cheater ${VERSION} — compatibility alias for Kitten

Usage:
  cheater [message]        open Kitten (the canonical product) in the current directory
  cheater --pi             open the legacy Pi-based UI (compatibility only)
  cheater --doctor         check the runtime and resource wiring
  cheater bench reliability <command> [args...]

Cheater is now Kitten. Prefer running \`kitten\` directly — the new terminal UI, \`kitten web\` for the
browser UI, and \`kitten run "<task>"\` for a headless, persisted run.

Options:
  --pi                 launch the legacy Pi UI instead of Kitten
  --doctor             check the runtime and Cheater resource wiring
  --version, -v        print version
  --print-pi-command   print the resolved legacy Pi launch command and exit
  --help, -h           show help
`);
}

// A subtle, at-most-once migration notice (persisted under the Kitten home).
function migrationNoticeOnce(): void {
  try {
    const flag = join(kittenHome(), ".cheater-migrated");
    if (existsSync(flag)) return;
    writeFileSync(flag, new Date().toISOString());
  } catch { /* fall through and still print once per process */ }
  process.stderr.write("note: `cheater` now opens Kitten. Run `kitten` directly, or `cheater --pi` for the legacy Pi UI.\n");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "bench" && argv[1] === "reliability") {
    return runReliabilityCli(argv.slice(2), { cwd: process.cwd(), config: loadConfig() });
  }
  const wantsPi = argv.includes("--pi");
  const options = parseLaunchOptions(argv.filter((a) => a !== "--pi"));
  const config = loadConfig();
  if (options.help) { printHelp(); return 0; }
  if (options.version) { console.log(`cheater ${VERSION}`); return 0; }
  if (options.doctor) return printDoctor(config, options);

  const legacy = firstLegacyCommand(options.passthrough);
  if (legacy) {
    console.error(`cheater: ${legacy} was part of an old CLI. Run kitten to open the Kitten UI.`);
    return 2;
  }

  // Compatibility alias: by default `cheater` opens the canonical Kitten product, NOT the old Pi path.
  if (!wantsPi && !options.printPiCommand) {
    migrationNoticeOnce();
    await runTui(options.passthrough);
    return 0;
  }

  // Legacy Pi path (opt-in via --pi, or when just printing the resolved command).
  const command = buildPiCommand(config, options);
  if (options.debug || config.debug) console.log(formatCommand(command));
  if (options.printPiCommand) { console.log(formatCommand(command)); return 0; }
  brandResolvedPi(config);
  const code = spawnPi(command);
  if (code === 127) {
    console.error("cheater: could not start the legacy Pi runtime. Run `kitten` for the standalone product, or reinstall.");
  }
  return code;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  process.stderr.write(`cheater fatal: ${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
