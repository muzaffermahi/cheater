// Kitten Ascent C1 — the cheap-to-expensive verification cascade. You can't run twenty kittens'
// mice through the expensive taste-test one at a time before dinner; you need a cheap nose to throw
// out the obvious duds first.
//
// At N=50 you cannot execution-verify all 50 (minutes each). So verify in a cascade, each stage cheaper
// than the next, cutting the field before the expensive signal:
//   1. ORM pre-filter (free, CPU, parallel): drop candidates the ORM scores near-zero. 50 → ~10.
//   2. Static gates (near-free): syntax/import check the survivors' changed code files. ~10 → ~6.
//   3. Execution (expensive): full B1/B2 verification only on the ~6 survivors (done by the Verifier).
// This keeps the expensive signal on a handful, not the whole batch. Every stage LOGS what it cut, so a
// silent cap can't masquerade as "verified everything" (a receipts discipline). Never throws.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import type { OrmScorer } from "./orm.js";

export interface CascadeCandidate {
  index: number;
  workspace: string;
  /** Relative code-file paths in the workspace to syntax-check. */
  codeFiles?: string[];
  /** For the ORM pre-filter (compact diff + test output + notes). */
  trajectory?: string;
  finished?: boolean;
}

export interface CascadeStage {
  stage: "orm-prefilter" | "static-gates";
  before: number;
  survived: number[];
  cut: Array<{ index: number; reason: string }>;
}

export interface CascadeResult {
  survivors: number[];     // indices to hand to the (expensive) execution verifier
  stages: CascadeStage[];
  cutBeforeExecution: number;
}

const CODE_EXT = new Set([".py", ".js", ".mjs", ".cjs"]);

/** Cheap standalone syntax check for a single file. Unknown extension / missing tool => "ok" (skip). */
export function syntaxCheckFile(workspace: string, relPath: string): { ok: boolean; diag?: string } {
  const ext = extname(relPath).toLowerCase();
  if (!CODE_EXT.has(ext)) return { ok: true };
  const full = join(workspace, relPath);
  if (!existsSync(full)) return { ok: true };
  const check = ext === ".py" ? { cmd: "python", args: ["-m", "py_compile", full] } : { cmd: "node", args: ["--check", full] };
  try {
    const r = spawnSync(check.cmd, check.args, { encoding: "utf8", timeout: 20000, windowsHide: true });
    if ((r.status ?? 1) !== 0) return { ok: false, diag: ((r.stderr || r.stdout || "").split(/\r?\n/).filter(Boolean).slice(-2).join(" ")).slice(0, 200) };
    return { ok: true };
  } catch {
    return { ok: true }; // checker missing => don't cut on a check we couldn't run
  }
}

export interface CascadeOpts {
  orm?: OrmScorer | null;
  task?: string;
  /** ORM score below this cuts a candidate at stage 1 (default 0.1). */
  ormFloor?: number;
  /** Never cut the field below this many survivors, however aggressive the gates (default 1). */
  minSurvivors?: number;
  /** Injectable syntax checker (defaults to the real one) so tests need no python/node. */
  syntaxCheck?: (workspace: string, relPath: string) => { ok: boolean; diag?: string };
}

/**
 * Run the pre-execution cascade over candidates and return the survivors to execution-verify, plus the
 * per-stage cut log. Conservative: it never cuts the whole field (minSurvivors floor), and it never cuts
 * on a check it couldn't run.
 */
export async function runCascade(candidates: CascadeCandidate[], opts: CascadeOpts = {}): Promise<CascadeResult> {
  const stages: CascadeStage[] = [];
  const check = opts.syntaxCheck ?? syntaxCheckFile;
  const minSurvivors = Math.max(1, opts.minSurvivors ?? 1);
  let pool = [...candidates];

  // Stage 1 — ORM pre-filter (only when an ORM is loaded; otherwise a no-op, B1+B2 carry it).
  if (opts.orm && pool.length > minSurvivors) {
    const floor = opts.ormFloor ?? 0.1;
    const scored: Array<{ c: CascadeCandidate; score: number }> = [];
    for (const c of pool) {
      let score = 0.5;
      try { score = await opts.orm.score(c.trajectory ?? "", opts.task ?? ""); } catch { score = 0.5; }
      scored.push({ c, score });
    }
    const keep = scored.filter((s) => s.score >= floor);
    // Respect the floor of survivors: if too few clear the bar, keep the top-scored ones.
    const survivorsSet = keep.length >= minSurvivors ? keep : scored.sort((a, b) => b.score - a.score).slice(0, minSurvivors);
    const survivedIdx = new Set(survivorsSet.map((s) => s.c.index));
    stages.push({
      stage: "orm-prefilter", before: pool.length,
      survived: pool.filter((c) => survivedIdx.has(c.index)).map((c) => c.index),
      cut: scored.filter((s) => !survivedIdx.has(s.c.index)).map((s) => ({ index: s.c.index, reason: `ORM P(solved)=${s.score.toFixed(2)} < ${floor}` }))
    });
    pool = pool.filter((c) => survivedIdx.has(c.index));
  }

  // Stage 2 — static gates (syntax/import). Cut a candidate with a broken changed file.
  if (pool.length > minSurvivors) {
    const survived: number[] = [];
    const cut: Array<{ index: number; reason: string }> = [];
    for (const c of pool) {
      let broken: string | null = null;
      for (const f of c.codeFiles ?? []) {
        const r = check(c.workspace, f);
        if (!r.ok) { broken = `${f}: ${r.diag ?? "syntax error"}`; break; }
      }
      if (broken && pool.length - cut.length > minSurvivors) cut.push({ index: c.index, reason: broken });
      else survived.push(c.index);
    }
    stages.push({ stage: "static-gates", before: pool.length, survived, cut });
    const survivedSet = new Set(survived);
    pool = pool.filter((c) => survivedSet.has(c.index));
  }

  return { survivors: pool.map((c) => c.index), stages, cutBeforeExecution: candidates.length - pool.length };
}

/** Render cascade receipts — what each stage cut (no silent truncation; Law of receipts). */
export function cascadeReceiptLines(result: CascadeResult): string[] {
  const lines = [`cascade: ${result.survivors.length} survivor(s) to execution-verify (cut ${result.cutBeforeExecution} cheaply)`];
  for (const s of result.stages) {
    if (s.cut.length) lines.push(`  ${s.stage}: ${s.before}→${s.survived.length}, cut ${s.cut.map((c) => `#${c.index}(${c.reason})`).join(", ")}`.slice(0, 300));
  }
  return lines;
}
