// Kitten Core — the reliability wrapper. This is what makes Kitten more than a bare tool loop.
//
// It runs the same standalone agent (agent.ts) but layers the deterministic harness the research says
// helps a WEAK model most, all as code, not prompt-hope:
//   - contract + scout localization: extract the literal acceptance targets and pre-slice the named
//     files/symbols into the FIRST message, so the model does not wander (localization = the dominant
//     lever; Lost-in-the-Middle hurts small models most).
//   - post-edit syntax gate (Tier A2): after every edit/write to a code file, compile-check it; a
//     broken edit is rejected and re-asked IN THE SAME TURN (SWE-agent: the editor-with-linter is the
//     single biggest ACI ablation, and it breaks the edit-the-same-broken-snippet death spiral).
//   - finish gate ("no done without receipts"): the model may not finish until it has actually run a
//     verification (project tests, or — on a held-out task — a check it wrote and ran). A weak model
//     must not grade itself by opinion.
//
// runReliableAgent has the same signature surface as runAgent, so the A/B harness can flip
// raw<->reliable on one flag and measure whether the harness earns its keep.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { runAgent, type AgentRunParams, type AgentRunResult, type FinishGateState } from "./agent.js";
import type { KittenLLM } from "./llm.js";
import type { ToolContext, ToolResult } from "./tools.js";
import { extractAcceptanceContract } from "../runstate/contract.js";
import { loadProjectCommands } from "../reliability/projectCommands.js";
import { symbolSnippet } from "../reliability/symbolSlice.js";
import { failureCard, renderCard } from "./sidecar.js";
import { extractWorkedExamples, extractSetupVars, runExampleTest, renderExampleFailures, type WorkedExample } from "./workedExamples.js";
import { deriveBans, forbiddenScan, renderBanViolation } from "./constraints.js";

export interface ReliableParams {
  task: string;
  cwd: string;
  llm: KittenLLM;
  model?: string;
  maxTurns?: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  onEvent?: AgentRunParams["onEvent"];
  signal?: AbortSignal;
  /** A1 diversity: a stance/plan/repair directive appended to the system prompt for this sample. */
  extraDirective?: string;
  /** A1 diversity: override/reorder which contract files scout slices first (the localization axis). */
  localizationFiles?: string[];
  /** A3 experience: primed approach-shape from similar past solves, injected into the first message. */
  experiencePrime?: string;
  /** P1: capture per-token logprobs → self-certainty (owned-engine selection signal). */
  captureConfidence?: boolean;
  /** P2/P5: owned-inference per-sample decode controls (forbidden-token ban, sampler diversity). */
  decode?: { logitBias?: Record<number, number>; topP?: number; topK?: number; minP?: number; dryMultiplier?: number; grammar?: string };
  /** P2: run the finish-gate forbidden-construct source scan (engine-agnostic fallback for the ban). */
  banForbidden?: boolean;
  /** Iter-1: disable ornith's chain-of-thought for the fast forward pass (auto-re-enabled on repair). */
  disableThinking?: boolean;
  /** Safety/approval hook forwarded to the agent loop (destructive-command gate). */
  commandGate?: AgentRunParams["commandGate"];
  /** Model-facing conversation context (prior turns + repo truth) for multi-turn/resumed runs. */
  contextPreamble?: string;
  /** Stream real token deltas (forwarded to the agent loop). */
  streamDeltas?: boolean;
}

