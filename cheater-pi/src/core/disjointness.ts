// Kitten Ascent — the anti-benchmaxx firewall (Design Law 4, the one inviolable rule).
//
// Every mechanism that FEEDS the generator from outside the task — experience memory (A3), skill
// playbooks (A4), web augmentation (A2), and the held-out proof set (D2) — must be provably disjoint
// from any evaluation set. The line between "real tool use" and "cheating" is exactly this: if the
// harness has ever seen an eval task's solution (in its memory, in a skill, cached from the web), a
// point it scores on that task is fake. This module makes the guarantee *code*, not a promise:
//
//   - a registry of eval task-ids (canonicalised) that NO store may contain;
//   - assertDisjoint(...) HARD-FAILS (throws) at store-load and store-write time on any overlap;
//   - a content fingerprint so a renamed-but-identical eval task is caught too (soft near-dup signal).
//
// The old experience/cheatSheet/apiOracle layer was deleted for being unprincipled — no disjointness
// guarantee. This is that guarantee, built first, so A2/A3/A4/D2 can only be built on top of it.

import { existsSync, readFileSync } from "node:fs";

/** Thrown when a store entry collides with a registered eval task. A run must NOT swallow this. */
export class DisjointnessError extends Error {
  constructor(public readonly overlap: string[], public readonly store: string) {
    super(
      `DISJOINTNESS VIOLATION in store "${store}": ${overlap.length} entr${overlap.length === 1 ? "y" : "ies"} ` +
      `collide with the eval registry (${overlap.slice(0, 5).join(", ")}${overlap.length > 5 ? ", ..." : ""}). ` +
      `A store that overlaps the eval set turns every point it earns into benchmaxxing — refusing to load it.`
    );
    this.name = "DisjointnessError";
  }
}

/**
 * Canonicalise any task identifier (an SWE-bench instance id, a TB2 task name, a local-battery slug,
 * or a free-text goal) to a stable key. Lowercase, strip everything but [a-z0-9], so
 * "astropy__astropy-12345", "astropy/astropy#12345", and "Astropy Astropy 12345" all collapse to the
 * same key and a cosmetic rename cannot smuggle an eval task past the id check.
 */
export function canonicalId(raw: string): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * A content fingerprint over the task TEXT (not its id): the sorted set of length-normalised word
 * shingles, hashed to a compact signature. Two tasks with the same fingerprint are textually
 * identical up to whitespace/case; near-duplicates share most shingles (Jaccard). This catches an
 * eval task re-added under a fresh id — the id check alone would miss it.
 */
export function fingerprint(text: string): Set<string> {
  const words = (text ?? "").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const shingles = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  if (!shingles.size && words.length) shingles.add(words.join(" ")); // very short text: whole thing
  return shingles;
}

/** Jaccard overlap of two fingerprints, in [0,1]. 1.0 = identical shingle sets. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface EvalSet {
  name: string;
  /** Canonical task-ids that belong to this eval set and must never appear in a store. */
  ids: Set<string>;
  /** Fingerprints of the eval task TEXTS, for near-duplicate detection (optional; may be empty). */
  fingerprints: Array<{ id: string; fp: Set<string> }>;
}

/**
 * The registry of everything a store must stay disjoint from. Seeded with the eval sets we can
 * enumerate in-repo (TB2 hard tasks, the local behavioral battery, the held-out proof set); the
 * large SWE-bench-Verified instance-id list is loaded from a manifest via `registerFromManifest`.
 */
export class EvalRegistry {
  private sets = new Map<string, EvalSet>();

  /** Register an eval set by name with its raw task-ids (canonicalised on the way in). */
  register(name: string, rawIds: string[], texts: Record<string, string> = {}): void {
    const ids = new Set<string>();
    const fingerprints: EvalSet["fingerprints"] = [];
    for (const raw of rawIds) {
      const id = canonicalId(raw);
      if (!id) continue;
      ids.add(id);
      const text = texts[raw];
      if (text) fingerprints.push({ id, fp: fingerprint(text) });
    }
    this.sets.set(name, { name, ids, fingerprints });
  }

