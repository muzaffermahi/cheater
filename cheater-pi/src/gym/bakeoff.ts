// Bakeoff: run the local battery vanilla-vs-kitten and print a shareable scorecard.
//
// The gym already runs a task (runTask), scores it (scoreRun), and reports it. The bakeoff wires
// those into the head-to-head the product is really about: the SAME tasks under vanilla Pi and under
// the Kitten Code harness, side by side, with pass/fail + wall-clock + tool-call counts. The scorecard
// is deterministic and pure (formatBakeoffScorecard) so it is unit-testable without a model; the
// actual runs need the user's local model (LM Studio), which is why the command drives it on demand.

import { runTask, type RunHooks } from "./runner.js";
import { scoreRun } from "./scorer.js";
import type { GymRunResult, GymScored, GymTask } from "./types.js";

export type ScoredResult = GymRunResult & { score: GymScored };

export interface BakeoffPair {
  task: GymTask;
  vanilla: ScoredResult | null;
  kitten: ScoredResult | null;
}

export interface BakeoffRow {
  taskId: string;
  title: string;
  vanillaPass: boolean | null;
  kittenPass: boolean | null;
  vanillaMs: number | null;
  kittenMs: number | null;
  /** Tool/command calls as a "turns" proxy. */
  vanillaTools: number | null;
  kittenTools: number | null;
}

export interface BakeoffScorecard {
  model: string | null;
  rows: BakeoffRow[];
  totals: {
    tasks: number;
    vanillaPassed: number;
    kittenPassed: number;
    vanillaMsTotal: number;
    kittenMsTotal: number;
    /** Tasks kitten passed that vanilla did not - the headline win count. */
    kittenOnlyWins: number;
    /** Tasks vanilla passed that kitten did not - honest regressions. */
    vanillaOnlyWins: number;
  };
}

function rowOf(pair: BakeoffPair): BakeoffRow {
  return {
    taskId: pair.task.id,
    title: pair.task.title,
    vanillaPass: pair.vanilla ? pair.vanilla.score.pass : null,
    kittenPass: pair.kitten ? pair.kitten.score.pass : null,
    vanillaMs: pair.vanilla ? pair.vanilla.durationMs : null,
    kittenMs: pair.kitten ? pair.kitten.durationMs : null,
    vanillaTools: pair.vanilla ? pair.vanilla.commandsRun.length : null,
    kittenTools: pair.kitten ? pair.kitten.commandsRun.length : null
  };
}

/** Aggregate a set of vanilla/kitten pairs into a scorecard. Pure and deterministic. */
export function buildBakeoffScorecard(pairs: BakeoffPair[], model: string | null = null): BakeoffScorecard {
  const rows = pairs.map(rowOf);
  const totals = {
    tasks: rows.length,
    vanillaPassed: rows.filter((r) => r.vanillaPass === true).length,
    kittenPassed: rows.filter((r) => r.kittenPass === true).length,
    vanillaMsTotal: rows.reduce((sum, r) => sum + (r.vanillaMs ?? 0), 0),
    kittenMsTotal: rows.reduce((sum, r) => sum + (r.kittenMs ?? 0), 0),
    kittenOnlyWins: rows.filter((r) => r.kittenPass === true && r.vanillaPass !== true).length,
    vanillaOnlyWins: rows.filter((r) => r.vanillaPass === true && r.kittenPass !== true).length
  };
  return { model, rows, totals };
}

function mark(pass: boolean | null): string {
  return pass === null ? " -- " : pass ? "PASS" : "FAIL";
}
function secs(ms: number | null): string {
  return ms === null ? "--" : `${(ms / 1000).toFixed(1)}s`;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

/** A shareable, plain-text scorecard. Deterministic given the same inputs. */
export function formatBakeoffScorecard(card: BakeoffScorecard): string {
  const lines: string[] = [];
  lines.push(`Kitten Code bakeoff — vanilla Pi vs Kitten Code${card.model ? ` (${card.model})` : ""}`);
  lines.push("");
  lines.push(`${pad("task", 28)} ${pad("vanilla", 9)} ${pad("kitten", 9)} ${pad("v-time", 8)} ${pad("k-time", 8)}`);
  lines.push("-".repeat(66));
  for (const r of card.rows) {
    lines.push(`${pad(r.taskId, 28)} ${pad(mark(r.vanillaPass), 9)} ${pad(mark(r.kittenPass), 9)} ${pad(secs(r.vanillaMs), 8)} ${pad(secs(r.kittenMs), 8)}`);
  }
  lines.push("-".repeat(66));
  const t = card.totals;
  lines.push(`totals: vanilla ${t.vanillaPassed}/${t.tasks}, kitten ${t.kittenPassed}/${t.tasks}`);
  lines.push(`kitten-only wins: ${t.kittenOnlyWins}   vanilla-only wins: ${t.vanillaOnlyWins}`);
  lines.push(`wall-clock: vanilla ${secs(t.vanillaMsTotal)}, kitten ${secs(t.kittenMsTotal)}`);
  return lines.join("\n");
}

export interface RunBakeoffOptions {
  rootDir: string;
  tasks: GymTask[];
  /** Hooks that actually run the agent in each mode (real: drive the session; test: deterministic). */
  vanillaHooks: RunHooks;
  kittenHooks: RunHooks;
  keepWorkspaces?: boolean;
  runFullTests?: "never" | "if_cheap" | "always";
}

/**
 * Run a suite of tasks under BOTH modes and score each, returning the paired results. Each task is
 * run vanilla then kitten in fresh workspaces (runTask isolates each), so the two modes never share
 * state. A mode that throws for one task leaves that side null (the scorecard shows "--"), so one bad
 * run never sinks the whole bakeoff.
 */
export async function runBakeoffSuite(opts: RunBakeoffOptions): Promise<BakeoffPair[]> {
  const pairs: BakeoffPair[] = [];
  for (const task of opts.tasks) {
    const runSide = async (mode: "vanilla" | "cheater", hooks: RunHooks): Promise<ScoredResult | null> => {
      try {
        const report = await runTask({ rootDir: opts.rootDir, task, mode, hooks, keepWorkspaces: opts.keepWorkspaces, runFullTests: opts.runFullTests });
        return { ...report.result, score: scoreRun({ task, result: report.result }) };
      } catch {
        return null;
      }
    };
    const vanilla = await runSide("vanilla", opts.vanillaHooks);
    const kitten = await runSide("cheater", opts.kittenHooks);
    pairs.push({ task, vanilla, kitten });
  }
  return pairs;
}
