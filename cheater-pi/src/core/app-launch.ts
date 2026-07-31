// Native desktop launcher. The app command must never open a browser or start the web UI.

import { execSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { kittenHome } from "./paths.js";

export interface AppLaunchOptions {
  cwd?: string;
  install?: boolean;
  dryRun?: boolean;
  /** Installer/test override; production packages can set KITTEN_DESKTOP_EXE instead. */
  executable?: string;
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

/** Find the packaged Avalonia executable without consulting a browser or shell UI. */
export function resolveDesktopExecutable(override?: string): string | null {
  const candidates = [
    override,
    process.env.KITTEN_DESKTOP_EXE,
    join(packageRoot(), "..", "desktop", "Kitten.Desktop.exe"),
    join(packageRoot(), "..", "artifacts", "kitten-desktop-local", "Kitten.Desktop.exe"),
    join(packageRoot(), "desktop", "Kitten.Desktop.exe"),
    join(packageRoot(), "desktop", "dist", "Kitten.Desktop.exe"),
    join(process.cwd(), "desktop", "bin", "Kitten.Desktop.exe"),
    join(process.cwd(), "desktop", "dist", "Kitten.Desktop.exe"),
    join(process.cwd(), "desktop", "bin", "Release", "net8.0-windows", "win-x64", "Kitten.Desktop.exe"),
    join(process.cwd(), "artifacts", "kitten-desktop-local", "Kitten.Desktop.exe"),
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

function startDesktop(executable: string, cwd?: string): void {
  const child = spawn(executable, cwd ? ["--project-root", resolve(cwd)] : [], {
    cwd: cwd ? resolve(cwd) : undefined,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function launchApp(opts: AppLaunchOptions = {}): Promise<void> {
  const executable = resolveDesktopExecutable(opts.executable);
  if (!executable) {
    throw new Error("Kitten's native desktop app is not installed. Install the desktop package; the app command never falls back to a browser.");
  }
  startDesktop(executable, opts.cwd);
}

function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

export async function installLauncher(opts: AppLaunchOptions): Promise<void> {
  if (process.platform !== "win32") throw new Error("Native Kitten launcher installation is currently Windows-only.");
  const executable = resolveDesktopExecutable(opts.executable);
  if (!executable) throw new Error("Cannot install the Kitten shortcut because the native desktop executable is missing.");
  const startMenu = resolve(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
  const shortcut = resolve(startMenu, "Kitten.lnk");
  if (opts.dryRun) {
    console.log(`Shortcut: ${shortcut}`);
    console.log(`Target:   ${executable}`);
    console.log("(dry-run; no changes made)");
    return;
  }
  const script = join(kittenHome(), "__install-native-launcher.ps1");
  const lines = [
    "$WS = New-Object -ComObject WScript.Shell",
    `$SC = $WS.CreateShortcut('${psQuote(shortcut)}')`,
    `$SC.TargetPath = '${psQuote(executable)}'`,
    "$SC.WorkingDirectory = Split-Path -Parent $SC.TargetPath",
    "$SC.Save()",
  ];
  writeFileSync(script, lines.join("\r\n"), "utf8");
  try { execSync(`powershell -ExecutionPolicy Bypass -File "${script}"`, { timeout: 15_000, stdio: "pipe", windowsHide: true }); }
  finally { try { unlinkSync(script); } catch {} }
}
