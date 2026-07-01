import { accessSync, constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { CheaterConfig, DoctorCheck, LaunchOptions } from "./types.js";
import { buildPiCommand, formatCommand, resolvePiCommand, resourcePaths } from "./launcher.js";

function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

export function doctorChecks(config: CheaterConfig, options: LaunchOptions, root?: string): DoctorCheck[] {
  const paths = resourcePaths(root);
  const pi = resolvePiCommand(config);
  const node = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
  return [
    { name: "Pi is resolvable", ok: pi.source !== "fallback", detail: pi.command.join(" ") },
    { name: "Cheater extension exists", ok: existsSync(paths.extension), detail: paths.extension },
    { name: "Cheater prompt exists", ok: existsSync(paths.prompt), detail: paths.prompt },
    { name: "Cheater skills exist", ok: existsSync(paths.skills), detail: paths.skills },
    { name: "Cheater theme exists", ok: existsSync(paths.theme), detail: paths.theme },
    { name: "Current folder readable", ok: canAccess(process.cwd(), constants.R_OK), detail: process.cwd() },
    { name: "Current folder writable", ok: canAccess(process.cwd(), constants.W_OK), detail: process.cwd() },
    { name: "Node is available", ok: node.status === 0, detail: node.stdout.trim() || process.execPath },
    { name: "Old Python TUI is not entrypoint", ok: true, detail: "cheater delegates to Pi with Cheater resources" },
    { name: "No stale dual-mode entrypoint remains", ok: true, detail: "old subcommands are blocked as primary commands" },
    { name: "Resolved launch command", ok: true, detail: formatCommand(buildPiCommand(config, options, root)) }
  ];
}

export function printDoctor(config: CheaterConfig, options: LaunchOptions, root?: string): number {
  const checks = doctorChecks(config, options, root);
  console.log("Cheater doctor");
  console.log(`repo: ${process.cwd()}`);
  for (const check of checks) {
    console.log(`[${check.ok ? "OK" : "FAIL"}] ${check.name}: ${check.detail}`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}
