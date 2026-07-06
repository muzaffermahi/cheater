// Validation ledger: what was proven, by which command, and whether it is STILL true.
//
// The classic small-model lie is honest at the time: "tests passed" - then the file changes
// again and the old green result gets repeated as if it were fresh. Every validation here
// names the files/artifacts it depended on; when any of them mutates later, the pass is
// marked stale. The finish gate and risk middleware read freshness, never the raw claim.
// Entries also record whether the check mirrors the evaluator (exact artifact/endpoint/
// command from the acceptance contract) or is only a proxy.

import { readRunFile, writeRunFile } from "./runDir.js";

export type ValidationStatus = "pass" | "fail" | "unknown";

/**
 * What KIND of proof this check is. Finish truth prefers evaluator_mirror / exact_* over
 * focused_test over proxy; "shallow" (existence-only probes) never counts as proof.
 */
export type ValidationResultType =
  | "evaluator_mirror"
  | "exact_artifact"
  | "exact_endpoint"
  | "focused_test"
  | "proxy"
  | "shallow";

export interface ValidationEntry {
  seq: number;
  at: string;
  /** Short name, e.g. "focused_tests" or "endpoint /health". */
  name: string;
  /** The exact command run, when there was one. */
  command?: string;
  actor: string;
  /** Files/artifacts this validation depended on. Empty = depends on the whole workspace. */
  validates: string[];
  status: ValidationStatus;
  outputSummary?: string;
  /** True when this check touches the exact artifact/path/command the evaluator will. */
  mirrorsEvaluator: boolean;
  resultType?: ValidationResultType;
  stale: boolean;
  staleReason?: string;
}

export interface ValidationLedgerSummary {
  passes: number;
  failures: number;
  stalePasses: number;
  freshPasses: number;
  evaluatorMirroringFreshPasses: number;
  /** Fresh passes whose resultType is exact/mirror - the evidence the finish gate wants. */
  freshExactPasses: number;
  lastEntry?: { name: string; status: ValidationStatus; stale: boolean };
}

const EXACT_TYPES = new Set<ValidationResultType>(["evaluator_mirror", "exact_artifact", "exact_endpoint"]);

const MAX_ENTRIES = 200;

function normalizePath(path: string): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export class ValidationLedger {
  private entries: ValidationEntry[] = [];
  private seq = 0;

  record(entry: Omit<ValidationEntry, "seq" | "at" | "stale">): ValidationEntry {
    const full: ValidationEntry = {
      ...entry,
      validates: entry.validates.map(normalizePath).filter(Boolean),
      seq: ++this.seq,
      at: new Date().toISOString(),
      stale: false
    };
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    return full;
  }

  all(): ValidationEntry[] {
    return [...this.entries];
  }

  /**
   * A mutation happened to these paths: every earlier PASS that depended on any of them
   * (or on the whole workspace, i.e. empty validates) is no longer proof of anything.
   */
  markStaleForPaths(paths: string[]): ValidationEntry[] {
    const targets = new Set(paths.map(normalizePath).filter(Boolean));
    if (!targets.size) return [];
    const newlyStale: ValidationEntry[] = [];
    for (const entry of this.entries) {
      if (entry.stale || entry.status !== "pass") continue;
      const dependsOnMutated = entry.validates.length === 0 || entry.validates.some((p) => targets.has(p));
      if (dependsOnMutated) {
        entry.stale = true;
        entry.staleReason = `files changed after this pass: ${[...targets].slice(0, 3).join(", ")}`;
        newlyStale.push(entry);
      }
    }
    return newlyStale;
  }

  freshPasses(): ValidationEntry[] {
    return this.entries.filter((e) => e.status === "pass" && !e.stale);
  }

  stalePasses(): ValidationEntry[] {
    return this.entries.filter((e) => e.status === "pass" && e.stale);
  }

  /** Is there a fresh, evaluator-mirroring pass? This is what "done" should mean. */
  hasFreshEvaluatorPass(): boolean {
    return this.freshPasses().some((e) => e.mirrorsEvaluator);
  }

  latest(): ValidationEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  summary(): ValidationLedgerSummary {
    const passes = this.entries.filter((e) => e.status === "pass");
    const fresh = this.freshPasses();
    const last = this.latest();
    return {
      passes: passes.length,
      failures: this.entries.filter((e) => e.status === "fail").length,
      stalePasses: passes.length - fresh.length,
      freshPasses: fresh.length,
      evaluatorMirroringFreshPasses: fresh.filter((e) => e.mirrorsEvaluator).length,
      freshExactPasses: fresh.filter((e) => e.mirrorsEvaluator || (e.resultType && EXACT_TYPES.has(e.resultType))).length,
      lastEntry: last ? { name: last.name, status: last.status, stale: last.stale } : undefined
    };
  }

  /** Compact lines for capsules/digests. */
  renderSummaryLines(): string[] {
    const s = this.summary();
    if (!this.entries.length) return ["no validations run yet"];
    const lines: string[] = [];
    lines.push(`validations: ${s.freshPasses} fresh pass, ${s.stalePasses} stale pass, ${s.failures} fail`);
    if (s.lastEntry) lines.push(`latest: ${s.lastEntry.name} -> ${s.lastEntry.status}${s.lastEntry.stale ? " (STALE)" : ""}`);
    const staleNames = this.stalePasses().slice(-2).map((e) => e.name);
    if (staleNames.length) lines.push(`stale (re-run before trusting): ${staleNames.join(", ")}`);
    if (!s.evaluatorMirroringFreshPasses && s.freshPasses > 0) {
      lines.push("no fresh evaluator-mirroring check yet - proxy passes only");
    }
    return lines;
  }

  save(runDir: string): void {
    try {
      writeRunFile(runDir, "validation-ledger.json", JSON.stringify({ seq: this.seq, entries: this.entries }, null, 2) + "\n");
    } catch {
      // best-effort persistence
    }
  }

  static load(runDir: string): ValidationLedger {
    const ledger = new ValidationLedger();
    const raw = readRunFile(runDir, "validation-ledger.json");
    if (!raw) return ledger;
    try {
      const parsed = JSON.parse(raw) as { seq?: number; entries?: ValidationEntry[] };
      ledger.entries = Array.isArray(parsed.entries) ? parsed.entries.slice(-MAX_ENTRIES) : [];
      ledger.seq = typeof parsed.seq === "number" ? parsed.seq : ledger.entries.length;
    } catch {
      // corrupt file -> start fresh
    }
    return ledger;
  }
}

