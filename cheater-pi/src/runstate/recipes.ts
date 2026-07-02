// Exact-artifact validation recipe: deterministic, loop-free, harness-side.
//
// The one CodeMode-lite recipe that earned its keep: before the finish gate judges, it
// rereads the exact artifacts the acceptance contract names, the way an evaluator would
// (JSON must parse, CSV headers must match contract columns, empty files fail), and records
// each result as typed exact_artifact validation evidence. Bounded actions, no writes,
// digest-compressed output, never exposed as a tool.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskRunState } from "./runState.js";
import { appendRunEvent } from "./runDir.js";
import type { AcceptanceContract } from "./contract.js";

export interface RecipeResult {
  ok: boolean;
  /** Compressed human-readable outcome - the only thing that may enter context. */
  digest: string;
  actions: number;
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap - 12) + "\n[clipped]";
}

function recipeEvent(run: TaskRunState | null, name: string, result: RecipeResult): RecipeResult {
  if (run) appendRunEvent(run.runDir, "recipe_run", { name, ok: result.ok, actions: result.actions });
  return result;
}

/** Expected CSV header columns stated by the contract, if any. */
export function expectedCsvColumns(contract: AcceptanceContract): string[] {
  for (const fact of contract.outputFormat) {
    const match = fact.match(/columns?\s*:?\s+([A-Za-z0-9_,\s`"'-]+)/i);
    if (!match) continue;
    const cols = match[1].split(",").map((col) => col.trim().replace(/[`"'.]|and\s+/g, "")).filter((col) => /^[A-Za-z0-9_-]+$/.test(col));
    if (cols.length >= 2) return cols;
  }
  return [];
}

/**
 * Re-read the exact artifacts the contract names, from disk, the way an evaluator would:
 * exists -> parse (JSON) / header check (CSV) -> record a typed exact_artifact validation.
 * File existence alone never passes for a parseable artifact.
 */
export function artifactReread(run: TaskRunState, params: { maxOutputChars?: number } = {}): RecipeResult {
  const cap = params.maxOutputChars ?? 1200;
  const targets = [...new Set([...run.contract.outputPaths])].slice(0, 5);
  if (!targets.length) {
    return recipeEvent(run, "artifact_reread", { ok: true, digest: "contract names no output artifacts", actions: 0 });
  }
  const lines: string[] = [];
  let allOk = true;
  let actions = 0;
  for (const target of targets) {
    actions += 1;
    const abs = resolve(run.repoRoot, target);
    let status: "pass" | "fail" = "pass";
    let detail = "";
    if (!existsSync(abs)) {
      status = "fail";
      detail = "missing";
    } else {
      try {
        const content = readFileSync(abs, "utf8");
        if (/\.json[l]?$/i.test(target)) {
          try {
            if (/\.jsonl$/i.test(target)) content.split(/\r?\n/).filter(Boolean).slice(0, 50).forEach((line) => JSON.parse(line));
            else JSON.parse(content);
            detail = `valid JSON (${content.length} chars)`;
          } catch (err) {
            status = "fail";
            detail = `exists but is NOT valid JSON: ${(err as Error).message.slice(0, 80)}`;
          }
        } else if (/\.(csv|tsv)$/i.test(target)) {
          const expected = expectedCsvColumns(run.contract);
          const header = (content.split(/\r?\n/)[0] ?? "").split(/[,\t]/).map((col) => col.trim());
          if (expected.length) {
            const missing = expected.filter((col) => !header.includes(col));
            if (missing.length) {
              status = "fail";
              detail = `header ${header.join(",")} is missing contract column(s): ${missing.join(", ")}`;
            } else {
              detail = `header matches contract columns (${expected.join(", ")})`;
            }
          } else {
            detail = content.trim() ? `non-empty, header: ${header.slice(0, 8).join(",")}` : "exists but is EMPTY";
            if (!content.trim()) status = "fail";
          }
        } else {
          detail = content.trim() ? `non-empty (${content.length} chars)` : "exists but is EMPTY";
          if (!content.trim()) status = "fail";
        }
      } catch {
        status = "fail";
        detail = "exists but unreadable";
      }
    }
    if (status === "fail") allOk = false;
    lines.push(`${target}: ${status.toUpperCase()} - ${detail}`);
    run.recordValidation({
      name: `artifact_reread:${target}`,
      command: `reread ${target}`,
      actor: "recipe:artifact_reread",
      validates: [target],
      status,
      outputSummary: detail
    });
  }
  run.refreshDigest();
  return recipeEvent(run, "artifact_reread", { ok: allOk, digest: clip(lines.join("\n"), cap), actions });
}

