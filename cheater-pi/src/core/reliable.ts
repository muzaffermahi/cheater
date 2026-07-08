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
import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { runAgent, type AgentRunParams, type AgentRunResult, type FinishGateState } from "./agent.js";
import type { KittenLLM } from "./llm.js";
import type { ToolContext, ToolResult } from "./tools.js";
import { extractAcceptanceContract } from "../runstate/contract.js";
import { loadProjectCommands } from "../reliability/projectCommands.js";
import { symbolSnippet } from "../reliability/symbolSlice.js";
import { failureCard, renderCard } from "./sidecar.js";

export interface ReliableParams {
  task: string;
  cwd: string;
  llm: KittenLLM;
  model?: string;
  maxTurns?: number;
  temperature?: number;
  onEvent?: AgentRunParams["onEvent"];
  signal?: AbortSignal;
}

const CODE_EXT = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export async function runReliableAgent(params: ReliableParams): Promise<AgentRunResult & { contractTargets: string[] }> {
  const { cwd, task } = params;
  const contract = extractAcceptanceContract(task);
  const project = loadProjectCommands(cwd);
  const testCmd = project.focusedTestCommand ?? project.testCommand ?? null;

  // Scout: deterministically locate the files the task names (that exist) and slice the relevant
  // symbol out of each, so the first turn already carries the code to change.
  const terms = [...contract.symbols, ...task.split(/\s+/).filter((w) => w.length > 4)].slice(0, 12);
  const briefs: string[] = [];
  for (const file of contract.files.slice(0, 4)) {
    if (existsSync(join(cwd, file))) {
      const snip = symbolSnippet(cwd, file, terms.length ? terms : [file]);
      if (snip) briefs.push(snip);
    }
  }

  const contractLines: string[] = [];
  if (contract.files.length) contractLines.push(`Files named in the task: ${contract.files.join(", ")}`);
  if (contract.symbols.length) contractLines.push(`Symbols named in the task: ${contract.symbols.join(", ")}`);
  if (contract.commands.length) contractLines.push(`Commands named in the task: ${contract.commands.join(" | ")}`);

  const verifyMandate = testCmd
    ? `Before you call finish you MUST run the project's tests with bash (\`${testCmd}\`) and see them pass.`
    : `No test command exists in this project, so YOU are the only checker. Before you call finish you MUST: write a tiny check (a script, or a REPL one-liner via bash \`python -c\`) that exercises your change on the NORMAL case AND the obvious edge cases (empty, single, boundary, ordering), run it with bash, and confirm it prints/asserts the right answers. Do not finish on assumption.`;

  const systemPrompt = [
    "You are Kitten, a precise coding agent. You have tools: read, write, edit, bash, ls, grep, finish.",
    "Work in small verified steps. Read the exact code region before editing. To change an existing file use edit (give enough surrounding original text to be unique); use write only for a new file.",
    contractLines.length ? `\nAcceptance targets (do not rename or approximate these):\n- ${contractLines.join("\n- ")}` : "",
    briefs.length ? `\nRelevant code, already located for you (read more with the read tool if needed):\n${briefs.join("\n")}` : "",
    `\n${verifyMandate}`,
    "When the task is done AND verified, call finish with a one-line summary. Be concise; act instead of narrating."
  ].filter(Boolean).join("\n");

  const result = await runAgent({
    task,
    cwd,
    llm: params.llm,
    model: params.model,
    maxTurns: params.maxTurns,
    temperature: params.temperature,
    systemPrompt,
    onEvent: params.onEvent,
    signal: params.signal,
    postToolHook: (call, res, ctx) => postEditSyntaxGate(call, res, ctx),
    finishGate: (state) => finishGate(state, testCmd, params.llm)
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
async function finishGate(state: FinishGateState, testCmd: string | null, llm: import("./llm.js").KittenLLM): Promise<{ allowed: boolean; feedback?: string }> {
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
