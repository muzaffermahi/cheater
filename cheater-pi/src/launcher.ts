import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { CheaterConfig, LaunchOptions, PiCommandResolution } from "./types.js";

/** The product name stamped onto the bundled Pi runtime (Pi's own white-label field). The mascot
 *  cat's name. Internal identifiers (.cheater/, @cheater/cheater-pi, cheater_* tools) are unchanged. */
export const BRAND_NAME = "Kitten Code";

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

/**
 * Path to the Pi runtime bundled with Cheater (a normal dependency), resolved wherever npm
 * placed it (local node_modules or hoisted) via Node's own resolver. This copy is what Cheater
 * brands as "Cheater"; the user's global `pi`, if any, is left untouched.
 */
export function bundledPiCli(root = packageDir()): string | undefined {
  const rel = join("@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const candidates: string[] = [];
  // 1) Node's resolver (handles npm hoisting). Resolve the package ENTRY, not its package.json -
  //    a package with an `exports` map blocks deep `/package.json` resolution - then walk up to
  //    the package root and take dist/cli.js.
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve("@earendil-works/pi-coding-agent"));
    while (dir !== dirname(dir) && !existsSync(join(dir, "package.json"))) dir = dirname(dir);
    candidates.push(join(dir, "dist", "cli.js"));
  } catch { /* fall through to path guesses */ }
  // 2) Directly under the Cheater package (local dev / un-hoisted install).
  candidates.push(join(root, "node_modules", rel));
  // 3) Hoisted a level up (a global install puts deps beside @cheater/cheater-pi).
  candidates.push(join(root, "..", "..", rel));
  return candidates.find((cli) => existsSync(cli));
}

export function resolvePiCommand(config: CheaterConfig = {}): PiCommandResolution {
  const configured = process.env.CHEATER_PI_COMMAND ?? process.env.CHEATER_PI_PATH ?? config.piCommand;
  if (configured) return { command: Array.isArray(configured) ? configured : [configured], source: process.env.CHEATER_PI_COMMAND || process.env.CHEATER_PI_PATH ? "env" : "config" };

  // Prefer the bundled Pi so Cheater controls the runtime version AND its branding. Run it with
  // the SAME node that launched us (process.execPath) rather than relying on "node" being on PATH.
  const bundled = bundledPiCli();
  if (bundled) return { command: [process.execPath, bundled], source: "bundled" };

  const found = findOnPath("pi");
  if (found) return { command: [found], source: "path" };
  const npmPi = process.env.APPDATA ? join(process.env.APPDATA, "npm", process.platform === "win32" ? "pi.cmd" : "pi") : "";
  if (npmPi && existsSync(npmPi) && !isStaleCheaterPiShim(npmPi)) return { command: [npmPi], source: "path" };
  return { command: ["pi"], source: "fallback" };
}

/**
 * White-label the bundled Pi: Pi reads its app identity from `piConfig.name` in its OWN
 * package.json (APP_NAME/APP_TITLE, the terminal `process.title`, the header logo, the window
 * title). Setting it to "Cheater" is the only way to hide the "pi" name a running extension
 * cannot touch. We KEEP `configDir` (default ".pi") so the user's existing Pi login/sessions/
 * config keep working. Idempotent and best-effort: branding must never block a launch, and it is
 * re-applied every run so it self-heals if `npm i` regenerates node_modules.
 */
export function ensurePiBranded(cliJs: string): void {
  try {
    const pkgPath = join(resolve(dirname(cliJs), ".."), "package.json");
    if (!existsSync(pkgPath)) return;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { piConfig?: { name?: string; configDir?: string } };
    const current = pkg.piConfig ?? {};
    if (current.name === BRAND_NAME) return; // already branded; nothing to write
    pkg.piConfig = { ...current, name: BRAND_NAME, configDir: current.configDir ?? ".pi" };
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch {
    // A read-only/locked node_modules or malformed package.json must not stop Cheater launching;
    // the worst case is the runtime still shows "pi", not a crash.
  }
}

/** Brand the resolved Pi iff it is the bundled copy we own. Never mutates a user-provided pi. */
export function brandResolvedPi(config: CheaterConfig = {}): void {
  const resolved = resolvePiCommand(config);
  if (resolved.source !== "bundled") return;
  ensurePiBranded(resolved.command[resolved.command.length - 1]);
}

export function buildPiCommand(config: CheaterConfig, options: LaunchOptions, root = packageDir()): string[] {
  const resolved = resolvePiCommand(config).command;
  const paths = resourcePaths(root);
  // Cheater's system prompt is injected once, config-aware, at before_agent_start (see
  // prompts.ts buildSystemPrompt). We deliberately do NOT also pass --append-system-prompt
  // for cheater.md: a small model reconciling two drifted copies of the same rulebook is a
  // known failure mode. --prompt-template stays for Pi's base identity/template resolution.
  const command = [
    ...resolved,
    "--extension", paths.extension,
    "--skill", paths.skills,
    "--prompt-template", paths.prompts,
    "--name", BRAND_NAME
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
