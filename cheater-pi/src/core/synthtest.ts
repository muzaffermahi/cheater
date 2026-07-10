// Kitten Core — sidecar-driven synthetic-test selection (the Tier-B lever, and the sidecar's biggest
// job). Research: for a WEAK model, repeated sampling lifts coverage but the model can't pick the
// winner (Large Language Monkeys); an EXECUTION selector closes the gap (CodeT / Agentless: +6–16pp on
// weak models). We don't trust the 2b sidecar to know the right ANSWER — only to invent discriminating
// INPUTS. Selection is then by execution consensus across the best-of-N attempts: for each probe input,
// the plurality output is treated as correct, and the attempt that agrees most (and crashes least) wins.
//
// This keeps the sidecar genuinely busy on every hard task (generate probes, cheap on CPU, parallel to
// the GPU), and it never lets the sidecar decide — the vote is over real executions of the main model's
// own code. Scope: single-function python tasks (from-scratch or fix). Anything else → null, and the
// caller falls back to the plain "first that verified" selector.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KittenLLM } from "./llm.js";
import type { AcceptanceContract } from "../runstate/contract.js";
import { extractWorkedExamples } from "./workedExamples.js";

/** Parse the positional args of a worked-example call `symbol(a, b, c)` into a JSON tuple [a,b,c], or
 *  null if they aren't JSON-clean. These are REAL valid inputs from the prompt — the only reliable
 *  probe inputs for a complex type the sidecar can't invent (a cron string, a VM program). */
