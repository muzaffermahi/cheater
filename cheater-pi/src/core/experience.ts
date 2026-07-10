// Kitten Ascent A3 — experience memory: RAG over the harness's OWN verified solves. The kitten
// remembers the last time it fixed a bug exactly like this — from its past jobs, not from an answer
// sheet. This raises the ceiling on tasks the raw 35B can't one-shot: it learns from its verified
// history, which is exactly what real-world use accumulates.
//
// The old experience/cheatSheet/apiOracle layer was DELETED in the prod-cleanup pass for being
// unprincipled. The three principles that make this version admissible (Design Laws 3, 4, 6):
//   - Disjoint by construction and by ASSERTION: the store is built only from a corpus disjoint from
//     every eval (SWE-Gym train, scraped GitHub issues, the user's own past kitten runs). Load-time and
//     admit-time both HARD-FAIL (throw) on any eval-id overlap via the disjointness firewall.
//   - Only verifier-CONFIRMED solves are admitted (real tests green) — never a self-reported "done".
//   - We inject the APPROACH SHAPE (family, files touched, kind of change), never the verbatim diff —
//     a prior on how to attack the class of problem, capped in size, not a solution to copy.
//
// Retrieval is by embedding similarity to the PROBLEM (nomic), with a fingerprint-Jaccard fallback so
// it still works with the embed model offline. Nothing here throws into a run except the disjointness
// assertion, which is meant to be fatal.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KittenLLM } from "./llm.js";
import { EvalRegistry, fingerprint, jaccard } from "./disjointness.js";

export interface ExperienceEntry {
  /** The disjoint-corpus task id. MUST NOT be an eval id (asserted). */
  id: string;
  taskText: string;
  /** Task-family tag (shares the A4 classifier vocabulary). */
  family: string;
  /** Approach SHAPE only — no verbatim solution code. */
  approachShape: string;
  filesTouched: string[];
  /** The test whose passing confirmed the solve (name/path) — evidence of a real solve. */
  winningTest?: string;
  /** Cached task embedding (nomic). Absent => retrieval falls back to fingerprint Jaccard. */
  embedding?: number[];
  solvedAt?: string;
  /** MUST be true: only verifier-confirmed solves are admitted. */
  verified: boolean;
}

export interface Retrieved { entry: ExperienceEntry; score: number; }

/** Cosine similarity of two vectors; 0 if either is empty or a zero vector. */
export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Extract the APPROACH SHAPE from a solved trajectory — the files touched and the KIND of change, not
 * the code. Reads unified-diff headers only (@@ hunks and +++/--- file lines), never the +/- body, so a
 * verbatim solution can't leak into the store. `summary` is the one-line human description of the solve.
 */
export function summarizeApproach(diff: string, summary: string): { shape: string; files: string[] } {
  const files = new Set<string>();
  let hunks = 0;
  for (const line of (diff || "").split(/\r?\n/)) {
    const m = line.match(/^\+\+\+\s+[ab]\/(.+)$/) || line.match(/^diff --git a\/\S+ b\/(.+)$/);
    if (m) { files.add(m[1].trim()); continue; }
    if (/^@@/.test(line)) hunks++;
  }
  const fileList = [...files].filter((f) => f && f !== "/dev/null").slice(0, 6);
  const shape = `${summary ? summary.slice(0, 160) : "fix"} — touched ${fileList.length || "?"} file(s)${hunks ? `, ${hunks} hunk(s)` : ""}`;
  return { shape, files: fileList };
}

export interface ExperienceStoreOpts {
  dir: string;
  registry: EvalRegistry;
  llm?: KittenLLM;
  /** Cap on retrieved primers (bounded contribution — Law 4). */
  topK?: number;
  /** Minimum similarity to retrieve. */
  minScore?: number;
}

export class ExperienceStore {
  private entries: ExperienceEntry[] = [];
  private loaded = false;
  private readonly file: string;

  constructor(private opts: ExperienceStoreOpts) {
    this.file = join(opts.dir, "store.jsonl");
  }

  private topK(): number { return this.opts.topK ?? 3; }
  private minScore(): number { return this.opts.minScore ?? 0.35; }

