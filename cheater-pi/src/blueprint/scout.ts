// Deterministic scouting: briefing packets instead of agentic wandering.
//
// Workers explore with read/grep tools, and each exploration turn is ~30-60s at ~25 tok/s while a
// small model searches badly. The capsule already has the right slot - relevantFiles: FileBrief[],
// "pre-sliced upstream" - so this module builds that upstream deterministically: it takes the
// acceptance-contract nouns (files, symbols) plus the commitlet's target files, finds where each is
// defined/referenced with a bounded workspace scan, slices the enclosing function (never mid-block),
// follows one hop of relative imports, and returns ranked, byte-budgeted FileBriefs. The worker keeps
// its read/grep tools as a fallback - scouting reduces the need to wander, it never removes the ability.
//
// Rank order (highest first): contract/target file exact match > symbol definition > symbol reference
// > import neighbor. When a symbol has two strong definition sites the brief carries BOTH and the
// caller adds one line asking the worker to state which it used - selection, not exploration.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FileBrief } from "../runstate/promptCapsule.js";
import { relevantSymbolSlice } from "../reliability/symbolSlice.js";

export interface ScoutInput {
  cwd: string;
  /** Symbol names from the contract (function/class/interface names). */
  symbols: string[];
  /** Contract files + the commitlet's target files - direct, highest-rank hits. */
  files: string[];
  /** Extra slice terms (commitlet title, acceptance criteria) to pick the right function. */
  terms?: string[];
  /** deep = symbol search + one import hop; shallow = contract/target files only (easy lane). */
  depth: "shallow" | "deep";
  /** Paths the caller already briefed (the executor's own sliced target files) - never duplicated. */
  excludePaths?: string[];
  maxBriefs?: number;
  /** Total snippet byte budget; lowest-rank whole briefs are dropped first when exceeded. */
  byteBudget?: number;
}

export interface ScoutOutcome {
  briefs: FileBrief[];
  /** Symbols found defined in more than one file - the worker is asked to state which it used. */
  ambiguous: string[];
}

interface Hit {
  path: string;
  rank: number;
  reason: string;
}

const WALK_SKIP = new Set([".git", "node_modules", ".cheater", ".pisession", "dist", "build", ".next", "out", "coverage", ".vite", "__pycache__", ".venv", "venv", ".pytest_cache", "target", "vendor"]);
const CODE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|rb|c|cc|cpp|h|hpp|php|swift|kt|scala|vue|svelte)$/i;
const JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

const RANK_FILE = 100;
const RANK_DEF = 70;
const RANK_REF = 40;
const RANK_IMPORT = 20;

function norm(path: string): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Bounded list of workspace code files, repo-relative with forward slashes. */
function walkCodeFiles(cwd: string, cap = 2500): string[] {
  const out: string[] = [];
  const root = resolve(cwd);
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= cap) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= cap) return;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) walk(join(dir, entry.name), depth + 1);
      } else if (CODE_EXT.test(entry.name)) {
        out.push(join(dir, entry.name).slice(root.length + 1).replace(/\\/g, "/"));
      }
    }
  };
  walk(root, 0);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `content` DECLARES symbol `sym` (function/class/def/const/interface/type/enum/assignment). */