const CODE_EXT = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export async function runReliableAgent(params: ReliableParams): Promise<AgentRunResult & { contractTargets: string[] }> {
  const { cwd, task } = params;
  const contract = extractAcceptanceContract(task);
  const project = loadProjectCommands(cwd);
  const testCmd = project.focusedTestCommand ?? project.testCommand ?? null;

  // Scout: deterministically locate the files the task names (that exist) and slice the relevant
  // symbol out of each, so the first turn already carries the code to change. The A1 localization axis
  // may reorder the candidate list so a different file leads on different samples.
  const terms = [...contract.symbols, ...task.split(/\s+/).filter((w) => w.length > 4)].slice(0, 12);
  const candidateFiles = (params.localizationFiles?.length ? params.localizationFiles : contract.files).slice(0, 4);
  const briefs: string[] = [];
  for (const file of candidateFiles) {
    if (existsSync(join(cwd, file))) {
      const snip = symbolSnippet(cwd, file, terms.length ? terms : [file]);
      if (snip) briefs.push(snip);
    }
  }

  const contractLines: string[] = [];
  if (contract.files.length) contractLines.push(`Files named in the task: ${contract.files.join(", ")}`);
  if (contract.symbols.length) contractLines.push(`Symbols named in the task: ${contract.symbols.join(", ")}`);
  if (contract.commands.length) contractLines.push(`Commands named in the task: ${contract.commands.join(" | ")}`);

  // Worked-example anchor: the task's own I/O examples are GROUND TRUTH (not model-generated → not
  // self-flattering). The finish gate refuses "done" while any fail, and they're stated up front so the
  // model targets them. The single py module the examples call is the target file.
  const pyModule = contract.files.find((f) => f.toLowerCase().endsWith(".py")) ?? null;
  const workedExamples = pyModule ? extractWorkedExamples(task, contract.symbols) : [];
  const setupVars = workedExamples.length ? extractSetupVars(task) : [];
  const examplesLine = workedExamples.length
    ? `\nThe task gives worked examples — these are GROUND TRUTH your code MUST satisfy exactly:\n${workedExamples.slice(0, 6).map((e) => `  ${e.call} == ${e.expected}`).join("\n")}\nAfter writing the code, run these exact calls and confirm each matches before finishing.`
    : "";

  // Keep the upfront prompt LEAN. A verbose "verify the normal case AND every edge (empty, single,
  // boundary, ordering)…" mandate primes a small model to over-explore even trivial tasks (observed:
  // 9 turns diagnosing a one-line dedup fix). The detailed verify guidance lives in the finish gate and
  // is injected ONLY if the model tries to finish without having run a check — lean until it matters.
  const verifyReminder = testCmd
    ? `Before finishing, run the project's tests (\`${testCmd}\`) and see them pass.`
    : `Before finishing, actually run your change once (a quick \`python -c\`/\`node -e\` check) to confirm it works — don't finish on assumption.`;

  const systemPrompt = [
    "You are Kitten, a precise coding agent. You have tools: read, write, edit, bash, ls, grep, finish.",
    "Work in small steps. Read the exact code region before editing. To change an existing file use edit (give enough surrounding original text to be unique); use write only for a new file.",
    contractLines.length ? `\nAcceptance targets (do not rename or approximate these):\n- ${contractLines.join("\n- ")}` : "",
    briefs.length ? `\nRelevant code, already located for you (read more with the read tool if needed):\n${briefs.join("\n")}` : "",
    examplesLine,
    params.experiencePrime ? `\n${params.experiencePrime}` : "",
    params.extraDirective ? `\n${params.extraDirective}` : "",
    `\n${verifyReminder}`,
    "When the task is done and you've run it, call finish with a one-line summary. Be concise; act instead of narrating."
  ].filter(Boolean).join("\n");

  const result = await runAgent({
    task,
    cwd,
    llm: params.llm,
    model: params.model,
    maxTurns: params.maxTurns,
    temperature: params.temperature,
    reasoningEffort: params.reasoningEffort,
    systemPrompt,
    onEvent: params.onEvent,
    signal: params.signal,
    captureConfidence: params.captureConfidence,
    decode: params.decode,
    disableThinking: params.disableThinking,
    commandGate: params.commandGate,
    contextPreamble: params.contextPreamble,
    streamDeltas: params.streamDeltas,
    postToolHook: (call, res, ctx) => postEditSyntaxGate(call, res, ctx),
    finishGate: (state) => finishGate(state, testCmd, params.llm, { module: pyModule, examples: workedExamples, setupVars, bans: params.banForbidden ? deriveBans(contract, task) : [] })
  });
  return { ...result, contractTargets: [...contract.files, ...contract.symbols] };
}

