// Mutation ledger: filesystem truth as a state machine, not scrollback archaeology.
//
// Every state-changing action (file created/modified/deleted, dependency installed, process
// started, artifact generated, git operation) is recorded as one compact entry with an actor
// and a reason. Prompts never carry raw terminal logs to explain "what changed" - they carry
// the ledger's summary. This also feeds staleness: the validation ledger marks a passing
// check stale when a file it depended on mutates afterwards.

import { readRunFile, writeRunFile } from "./runDir.js";

export type MutationAction =
  | "file_created"
  | "file_modified"
  | "file_deleted"
  | "dependency_installed"
  | "process_started"
  | "process_stopped"
  | "artifact_generated"
  | "git_operation"
  | "permission_change"
  | "env_change"
  | "other";

export interface MutationEntry {
  seq: number;
  at: string;
  /** Who did it: "controller", a worker role, or a tool name. */
  actor: string;
  action: MutationAction;
  paths: string[];
  /** The tool or command responsible. */
  source: string;
  reason?: string;
  /** True once a later validation covered this mutation; undefined = not yet validated. */
  validated?: boolean;
}

export interface MutationLedgerSummary {
  createdFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  dependenciesInstalled: string[];
  riskyMutations: string[];
  unvalidatedPaths: string[];
  total: number;
}

const RISKY_ACTIONS = new Set<MutationAction>(["file_deleted", "git_operation", "permission_change"]);
const MAX_ENTRIES = 500;

function normalizePath(path: string): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export class MutationLedger {
  private entries: MutationEntry[] = [];
  private seq = 0;

  record(entry: Omit<MutationEntry, "seq" | "at">): MutationEntry {
    const full: MutationEntry = {
      ...entry,
      paths: entry.paths.map(normalizePath).filter(Boolean),
      seq: ++this.seq,
      at: new Date().toISOString()
    };
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    return full;
  }

  all(): MutationEntry[] {
    return [...this.entries];
  }

  /** True if any recorded mutation touched this path (created/modified by any actor this run,
   *  including a shell command). Overwriting a file the run itself made is not destroying unseen code. */
  hasTouched(path: string): boolean {
    const norm = normalizePath(path);
    if (!norm) return false;
    return this.entries.some((entry) => entry.paths.includes(norm));
  }

  /** Mark every mutation touching these paths as covered by a validation. */
  markValidated(paths: string[]): void {
    const targets = new Set(paths.map(normalizePath));
    for (const entry of this.entries) {
      if (entry.paths.some((p) => targets.has(p))) entry.validated = true;
    }
  }

  /** Mark ALL current mutations validated (a full-suite pass covers everything so far). */
  markAllValidated(): void {
    for (const entry of this.entries) entry.validated = true;
  }

  summary(): MutationLedgerSummary {
    const created = new Set<string>();
    const modified = new Set<string>();
    const deleted = new Set<string>();
    const deps = new Set<string>();
    const risky: string[] = [];
    const unvalidated = new Set<string>();
    for (const entry of this.entries) {
      for (const path of entry.paths) {
        if (entry.action === "file_created") { created.add(path); deleted.delete(path); }
        else if (entry.action === "file_modified" || entry.action === "artifact_generated") { if (!created.has(path)) modified.add(path); }
        else if (entry.action === "file_deleted") { deleted.add(path); created.delete(path); modified.delete(path); }
        else if (entry.action === "dependency_installed") deps.add(path);
        if (entry.validated !== true && entry.action.startsWith("file")) unvalidated.add(path);
      }
      if (RISKY_ACTIONS.has(entry.action)) {
        risky.push(`${entry.action}: ${entry.paths.slice(0, 3).join(", ") || entry.source}`.slice(0, 120));
      }
    }
    return {
      createdFiles: [...created].slice(0, 20),
      modifiedFiles: [...modified].slice(0, 20),
      deletedFiles: [...deleted].slice(0, 10),
      dependenciesInstalled: [...deps].slice(0, 10),
      riskyMutations: risky.slice(-5),
      unvalidatedPaths: [...unvalidated].slice(0, 15),
      total: this.entries.length
    };
  }

  /** Compact lines for capsules/digests - never raw logs. */
  renderSummaryLines(): string[] {
    const s = this.summary();
    const lines: string[] = [];
    if (s.createdFiles.length) lines.push(`created: ${s.createdFiles.join(", ")}`);
    if (s.modifiedFiles.length) lines.push(`modified: ${s.modifiedFiles.join(", ")}`);
    if (s.deletedFiles.length) lines.push(`deleted: ${s.deletedFiles.join(", ")}`);
    if (s.dependenciesInstalled.length) lines.push(`installed: ${s.dependenciesInstalled.join(", ")}`);
    if (s.riskyMutations.length) lines.push(`risky: ${s.riskyMutations.join(" | ")}`);
    if (s.unvalidatedPaths.length) lines.push(`not yet validated: ${s.unvalidatedPaths.join(", ")}`);
    if (!lines.length) lines.push("no mutations recorded");
    return lines;
  }

  save(runDir: string): void {
    try {
      writeRunFile(runDir, "mutation-ledger.json", JSON.stringify({ seq: this.seq, entries: this.entries }, null, 2) + "\n");
    } catch {
      // best-effort persistence; the in-memory ledger stays authoritative
    }
  }

  static load(runDir: string): MutationLedger {
    const ledger = new MutationLedger();
    const raw = readRunFile(runDir, "mutation-ledger.json");
    if (!raw) return ledger;
    try {
      const parsed = JSON.parse(raw) as { seq?: number; entries?: MutationEntry[] };
      ledger.entries = Array.isArray(parsed.entries) ? parsed.entries.slice(-MAX_ENTRIES) : [];
      ledger.seq = typeof parsed.seq === "number" ? parsed.seq : ledger.entries.length;
    } catch {
      // corrupt file -> start fresh rather than poisoning the run
    }
    return ledger;
  }
}