export function declaresSymbol(content: string, sym: string): boolean {
  const s = escapeRe(sym);
  return [
    new RegExp(`\\b(?:function|class|interface|type|enum)\\s+${s}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${s}\\b`),
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${s}\\b`, "m"),
    new RegExp(`^\\s*class\\s+${s}\\b`, "m"),
    new RegExp(`\\b${s}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`)
  ].some((re) => re.test(content));
}

/** True when `content` merely references (uses) symbol `sym`. */
export function referencesSymbol(content: string, sym: string): boolean {
  return new RegExp(`\\b${escapeRe(sym)}\\b`).test(content);
}

/** Parse relative import specifiers (JS `from "./x"` / require, python `from .x import`). */
export function relativeImportSpecs(content: string): string[] {
  const specs = new Set<string>();
  for (const m of content.matchAll(/(?:import|export)[^"'\n]*?from\s*["'](\.[^"'\n]+)["']/g)) specs.add(m[1]);
  for (const m of content.matchAll(/require\(\s*["'](\.[^"'\n]+)["']\s*\)/g)) specs.add(m[1]);
  return [...specs];
}

/** Resolve a relative JS import spec against the importing file; returns a repo-relative path or null. */
function resolveJsNeighbor(cwd: string, fromRel: string, spec: string): string | null {
  const base = resolve(dirname(join(cwd, fromRel)), spec);
  const candidates = [base];
  if (/\.(m|c)?js$/.test(base)) candidates.push(base.replace(/\.(m|c)?js$/, ".ts"), base.replace(/\.(m|c)?js$/, ".tsx"));
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) candidates.push(`${base}${ext}`);
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) candidates.push(join(base, `index${ext}`));
  const root = resolve(cwd);
  for (const candidate of candidates) {
    if (existsSync(candidate) && candidate.startsWith(root)) return candidate.slice(root.length + 1).replace(/\\/g, "/");
  }
  return null;
}

function readFileSafe(cwd: string, rel: string): string {
  try {
    return readFileSync(join(cwd, rel), "utf8");
  } catch {
    return "";
  }
}

/** Slice the most relevant function/block for the terms, or a labeled head; bounded. */
function briefSnippet(content: string, rel: string, terms: string[]): string {
  const slice = relevantSymbolSlice(content, terms);
  if (slice) return [`--- ${rel} (relevant symbol) ---`, slice, `--- end ${rel} ---`].join("\n");
  const head = content.split(/\r?\n/).slice(0, 30).join("\n").slice(0, 700);
  return head ? [`--- ${rel} (head) ---`, head, `--- end ${rel} ---`].join("\n") : "";
}

/**
 * Build ranked, byte-budgeted FileBriefs from contract nouns + target files. Deterministic and
 * bounded; never throws (returns whatever it assembled). The caller merges these into the capsule's
 * relevantFiles as the deterministic floor beneath any sidecar reranking.
 */
export function scout(input: ScoutInput): ScoutOutcome {
  const cwd = input.cwd;
  const maxBriefs = input.maxBriefs ?? 5;
  const byteBudget = input.byteBudget ?? 4000;
  const exclude = new Set((input.excludePaths ?? []).map(norm));
  const symbols = [...new Set((input.symbols ?? []).filter((s) => s && s.length >= 3))];
  const terms = [...new Set([...(input.terms ?? []), ...symbols])].filter(Boolean);
  const hits = new Map<string, Hit>();
  const record = (path: string, rank: number, reason: string): void => {
    const p = norm(path);
    if (!p || exclude.has(p)) return;
    const prev = hits.get(p);
    if (!prev || rank > prev.rank) hits.set(p, { path: p, rank, reason });
  };

  try {
    // 1. Direct contract/target file hits (highest rank), if they exist on disk.
    for (const file of input.files ?? []) {
      const p = norm(file);
      if (p && !p.endsWith("/") && !p.startsWith("(") && existsSync(join(cwd, p))) record(p, RANK_FILE, "named in the task / commitlet target");
    }

    // 2. Shallow lane stops here (contract/target files only) - the easy lane stays lean.
    // 3. Deep lane: symbol definition/reference search + one import hop.
    const ambiguous: string[] = [];
    if (input.depth === "deep" && symbols.length) {
      const defSites = new Map<string, string[]>();
      const files = walkCodeFiles(cwd);
      for (const rel of files) {
        if (exclude.has(rel)) continue;
        const content = readFileSafe(cwd, rel);
        if (!content) continue;
        for (const sym of symbols) {
          if (!referencesSymbol(content, sym)) continue;
          if (declaresSymbol(content, sym)) {
            record(rel, RANK_DEF, `defines ${sym}`);
            const sites = defSites.get(sym) ?? [];
            sites.push(rel);
            defSites.set(sym, sites);
          } else {
            record(rel, RANK_REF, `references ${sym}`);
          }
        }
      }
      for (const [sym, sites] of defSites) if (sites.length > 1) ambiguous.push(sym);

      // 4. One import hop out of the definition sites (JS relative imports only - the common case).
      for (const [path, hit] of [...hits]) {
        if (hit.rank < RANK_DEF || !JS_EXT.test(path)) continue;
        const content = readFileSafe(cwd, path);
        for (const spec of relativeImportSpecs(content)) {
          const neighbor = resolveJsNeighbor(cwd, path, spec);
          if (neighbor) record(neighbor, RANK_IMPORT, `imported by ${path}`);
        }
      }
    }

    // 5. Assemble briefs, highest rank first, under the byte budget + count cap.
    const ranked = [...hits.values()].sort((a, b) => b.rank - a.rank);
    const briefs: FileBrief[] = [];
    let bytes = 0;
    for (const hit of ranked) {
      if (briefs.length >= maxBriefs) break;
      const content = readFileSafe(cwd, hit.path);
      if (!content) continue;
      const snippet = briefSnippet(content, hit.path, terms.length ? terms : [hit.path]);
      if (!snippet) continue;
      if (bytes + snippet.length > byteBudget && briefs.length) break; // keep at least one
      bytes += snippet.length;
      briefs.push({ path: hit.path, reason: hit.reason, snippet });
    }
    return { briefs, ambiguous };
  } catch {
    return { briefs: [...hits.values()].slice(0, maxBriefs).map((h) => ({ path: h.path, reason: h.reason })), ambiguous: [] };
  }
}