/** Tier A2: compile-check a just-edited code file; a syntax error is returned so the model fixes it now. */
function postEditSyntaxGate(call: { name: string; args: Record<string, unknown> }, res: ToolResult, ctx: ToolContext): string | undefined {
  if (res.isError) return undefined;
  if (call.name !== "edit" && call.name !== "write") return undefined;
  const path = typeof call.args.path === "string" ? call.args.path : "";
  const ext = extname(path).toLowerCase();
  if (!CODE_EXT.has(ext)) return undefined;
  const full = join(ctx.cwd, path);
  let check: { cmd: string; args: string[] } | null = null;
  if (ext === ".py") check = { cmd: "python", args: ["-m", "py_compile", full] };
  else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") check = { cmd: "node", args: ["--check", full] };
  // (.ts/.tsx have no cheap standalone syntax check without tsc; skip — the finish gate still runs.)
  if (!check) return undefined;
  try {
    const r = spawnSync(check.cmd, check.args, { encoding: "utf8", timeout: 20000, windowsHide: true });
    if (r.status !== 0) {
      const diag = (r.stderr || r.stdout || "").split(/\r?\n/).filter(Boolean).slice(-4).join("\n").slice(0, 400);
      return `SYNTAX CHECK FAILED for ${path}:\n${diag}\nFix this before continuing — the file will not run as written.`;
    }
  } catch { /* checker missing -> skip silently */ }
  return undefined;
}

// Does a bash command look like it actually executed the code under change (not a trivial probe)?
const EXECUTED_RE = /\b(pytest|unittest|python3?\s+\S+\.py|python3?\s+-c|node\s+\S+\.(m|c)?js|node\s+-e|npm\s+(run\s+)?test|go\s+test|cargo\s+test|bash\s+\S+\.sh|\.\/\S+)\b/i;

/** Finish gate: refuse "done" without an execution receipt; ground a failure via the sidecar. */
async function finishGate(
  state: FinishGateState,
  testCmd: string | null,
  llm: import("./llm.js").KittenLLM,
  worked?: { module: string | null; examples: WorkedExample[]; setupVars: string[]; bans: string[] }
): Promise<{ allowed: boolean; feedback?: string }> {
  // P2 — forbidden-construct scan FIRST. The oracle rejects a banned construct outright, before any
  // behavior test, so a behaviorally-correct solution that uses `import re` still fails. Catch it here
  // (the engine-agnostic layer; a native engine also hard-bans it at decode).
  if (worked?.module && worked.bans?.length) {
    try {
      const src = readFileSync(join(state.cwd, worked.module), "utf8");
      const violation = forbiddenScan(src, worked.bans);
      if (violation) return { allowed: false, feedback: renderBanViolation(violation, worked.bans) };
    } catch { /* module unreadable → let the other gates speak */ }
  }
  // Worked-example anchor — ground truth from the task itself. If the code fails the task's own
  // stated I/O, it is not done regardless of any other signal (and the failing case is the repair seed).
  if (worked?.module && worked.examples.length) {
    const r = runExampleTest(state.cwd, worked.module, worked.examples, worked.setupVars);
    if (r.ran && r.failures.length) {
      return { allowed: false, feedback: renderExampleFailures(r) + "\nFix the cause and re-check these exact calls before finishing." };
    }
  }
  if (testCmd) {
    // Re-run the project tests as the receipt. Allowed only if they pass now.
    const r = spawnSync(testCmd, { cwd: state.cwd, shell: true, encoding: "utf8", timeout: 120000, windowsHide: true });
    if ((r.status ?? 1) === 0) return { allowed: true };
    // The sidecar (qwen-2b, parallel to the GPU) turns the raw failure into a tight card the main
    // model repairs against — grounded repair, not a wall of stderr. Deterministic floor inside.
    const raw = (r.stdout + "\n" + r.stderr).slice(-4000);
    const { card } = await failureCard(llm, raw);
    return { allowed: false, feedback: `\`${testCmd}\` did not pass.\n${renderCard(card)}\nFix the cause and re-run it before finishing.` };
  }
  // Held-out: require an execution receipt among the successful bash commands.
  const verified = state.bashOk.some((c) => EXECUTED_RE.test(c) && !/--version|-V\b/.test(c));
  if (verified) return { allowed: true };
  const ran = state.bashAll.length ? ` (you ran: ${state.bashAll.slice(-3).join(" ; ").slice(0, 150)})` : "";
  return { allowed: false, feedback: `You have not verified your change by running it${ran}. Write a small check that exercises the change on the normal case AND edge cases, run it with bash, see it pass, THEN finish.` };
}

/** Cheap util also used by the CLI: does this dir look like a python/node project (for messaging)? */
export function detectLanguage(cwd: string): "python" | "node" | "unknown" {
  try {
    const names = readdirSync(cwd);
    if (names.includes("package.json")) return "node";
    if (names.some((n) => n.endsWith(".py"))) return "python";
  } catch { /* ignore */ }
  return "unknown";
}
