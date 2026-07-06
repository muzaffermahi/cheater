// Bounded typecheck gate (roadmap R1): deterministic type truth at zero model tokens.
//
// The import gate catches hallucinated imports by regex; a real typechecker catches the rest of
// the modal small-model bug class - wrong arity, bad signatures, undefined members, type
// mismatches. This gate runs the project typechecker after an edit and attributes each error to a
// file. Doctrine: concise, evidence-backed, and ESCAPABLE - it hard-blocks ONLY errors in the
// files THIS change touched (a change is responsible for its own new type errors); pre-existing
// repo-wide errors WARN, never block (you cannot make a weak model pay off unrelated type debt to
// finish its task); no typechecker or a timeout never blocks. A blocking result is routed through
// the existing bounded repair path (repair budget caps it), so it can never become a dead-end loop.
//
// TypeScript-first (the highest-impact case and the one this repo can self-validate). The shape is
// language-agnostic; more languages slot into detectTypecheckCommand.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheaterConfig } from "../types.js";

export interface TypeCheckGateResult {
  /** Whether the typechecker actually ran (false = disabled, no relevant files, or unavailable). */
  ran: boolean;
  /** Whether the typechecker reported zero errors. */
  ok: boolean;
  /** Whether this result should hard-block: changed-file errors AND blocking policy on. */
  blocking: boolean;
  command?: string;
  /** Error lines attributed to files this change touched (bounded, trimmed). */
  changedFileErrors: string[];
  /** Count of errors NOT attributable to changed files (pre-existing debt) - warn, never block. */
  otherErrorCount: number;
  summary: string;
}

const DISABLED: TypeCheckGateResult = { ran: false, ok: true, blocking: false, changedFileErrors: [], otherErrorCount: 0, summary: "typecheck gate off" };

function localBin(cwd: string, name: string): string | null {
  for (const candidate of [join(cwd, "node_modules", ".bin", name), join(cwd, "node_modules", ".bin", `${name}.cmd`)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Detect a runnable typecheck command for this repo, preferring a locally installed binary. */
export function detectTypecheckCommand(cwd: string): { command: string; kind: string } | null {
  if (existsSync(join(cwd, "tsconfig.json"))) {
    const bin = localBin(cwd, "tsc");
    // Only when tsc is actually installed locally: never let "command not found" masquerade as a
    // type error, and never trigger an implicit network install.
    if (bin) return { command: `"${bin}" --noEmit -p tsconfig.json`, kind: "typescript" };
  }
  return null;
}

// tsc: "path/to/file.ts(12,5): error TS2554: ...". Path is everything before the "(line,col)".
const TS_ERROR_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+TS\d+/;

/** Split typechecker output into errors attributed to changed files vs. everything else. */
export function attributeErrors(output: string, changedFiles: string[]): { changedFileErrors: string[]; otherErrorCount: number } {
  const changed = changedFiles.map((file) => file.replace(/\\/g, "/"));
  const changedFileErrors: string[] = [];
  let otherErrorCount = 0;
  for (const line of (output ?? "").split(/\r?\n/)) {
    const match = line.match(TS_ERROR_LINE);
    if (!match) continue;
    const path = match[1].trim().replace(/\\/g, "/");
    const attributed = changed.some((file) => path === file || path.endsWith(`/${file}`) || file.endsWith(`/${path}`) || path.endsWith(file) || file.endsWith(path));
    if (attributed) {
      if (changedFileErrors.length < 8) changedFileErrors.push(line.trim().slice(0, 240));
    } else {
      otherErrorCount += 1;
    }
  }
  return { changedFileErrors, otherErrorCount };
}

type RunFn = (command: string, opts: { cwd: string; timeoutSeconds: number }) => { returncode: number; stdout: string; stderr: string; timedOut: boolean };

const defaultRun: RunFn = (command, opts) => {
  const result = spawnSync(command, { cwd: opts.cwd, shell: true, encoding: "utf8", timeout: opts.timeoutSeconds * 1000, windowsHide: true });
  return {
    returncode: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.signal === "SIGTERM" || result.signal === "SIGKILL"
  };
};

/**
 * Run the typecheck gate for a commitlet's changed files. Deterministic, never throws. `run` is
 * injectable so tests exercise the policy without invoking a real typechecker.
 */
export function runTypeCheckGate(params: { cwd: string; changedFiles: string[]; config: CheaterConfig; run?: RunFn }): TypeCheckGateResult {
  const { cwd, changedFiles, config } = params;
  const relevant = changedFiles.filter((file) => /\.(m|c)?tsx?$/.test(file));
  if (!relevant.length) return { ...DISABLED, summary: "no TypeScript files changed" };
  const detected = detectTypecheckCommand(cwd);
  if (!detected) return { ...DISABLED, summary: "no typechecker available (honest skip)" };

  const timeoutSeconds = Math.max(10, Math.floor((config.typeCheckGateTimeoutMs ?? 120_000) / 1000));
  const outcome = (params.run ?? defaultRun)(detected.command, { cwd, timeoutSeconds });
  if (outcome.timedOut) {
    // A slow typecheck must never dead-end the model: record it, do not block.
    return { ran: true, ok: false, blocking: false, command: detected.command, changedFileErrors: [], otherErrorCount: 0, summary: `typecheck timed out after ${timeoutSeconds}s (not blocking)` };
  }
  const { changedFileErrors, otherErrorCount } = attributeErrors(`${outcome.stdout}\n${outcome.stderr}`, relevant);
  const ok = outcome.returncode === 0;
  const blocking = changedFileErrors.length > 0 && config.typeCheckGateBlocking !== false;
  const summary = ok
    ? "typecheck clean"
    : changedFileErrors.length
      ? `typecheck: ${changedFileErrors.length} error(s) in changed files${blocking ? "" : " (warn only)"}`
      : `typecheck: ${otherErrorCount} pre-existing error(s) not caused by this change (not blocking)`;
  return { ran: true, ok, blocking, command: detected.command, changedFileErrors, otherErrorCount, summary };
}