/**
 * Does this validation mirror the evaluator? True when the command/name touches an exact
 * artifact, endpoint, or command from the acceptance contract - not just "some test ran".
 */
/**
 * Classify what kind of proof a check is, against the acceptance contract. Deterministic:
 * exact artifact/endpoint/command matches outrank focused tests, which outrank proxies;
 * existence-only probes are shallow no matter what they touch.
 */
export function classifyValidationResultType(
  commandOrName: string,
  contract: { outputPaths: string[]; endpoints: string[]; commands: string[]; files: string[] } | null
): ValidationResultType {
  const probe = (commandOrName ?? "").toLowerCase();
  if (/^\s*(?:test\s+-[ef]\s|ls\s|dir\s|stat\s|\[\s+-[ef]\s)/.test(probe)) return "shallow";
  if (contract) {
    for (const path of contract.outputPaths) {
      if (path && probe.includes(path.toLowerCase())) return "exact_artifact";
    }
    for (const endpoint of contract.endpoints) {
      if (endpoint && endpoint !== "/" && probe.includes(endpoint.toLowerCase())) return "exact_endpoint";
    }
    for (const command of contract.commands) {
      if (command && probe.includes(command.toLowerCase())) return "evaluator_mirror";
    }
    for (const file of contract.files) {
      if (file && probe.includes(file.toLowerCase())) return "evaluator_mirror";
    }
  }
  if (/\b(pytest|npm test|yarn test|go test|cargo test|focused|jest|vitest|node --test)\b/.test(probe)) return "focused_test";
  return "proxy";
}

// The build/test/lint/typecheck ACTION a command performs, or null. Lets an equivalent command
// satisfy a contract target of the same action (M4): `npx vite build` validates a `npm run build`
// target - both build the app - even though their tokens differ so a substring match misses it.
// Ordered most-specific-first so `build:watch` reads as build, `typecheck` not as `check`.
const COMMAND_ACTIONS = ["typecheck", "type-check", "e2e", "lint", "test", "build", "compile", "bundle", "serve", "start", "dev"];
export function commandAction(cmd: string): string | null {
  const c = (cmd ?? "").toLowerCase();
  for (const action of COMMAND_ACTIONS) {
    if (new RegExp(`(^|[\\s:/])${action}([\\s:/-]|$)`).test(c)) return action === "type-check" ? "typecheck" : action;
  }
  return null;
}

export function mirrorsEvaluator(
  commandOrName: string,
  contract: { outputPaths: string[]; endpoints: string[]; commands: string[]; files: string[] } | null
): boolean {
  if (!contract) return false;
  const probe = (commandOrName ?? "").toLowerCase();
  if (!probe) return false;
  for (const path of [...contract.outputPaths, ...contract.files]) {
    if (path && probe.includes(path.toLowerCase())) return true;
  }
  for (const endpoint of contract.endpoints) {
    if (endpoint && endpoint !== "/" && probe.includes(endpoint.toLowerCase())) return true;
  }
  const probeAction = commandAction(probe);
  for (const command of contract.commands) {
    if (!command) continue;
    if (probe.includes(command.toLowerCase())) return true;
    // M4: same-action equivalence (only when the command carries a recognized action verb), so a
    // proxy build/test/lint that passed counts as validating a same-action contract target. Never
    // matches across DIFFERENT actions (a build never satisfies a required grade/test command).
    if (probeAction && commandAction(command) === probeAction) return true;
  }
  return false;
}
