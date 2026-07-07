#!/usr/bin/env node
import { loadConfig, VERSION } from "./config.js";
import { brandResolvedPi, buildPiCommand, firstLegacyCommand, formatCommand, spawnPi } from "./launcher.js";
import { printDoctor } from "./doctor.js";
import { parseLaunchOptions } from "./launcher.js";
import { runGymCli } from "./gym/cli.js";
import { runReliabilityCli } from "./reliability/cli.js";

function printHelp(): void {
  console.log(`Cheater ${VERSION} - a reliable local-first coding agent

Usage:
  cheater [options] [message]
  cheater --doctor
  cheater --print-pi-command
  cheater gym <command> [args...]
  cheater bench reliability <command> [args...]

Cheater opens its terminal UI with the reliability harness, prompt, skills,
slash commands, and theme preloaded.

Options:
  --doctor             Check the runtime and Cheater resource wiring
  --version, -v        Print Cheater version
  --debug              Print the resolved launch command before starting
  --no-theme           Keep Cheater behavior but skip the Cheater theme
  --print-pi-command   Print the resolved launch command and exit
  --help, -h           Show help

Gym subcommands:
  cheater gym list                  list available benchmark tasks
  cheater gym show <id>             show one task card
  cheater gym run <id>              prepare a workspace and print the prompt
  cheater gym report [latest]       show the latest report
  cheater gym clean                 remove all gym workspaces and reports
  cheater gym help                  show gym subcommand help
`);
}

export function main(argv = process.argv.slice(2)): number {
  if (argv[0] === "gym") {
    return runGymCli(argv.slice(1), { cwd: process.cwd() });
  }
  if (argv[0] === "bench" && argv[1] === "reliability") {
    return runReliabilityCli(argv.slice(2), { cwd: process.cwd(), config: loadConfig() });
  }
  const options = parseLaunchOptions(argv);
  const config = loadConfig();
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.version) {
    console.log(`cheater ${VERSION}`);
    return 0;
  }
  if (options.doctor) return printDoctor(config, options);

  const legacy = firstLegacyCommand(options.passthrough);
  if (legacy) {
    console.error(`cheater: ${legacy} was part of an old CLI. Run cheater to open the Cheater TUI.`);
    return 2;
  }

  const command = buildPiCommand(config, options);
  if (options.debug || config.debug) console.log(formatCommand(command));
  if (options.printPiCommand) {
    console.log(formatCommand(command));
    return 0;
  }
  // White-label the bundled runtime just before launch (idempotent, best-effort) so the terminal
  // title, banner, and window title read "Cheater" instead of "pi".
  brandResolvedPi(config);
  const code = spawnPi(command);
  if (code === 127) {
    console.error("cheater: could not start the Cheater runtime. Reinstall Cheater, or set CHEATER_PI_COMMAND, then run cheater --doctor.");
  }
  return code;
}

process.exitCode = main();
