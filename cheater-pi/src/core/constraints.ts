// Kitten Inference P2 — decode-time constraint enforcement. Some tasks FORBID a construct and the hidden
// oracle source-scans + rejects a solution that uses it *before* running any behavior test (confirmed:
// regexlite→`re`/`regex`, expr→`eval`/`exec`/`compile`/`__import__`, glob→`fnmatch`/`re`). Prompting
// ("do not use re") leaks — a weak model reaches for the obvious shortcut anyway. Owning the engine lets
// kitten make it IMPOSSIBLE: ban those tokens at decode via `logit_bias` (a hard `-100`/`false`), so the
// model literally cannot emit `import re`. Pi/opencode can't do this at all.
//
// Two layers, both shipped:
//   1. Decode-time ban (logit_bias) — needs the tokenizer (`/tokenize`, native llama.cpp). The flagship.
//   2. Finish-gate source scan — engine-agnostic fallback (works on cloud/LM Studio and catches the
//      multi-token identifiers a naive single-token ban leaks): reject "done" + repair if the solution
//      uses a banned construct. Mirrors the worked-example gate.
//
// Bans are derived ONLY from what the task actually states ("Do NOT use `re`…", contract.forbidden) plus
// the constructs named in those clauses — never an inferred/unstated constraint (kitten can't be asked to
// obey a rule the prompt never gives).

import type { AcceptanceContract } from "../runstate/contract.js";
import type { KittenLLM } from "./llm.js";

// The stdlib modules/builtins a task might forbid (used to recognise names inside a prohibition clause).
const KNOWN_FORBIDDABLE = ["re", "regex", "fnmatch", "eval", "exec", "compile", "__import__", "os", "sys", "subprocess", "ast", "importlib", "glob"];

/** Derive the set of forbidden module/builtin names from the task's stated prohibitions. */
export function deriveBans(contract: AcceptanceContract, task: string): string[] {
  const bans = new Set<string>();
  const clauses = contract.forbidden ?? [];
  for (const clause of clauses) {
    const lc = clause.toLowerCase();
    for (const name of KNOWN_FORBIDDABLE) {
      // Match the name as a backticked token or a word-boundaried mention inside the prohibition clause.
      if (new RegExp(`\`${name}\`|\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lc)) bans.add(name);
    }
  }
  return [...bans];
}

/** Regexes that recognise a banned construct in python source (mirrors the oracle scans). */
function banPatterns(bans: string[]): RegExp[] {
  const pats: RegExp[] = [];
  for (const b of bans) {
    if (b === "eval" || b === "exec" || b === "compile" || b === "__import__") {
      pats.push(new RegExp(`(?<![\\w.])${b}\\s*\\(`)); // eval( as a bare call
    } else {
      const e = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pats.push(new RegExp(`^\\s*(?:import|from)\\s+${e}\\b`, "m"));         // import re / from re import
      pats.push(new RegExp(`import_module\\(\\s*['"]${e}['"]`));             // importlib.import_module("re")
      pats.push(new RegExp(`__import__\\(\\s*['"]${e}['"]`));
    }
  }
  return pats;
}

/** Scan python source for a banned construct; returns the first violation string, or null if clean. */
export function forbiddenScan(source: string, bans: string[]): string | null {
  if (!bans.length) return null;
  for (const re of banPatterns(bans)) {
    const m = re.exec(source || "");
    if (m) return m[0].trim();
  }
  return null;
}

/** Render the repair feedback when a candidate uses a banned construct. */
export function renderBanViolation(violation: string, bans: string[]): string {
  return `Your solution uses \`${violation}\`, but the task FORBIDS ${bans.map((b) => `\`${b}\``).join("/")} — a solution that uses it is rejected outright, even if its behavior is correct. Implement the logic yourself and remove it before finishing.`;
}

/**
 * Build a `logit_bias` map (token-id → -100 hard ban) for the banned constructs, using the engine's
 * tokenizer. Returns {} on a non-native engine (no /tokenize) — the finish-gate scan then carries it.
 * Bans the leading tokens of the tell-tale strings (`import re`, ` re`, `re.`, `eval`, ` eval`).
 */
export async function logitBiasForBans(llm: KittenLLM, bans: string[]): Promise<Record<number, number>> {
  if (!bans.length) return {};
  const bias: Record<number, number> = {};
  const strings: string[] = [];
  for (const b of bans) {
    if (["eval", "exec", "compile", "__import__"].includes(b)) strings.push(b, ` ${b}`, `\t${b}`);
    else strings.push(`import ${b}`, `from ${b}`, ` ${b}`, `${b}.`);
  }
  for (const s of strings) {
    const ids = await llm.tokenize(s);
    if (ids.length) bias[ids[0]] = -100; // ban the LEADING token (subword-safe enough; scan covers the rest)
  }
  return bias;
}

/** One-shot: derive bans + build the decode ban (native) for a task. Empty when nothing is forbidden. */
export async function buildBanDecode(llm: KittenLLM, contract: AcceptanceContract, task: string): Promise<{ bans: string[]; logitBias: Record<number, number> }> {
  const bans = deriveBans(contract, task);
  const logitBias = await logitBiasForBans(llm, bans);
  return { bans, logitBias };
}
