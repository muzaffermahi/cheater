import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface WorkspaceVerificationResult {
  command: string;
  allowed: boolean;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface WorkspaceVerificationSummary {
  root: string;
  passed: boolean;
  cancelled: boolean;
  results: WorkspaceVerificationResult[];
}

type ParsedCommand = { executable: string; args: string[] };

/** Only commands Kitten itself recommends are executable from the native verification button. */
export function parseVerificationCommand(command: string): ParsedCommand | null {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 180 || /[;&|<>`$()]/.test(normalized)) return null;
  const parts = normalized.split(" ");
  const [name, ...args] = parts;
  if (/^npm(?:\.cmd)?$/i.test(name) && (args.length === 1 && args[0] === "test" || args.length === 2 && args[0] === "run" && ["test", "typecheck", "build"].includes(args[1]))) return process.platform === "win32" ? { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", ["npm.cmd", ...args].join(" ")] } : { executable: "npm", args };
  if (/^(?:python|python3|py)$/i.test(name) && args.length === 2 && args[0] === "-m" && args[1] === "pytest") return { executable: name, args };
  if (name === "cargo" && args.length === 1 && args[0] === "test") return { executable: name, args };
  if (name === "go" && args.length === 2 && args[0] === "test" && args[1] === "./...") return { executable: name, args };
  if (name === "dotnet" && args.length === 1 && args[0] === "test") return { executable: name, args };
  return null;
}

function runOne(root: string, command: string, parsed: ParsedCommand, timeoutMs: number, signal?: AbortSignal): Promise<WorkspaceVerificationResult> {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = spawn(parsed.executable, parsed.args, { cwd: root, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-12_000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; terminate(child); }, timeoutMs);
    const abort = (): void => terminate(child);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolveResult({ command, allowed: true, passed: false, exitCode: null, timedOut, durationMs: Date.now() - started, output: `${output}\n${error.message}`.slice(-12_000) }); });
    child.once("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolveResult({ command, allowed: true, passed: !timedOut && code === 0, exitCode: code, timedOut, durationMs: Date.now() - started, output }); });
  });
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {}
  } else child.kill("SIGTERM");
}

export async function runWorkspaceVerification(root: string, commands: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WorkspaceVerificationSummary> {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) throw new Error("workspace root must be an existing directory");
  const unique = [...new Set(commands.map((command) => command.trim()).filter(Boolean))].slice(0, 4);
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 120_000, 120_000));
  const results: WorkspaceVerificationResult[] = [];
  for (const command of unique) {
    const parsed = parseVerificationCommand(command);
    if (!parsed) { results.push({ command, allowed: false, passed: false, exitCode: null, timedOut: false, durationMs: 0, output: "Command is not in Kitten's safe verification allow-list." }); continue; }
    results.push(await runOne(resolvedRoot, command, parsed, timeoutMs, options.signal));
    if (options.signal?.aborted) break;
  }
  return { root: resolvedRoot, passed: results.length > 0 && results.every((result) => result.allowed && result.passed), cancelled: Boolean(options.signal?.aborted), results };
}