  /** Load the store from disk and HARD-FAIL on any eval-id overlap (Law-4 leakage check). */
  load(): void {
    this.entries = [];
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { this.entries.push(JSON.parse(line) as ExperienceEntry); } catch { /* skip corrupt */ }
      }
    }
    // The inviolable assertion: no stored id may be an eval task. Throws DisjointnessError if violated.
    this.opts.registry.assertDisjoint(this.entries.map((e) => e.id), "experience");
    this.loaded = true;
  }

  size(): number { if (!this.loaded) this.load(); return this.entries.length; }

  /**
   * Admit a verifier-confirmed solve. Throws DisjointnessError if the id (or near-identical text) is an
   * eval task; throws if the entry is not verified. Embeds the task text if an llm is available.
   */
  async admit(entry: ExperienceEntry): Promise<void> {
    if (!this.loaded) this.load();
    if (!entry.verified) throw new Error("experience: refusing to admit an unverified solve — only real, verifier-confirmed solves belong in the store");
    // Hard id collision throws; a near-dup by text is escalated to a throw here (the store must be clean).
    this.opts.registry.guardAdmit(entry.id, entry.taskText, { hardNearDup: true, nearDupThreshold: 0.9 });

    if (!entry.embedding && this.opts.llm) {
      try { const v = await this.opts.llm.embed([entry.taskText]); if (v[0]?.length) entry.embedding = v[0]; } catch { /* best-effort */ }
    }
    entry.solvedAt = entry.solvedAt ?? new Date().toISOString();
    this.entries.push(entry);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf8");
    } catch { /* persistence best-effort; in-memory store still usable this run */ }
  }

  /**
   * Retrieve the top-k most similar solved trajectories to `taskText`. Embedding cosine when available;
   * fingerprint Jaccard otherwise. Only entries above minScore are returned, capped at topK.
   */
  async retrieve(taskText: string, k = this.topK()): Promise<Retrieved[]> {
    if (!this.loaded) this.load();
    if (!this.entries.length) return [];
    let queryEmbedding: number[] | undefined;
    if (this.opts.llm && this.entries.some((e) => e.embedding?.length)) {
      try { const v = await this.opts.llm.embed([taskText]); queryEmbedding = v[0]; } catch { /* fall back */ }
    }
    const qfp = fingerprint(taskText);
    const scored = this.entries.map((entry) => {
      let score = 0;
      if (queryEmbedding?.length && entry.embedding?.length) score = cosine(queryEmbedding, entry.embedding);
      else score = jaccard(qfp, fingerprint(entry.taskText));
      return { entry, score };
    });
    return scored.filter((s) => s.score >= this.minScore()).sort((a, b) => b.score - a.score).slice(0, k);
  }
}

/**
 * Render retrieved solves into a bounded capsule primer — approach SHAPE only, explicitly "adapt, don't
 * copy". This is the `experiencePrime` injected into the generator's first message.
 */
export function primeFromRetrieved(retrieved: Retrieved[], maxChars = 700): string {
  if (!retrieved.length) return "";
  const lines = ["Similar tasks you've solved before (approach shape only — adapt the SHAPE, do not copy any code):"];
  for (const { entry, score } of retrieved) {
    lines.push(`- [${entry.family}, sim ${score.toFixed(2)}] ${entry.approachShape}${entry.filesTouched.length ? ` (files like: ${entry.filesTouched.slice(0, 4).join(", ")})` : ""}`);
  }
  const text = lines.join("\n");
  return text.length <= maxChars ? text : text.slice(0, maxChars) + " …";
}

/** The union of files touched by retrieved solves — a localization prior for scout (bounded). */
export function localizationPriorFromRetrieved(retrieved: Retrieved[], max = 6): string[] {
  const files: string[] = [];
  for (const { entry } of retrieved) for (const f of entry.filesTouched) if (!files.includes(f)) files.push(f);
  return files.slice(0, max);
}

/** Default store directory (out of the repo's git/eval view). Override via KITTEN_EXPERIENCE_DIR. */
export function defaultExperienceDir(repoRoot: string): string {
  return process.env.KITTEN_EXPERIENCE_DIR || join(repoRoot, ".cheater", "experience");
}
