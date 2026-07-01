#!/usr/bin/env node
import { loadConfig, VERSION } from "./config.js";
import { buildPiCommand, firstLegacyCommand, formatCommand, spawnPi } from "./launcher.js";
import { printDoctor } from "./doctor.js";
import { parseLaunchOptions } from "./launcher.js";
import { runGymCli } from "./gym/cli.js";
import { runReliabilityCli } from "./reliability/cli.js";

function printHelp(): void {
  console.log(`Cheater ${VERSION} - Pi-based coding agent distribution

Usage:
  cheater [Pi options] [message]
  cheater --doctor
  cheater --print-pi-command
  cheater gym <command> [args...]
  cheater bench reliability <command> [args...]

Cheater starts Pi's TUI with Cheater's extension, prompt, skills, slash
commands, and theme preloaded. It never starts the old Python TUI.

Options:
  --doctor             Check Pi discovery and Cheater resource wiring
  --version, -v        Print Cheater version
  --debug              Print resolved Pi command before launching
  --no-theme           Keep Cheater behavior but skip the Cheater theme
  --print-pi-command   Print the resolved Pi command and exit
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
    console.error(`cheater: ${legacy} was part of the old Python CLI. Run cheater to open the Cheater-flavored Pi TUI.`);
    return 2;
  }

  const command = buildPiCommand(config, options);
  if (options.debug || config.debug) console.log(formatCommand(command));
  if (options.printPiCommand) {
    console.log(formatCommand(command));
    return 0;
  }
  const code = spawnPi(command);
  if (code === 127) {
    console.error("cheater: Pi was not found. Install Pi or set CHEATER_PI_COMMAND, then run cheater --doctor.");
  }
  return code;
}

process.exitCode = main();
