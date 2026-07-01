import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CheaterConfig, LaunchOptions, PiCommandResolution } from "./types.js";

export const legacyCommands = new Set([
  "agent", "arena", "audit-cards", "bench", "benchmark", "build-cards", "build-index",
  "budget", "ctx", "doctor", "explore", "guide", "init", "init-data", "janitor",
  "lint", "localize", "map", "memory", "model", "patch", "rescore", "run", "search",
  "sessions", "smoke", "test", "trace", "tui", "undo"
]);

export function packageDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (basename(here) === "src" && basename(dirname(here)) === "dist") {
    return resolve(here, "..", "..");
  }
  if (basename(here) === "src") return resolve(here, "..");
  return resolve(here, "..");
}

export function resourcePaths(root = packageDir()) {
  return {
    extension: join(root, "src", "extension.ts"),
    prompts: join(root, "prompts"),
    prompt: join(root, "prompts", "cheater.md"),
    skills: join(root, "skills"),
    theme: join(root, "themes", "cheater.json")
  };
}

export function parseLaunchOptions(argv: string[]): LaunchOptions {
  const passthrough: string[] = [];
  const options: LaunchOptions = {
    doctor: false,
    debug: false,
    noTheme: false,
    printPiCommand: false,
    help: false,
    version: false,
    passthrough
  };
  for (const arg of argv) {
    if (arg === "--doctor") options.doctor = true;
    else if (arg === "--debug") options.debug = true;
    else if (arg === "--no-theme") options.noTheme = true;
    else if (arg === "--print-pi-command") options.printPiCommand = true;
    else if (arg === "--help" || arg === "-h" || arg === "help") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else passthrough.push(arg);
  }
  return options;
}

export function resolvePiCommand(config: CheaterConfig = {}): PiCommandResolution {
  const configured = process.env.CHEATER_PI_COMMAND ?? process.env.CHEATER_PI_PATH ?? config.piCommand;
  if (configured) return { command: Array.isArray(configured) ? configured : [configured], source: process.env.CHEATER_PI_COMMAND || process.env.CHEATER_PI_PATH ? "env" : "config" };

  const found = findOnPath("pi");
  if (found) return { command: [found], source: "path" };
  const npmPi = process.env.APPDATA ? join(process.env.APPDATA, "npm", process.platform === "win32" ? "pi.cmd" : "pi") : "";
  if (npmPi && existsSync(npmPi) && !isStaleCheaterPiShim(npmPi)) return { command: [npmPi], source: "path" };
  return { command: ["pi"], source: "fallback" };
}

export function buildPiCommand(config: CheaterConfig, options: LaunchOptions, root = packageDir()): string[] {
  const resolved = resolvePiCommand(config).command;
  const paths = resourcePaths(root);
  const command = [
    ...resolved,
    "--extension", paths.extension,
    "--skill", paths.skills,
    "--prompt-template", paths.prompts,
    "--append-system-prompt", paths.prompt,
    "--name", "Cheater"
  ];
  if (config.provider) command.push("--provider", config.provider);
  if (config.model) command.push("--model", config.model);
  if (config.themeEnabled !== false && !options.noTheme) command.push("--theme", paths.theme);
  command.push(...options.passthrough);
  return command;
}

export function firstLegacyCommand(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-") && legacyCommands.has(arg));
}

export function formatCommand(args: string[]): string {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
}

function findOnPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const dirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate) && !isStaleCheaterPiShim(candidate)) return candidate;
    }
  }
  return undefined;
}

export function isStaleCheaterPiShim(path: string): boolean {
  try {
    return existsSync(path) && readFileSync(path, "utf8").includes("--wrap-pi");
  } catch {
    return false;
  }
}

export function spawnPi(command: string[]): number {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", cwd: process.cwd(), shell: false });
  if (result.error) return (result.error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1;
  return result.status ?? 0;
}

export function configExamplePath(): string {
  return join(homedir(), ".config", "cheater", "config.json");
}