  /**
   * Load eval ids from a JSON manifest. Accepts either an array of ids/strings, or an object of
   * { id: taskText }. Missing file => no-op (so a box without the SWE-Verified manifest still runs).
   */
  registerFromManifest(name: string, manifestPath: string): boolean {
    if (!existsSync(manifestPath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (Array.isArray(parsed)) {
        this.register(name, parsed.map(String));
      } else if (parsed && typeof parsed === "object") {
        const ids = Object.keys(parsed);
        const texts: Record<string, string> = {};
        for (const k of ids) if (typeof parsed[k] === "string") texts[k] = parsed[k];
        this.register(name, ids, texts);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Is this raw id (any form) a registered eval task? */
  isEvalId(raw: string): boolean {
    const id = canonicalId(raw);
    for (const set of this.sets.values()) if (set.ids.has(id)) return true;
    return false;
  }

  /** Every canonical eval id across all sets. */
  allIds(): Set<string> {
    const out = new Set<string>();
    for (const set of this.sets.values()) for (const id of set.ids) out.add(id);
    return out;
  }

  /** All fingerprints across all sets, for near-dup checks. */
  allFingerprints(): Array<{ id: string; fp: Set<string> }> {
    const out: Array<{ id: string; fp: Set<string> }> = [];
    for (const set of this.sets.values()) out.push(...set.fingerprints);
    return out;
  }

  names(): string[] {
    return [...this.sets.keys()];
  }

  /**
   * HARD-FAIL guarantee: throw DisjointnessError if ANY of `storeIds` is a registered eval id.
   * Call at store load and before admitting any new entry. This is the Law-4 assertion.
   */
  assertDisjoint(storeIds: Iterable<string>, storeName: string): void {
    const overlap: string[] = [];
    for (const raw of storeIds) if (this.isEvalId(raw)) overlap.push(raw);
    if (overlap.length) throw new DisjointnessError(overlap, storeName);
  }

  /**
   * Refuse to admit a single entry that is an eval task (by id) OR a near-duplicate of one (by
   * fingerprint, when text is supplied). Returns nothing on success; throws on an id collision.
   * Near-duplicates are returned as a soft reason (caller decides) unless `hardNearDup` is set.
   */
  guardAdmit(rawId: string, text?: string, opts: { nearDupThreshold?: number; hardNearDup?: boolean } = {}): { nearDup?: { id: string; score: number } } {
    if (this.isEvalId(rawId)) throw new DisjointnessError([rawId], "admit");
    if (text) {
      const near = this.nearestEval(text);
      const thresh = opts.nearDupThreshold ?? 0.85;
      if (near && near.score >= thresh) {
        if (opts.hardNearDup) throw new DisjointnessError([`${rawId}~${near.id}(${near.score.toFixed(2)})`], "admit");
        return { nearDup: near };
      }
    }
    return {};
  }

  /** The most similar eval task to `text` by fingerprint Jaccard, or null if none registered. */
  nearestEval(text: string): { id: string; score: number } | null {
    const fp = fingerprint(text);
    let best: { id: string; score: number } | null = null;
    for (const { id, fp: efp } of this.allFingerprints()) {
      const score = jaccard(fp, efp);
      if (!best || score > best.score) best = { id, score };
    }
    return best;
  }
}

// The eval sets we can enumerate directly in-repo. The TB2 hard-task list and the local behavioral
// battery are fixed; the held-out proof set (D2) registers itself when curated. SWE-bench-Verified's
// full instance list is large and loaded from a manifest at runtime (registerFromManifest).
export const TB2_HARD_TASKS = [
  "schemelike-metacircular-eval", "make-mips-interpreter", "write-compressor", "build-cython-ext",
  "sqlite-with-gcov", "polyglot-c-py", "polyglot-rust-c", "gpt2-codegolf", "regex-chess",
  "chess-best-move", "fix-ocaml-gc", "count-dataset-tokens", "sanitize-git-repo", "largest-eigenval",
  "distribution-search", "crack-7z-hash", "constraints-scheduling", "extract-elf",
  "nginx-request-logging", "configure-git-webserver"
];

export const LOCAL_BATTERY_TASKS = [
  "cron", "expr", "glob", "intervals", "json_query", "ledger", "maze", "regexlite", "topo", "vm"
];

/** Build the default registry seeded with the in-repo eval sets. A SWE-Verified manifest, if present
 *  at the given path, is loaded too. This is the registry every store must be disjoint from. */
export function defaultRegistry(sweManifestPath?: string): EvalRegistry {
  const reg = new EvalRegistry();
  reg.register("tb2-hard", TB2_HARD_TASKS);
  reg.register("local-battery", LOCAL_BATTERY_TASKS);
  if (sweManifestPath) reg.registerFromManifest("swe-verified", sweManifestPath);
  return reg;
}