export function argsFromCall(call: string, symbol: string): unknown[] | null {
  if (!call.includes(symbol + "(")) return null;
  const open = call.indexOf("(");
  const close = call.lastIndexOf(")");
  if (open < 0 || close <= open) return null;
  const inner = call.slice(open + 1, close).trim();
  if (inner === "") return [];
  try { const parsed = JSON.parse("[" + inner + "]"); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

export interface FnProbe {
  module: string;      // module filename, e.g. "coins.py"
  symbol: string;      // function name, e.g. "min_coins"
  inputs: unknown[][]; // positional-argument tuples, e.g. [[[1,3,4], 6], [[2], 3]]
}

/** One attempt's outcome vector: per probe, either a returned value or a crash (exception name). */
export type ProbeResult = { ok: true; val: unknown } | { ok: false; err: string };
export interface ProbeOutcome { results: ProbeResult[]; }

const PROBE_SCHEMA = {
  name: "probe_cases",
  schema: {
    type: "object",
    properties: {
      cases: {
        type: "array",
        items: { type: "string" } // each item is a JSON array of positional args, e.g. "[[1,3,4], 6]"
      }
    },
    required: ["cases"]
  }
} as const;

/**
 * Identify the single (module.py, function) under test from the contract, then ask the sidecar for a
 * spread of input tuples (normal + edges). Returns null if this isn't a clean single-python-function
 * task, or the sidecar produced nothing usable — the caller then skips consensus entirely.
 */
export async function generateFnProbes(llm: KittenLLM, task: string, contract: AcceptanceContract): Promise<FnProbe | null> {
  const target = pickFnTarget(contract);
  if (!target) return null;
  const { module, symbol } = target;

  // Up to two sidecar passes, accumulating inputs. This (a) survives a cold-start where the first call
  // times out while LM Studio loads the 2b, and (b) reduces variance — one pass sometimes yields only a
  // couple of parseable cases, and consensus wants a solid handful.
  const inputs: unknown[][] = [];
  const seen = new Set<string>();
  // Seed from the prompt's WORKED EXAMPLES first — real, valid inputs (guaranteed parseable). For a task
  // whose input type the sidecar can't invent as valid JSON (cron: a schedule string + ISO datetime),
  // this is the ONLY way consensus gets any inputs at all; elsewhere it anchors the vote on ground truth.
  for (const ex of extractWorkedExamples(task, [symbol])) {
    const args = argsFromCall(ex.call, symbol);
    if (!args) continue;
    const key = JSON.stringify(args);
    if (!seen.has(key)) { seen.add(key); inputs.push(args); }
  }
  // Up to three passes: complex input TYPES (a cron string + datetime, a nested busy-map, a VM program)
  // are hard for the sidecar to emit as valid JSON tuples, so one pass often yields <2 parseable cases
  // and consensus silently switches off. Extra passes recover the flaky ones (intervals flipped OK→NULL
  // across runs) at the cost of a couple of cheap sidecar calls only when the earlier passes fell short.
  // If the prompt gave real inputs, show them to the sidecar as VALID TEMPLATES to VARY. Inventing a
  // well-formed cron string / VM program from scratch is where the sidecar fails; mutating a known-good
  // one (change the schedule fields, shift the date, bump the count) is easy and yields valid inputs.
  const templates = inputs.slice(0, 3).map((a) => JSON.stringify(a));
  const templateHint = templates.length
    ? `\nHere are VALID example inputs — produce MORE like these, VARYING the values to hit edges (keep the exact shape/types):\n${templates.map((t) => `  ${t}`).join("\n")}\n`
    : "";
  for (let pass = 0; pass < 3 && inputs.length < 6; pass++) {
    let content = "";
    try {
      const r = await llm.sidecar({
        messages: [{
          role: "user",
          content:
            `A python function \`${symbol}\` (in ${module}) must satisfy this task:\n"""${task.slice(0, 900)}"""\n${templateHint}\n` +
            `Produce 8 test INPUTS that together cover the normal case AND the tricky edges (empty, single, ` +
            `zero, boundary, ordering, the specific traps the task warns about). Do NOT provide expected ` +
            `outputs — inputs only. Each case is a JSON array of the positional arguments to ${symbol}. ` +
            `Example shape for two args: "[[1,3,4], 6]". Return the JSON object with "cases".`
        }],
        jsonSchema: PROBE_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
        maxTokens: 700,
        timeoutMs: 90000
      });
      if (r.ok) content = r.content.trim();
    } catch { /* transient — try the next pass */ }
    if (!content) continue;
    let cases: unknown;
    try { cases = (JSON.parse(content) as { cases?: unknown }).cases; } catch { continue; }
    if (!Array.isArray(cases)) continue;
    for (const c of cases) {
      if (typeof c !== "string") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(c); } catch { continue; }
      if (!Array.isArray(parsed)) continue; // must be a positional-arg tuple
      const key = JSON.stringify(parsed);
      if (seen.has(key)) continue;
      seen.add(key);
      inputs.push(parsed);
      if (inputs.length >= 12) break;
    }
  }
  if (inputs.length < 2) return null; // need at least a couple to discriminate
  return { module, symbol, inputs };
}

/** Choose exactly one (python module, function symbol) to probe, or null if ambiguous/not applicable. */
export function pickFnTarget(contract: AcceptanceContract): { module: string; symbol: string } | null {
  const py = contract.files.filter((f) => f.toLowerCase().endsWith(".py"));
  if (!py.length) return null;
  // One module ⇒ obvious. If contract extraction pulled a SPURIOUS second module (e.g. an example
  // filename `x.py` next to the real `solution.py` — which sank glob's consensus), fall back to the
  // conventional entry module rather than bailing. Only give up if there's genuinely no primary.
  let module: string | null;
  if (py.length === 1) module = py[0];
  else module = py.find((f) => /(^|[/\\])(solution|main|impl|answer)\.py$/i.test(f)) ?? null;
  if (!module) return null;
  if (!contract.symbols.length) return null; // need a named function
  // Prefer a symbol that reads like a function (snake_case or lower_first), not a Class.
  const fn = contract.symbols.find((s) => /^[a-z][A-Za-z0-9_]*$/.test(s)) ?? null;
  if (!fn) return null; // Capitalized-only symbols => class task; consensus-by-call doesn't fit
  return { module, symbol: fn };
}

const RUNNER = `
import json, sys, importlib.util
cwd, module, symbol, inputs_json = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
sys.path.insert(0, cwd)
out = []
try:
    spec = importlib.util.spec_from_file_location("_probe_mod", module if module.startswith(cwd) else (cwd + "/" + module))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    fn = getattr(m, symbol)
    for args in json.loads(inputs_json):
        try:
            v = fn(*args)
            json.dumps(v)  # ensure serializable; non-serializable -> stringify
            out.append({"ok": True, "val": v})
        except TypeError:
            try: out.append({"ok": True, "val": str(fn(*args))})
            except Exception as e: out.append({"ok": False, "err": type(e).__name__})
        except Exception as e:
            out.append({"ok": False, "err": type(e).__name__})
except Exception as e:
    print(json.dumps({"loaderror": type(e).__name__ + ": " + str(e)[:120]})); sys.exit(0)
print(json.dumps({"results": out}))
`;

/**
 * Execute the probed function on every input inside `cwd` (an attempt's produced workspace). Runs in an
 * isolated python process; a load error or timeout yields null (no signal for this attempt). Never
 * throws.
 */
export function runFnProbes(cwd: string, probe: FnProbe): ProbeOutcome | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "kitten-probe-"));
    const runner = join(dir, "_runner.py");
    writeFileSync(runner, RUNNER);
    const r = spawnSync("python", [runner, cwd, probe.module, probe.symbol, JSON.stringify(probe.inputs)], {
      encoding: "utf8", timeout: 30000, windowsHide: true
    });
    if (r.status !== 0 || !r.stdout) return null;
    const obj = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || "{}");
    if (obj.loaderror || !Array.isArray(obj.results)) return null;
    return { results: obj.results as ProbeResult[] };
  } catch {
    return null;
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

/** Canonical key for an output value so 7 and 7.0 agree, floats compare with tolerance. */
function canon(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : String(v);
  return JSON.stringify(v);
}

export interface ConsensusPick {
  index: number;             // winning attempt index
  scores: number[];          // agreement score per attempt
  crashes: number[];         // crash count per attempt
  discriminating: boolean;   // did the probes actually separate the attempts?
}

/**
 * Pick the attempt that best matches the per-probe plurality output and crashes least. Requires ≥2
 * attempts with a usable outcome; returns null otherwise (caller keeps its default selection). The
 * plurality is computed only over non-crashing results, so a value all attempts agree on wins, and an
 * attempt that crashes where others succeed is penalised.
 */
export function selectByConsensus(outcomes: (ProbeOutcome | null)[]): ConsensusPick | null {
  const usable = outcomes.map((o, i) => ({ o, i })).filter((x) => x.o && x.o.results.length);
  if (usable.length < 2) return null;
  const nProbes = Math.max(...usable.map((x) => x.o!.results.length));
  const scores = outcomes.map(() => 0);
  const crashes = outcomes.map(() => 0);
  let discriminating = false;

  for (let j = 0; j < nProbes; j++) {
    // Tally plurality over the UNIFIED outcome at probe j: a returned value ("v:…") OR a raised
    // exception type ("e:…"). Raising is a legitimate outcome candidates can AGREE on — for a task
    // whose contract says "raise ValueError on a malformed input", every correct candidate raises there,
    // and that agreement must SCORE, not be scored as everyone crashing (which wrongly sank correct
    // exception-raisers like json_query and made them execution-ineligible in the verifier fold).
    const key = (res: ProbeResult | undefined): string | null => res ? (res.ok ? "v:" + canon(res.val) : "e:" + res.err) : null;
    const tally = new Map<string, number>();
    for (const { o } of usable) { const k = key(o!.results[j]); if (k !== null) tally.set(k, (tally.get(k) ?? 0) + 1); }
    let bestKey: string | null = null, bestN = 0, distinct = 0;
    for (const [k, n] of tally) { distinct++; if (n > bestN) { bestN = n; bestKey = k; } }
    if (distinct > 1) discriminating = true;
    const pluralityIsValue = bestKey !== null && bestKey.startsWith("v:");
    for (const { o, i } of usable) {
      const res = o!.results[j];
      if (!res) continue;
      if (key(res) === bestKey) scores[i]++;                 // matches the plurality outcome (value OR exception)
      else if (!res.ok && pluralityIsValue) crashes[i]++;    // broke where the consensus SUCCEEDED → a real bug signal
    }
  }

  // Winner = highest agreement, then fewest crashes, then earliest attempt (lower temperature).
  let best = -1;
  for (const { i } of usable) {
    if (best < 0) { best = i; continue; }
    const better = scores[i] - crashes[i] * 0.5 > scores[best] - crashes[best] * 0.5
      || (scores[i] - crashes[i] * 0.5 === scores[best] - crashes[best] * 0.5 && crashes[i] < crashes[best]);
    if (better) best = i;
  }
  return { index: best, scores, crashes, discriminating };
}

/** Does an outcome show a clean pass (no crash on any probe)? Used for the attempt-1 fast path. */
export function isCleanOutcome(o: ProbeOutcome | null): boolean {
  return !!o && o.results.length > 0 && o.results.every((r) => r.ok);
}