/**
 * Classify a shell command into mutation entries when it plainly changes state.
 * Returns [] for read-only commands. Deliberately conservative: unknown commands
 * are not guessed at.
 */
export function mutationsFromCommand(command: string, actor: string): Array<Omit<MutationEntry, "seq" | "at">> {
  const cmd = (command ?? "").trim();
  if (!cmd) return [];
  const out: Array<Omit<MutationEntry, "seq" | "at">> = [];
  const install = cmd.match(/\b(?:npm|pnpm|yarn)\s+(?:install|add|i)\s+([^\s;|&]+)|\bpip3?\s+install\s+([^\s;|&]+)|\bcargo\s+add\s+([^\s;|&]+)/);
  if (install) {
    const pkg = install[1] ?? install[2] ?? install[3] ?? "";
    if (!pkg.startsWith("-")) out.push({ actor, action: "dependency_installed", paths: [pkg], source: cmd.slice(0, 120) });
  } else if (/\b(?:npm|pnpm|yarn)\s+(?:ci|install)\s*$/.test(cmd) || /\bpip3?\s+install\s+-r\b/.test(cmd)) {
    out.push({ actor, action: "dependency_installed", paths: ["(manifest install)"], source: cmd.slice(0, 120) });
  }
  const rm = cmd.match(/\brm\s+(?:-[a-zA-Z]+\s+)*([^\s;|&]+)/) ?? cmd.match(/\bRemove-Item\s+(?:-\w+\s+)*([^\s;|&]+)/i) ?? cmd.match(/\bdel\s+(?:\/\w+\s+)*([^\s;|&]+)/i);
  if (rm) out.push({ actor, action: "file_deleted", paths: [rm[1]], source: cmd.slice(0, 120) });
  if (/\bgit\s+(reset|checkout|clean|revert|stash|rm|mv)\b/.test(cmd)) {
    out.push({ actor, action: "git_operation", paths: [], source: cmd.slice(0, 120) });
  }
  if (/\bchmod\b|\bchown\b|\bicacls\b/.test(cmd)) {
    out.push({ actor, action: "permission_change", paths: [], source: cmd.slice(0, 120) });
  }
  // `>` truncates and `>>` appends — BOTH modify the file. The `[^>]` guard avoids matching the second
  // `>` of `>>` as its own redirect; `>>?` then lets the append form match too (previously `>>` was
  // silently missed, so an append after a passing check never marked the old validation stale).
  const redirect = cmd.match(/(?:^|[^>])>>?\s*([\w\/.\\-]+\.[a-z0-9]{1,6})\b/i);
  if (redirect) out.push({ actor, action: "file_modified", paths: [redirect[1]], source: cmd.slice(0, 120), reason: "shell redirection" });
  return out;
}
