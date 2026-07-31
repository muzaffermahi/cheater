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
import type { Tool } from "./tools.js";
import type { KittenLLM } from "./llm.js";
import type { ToolContext, ToolResult } from "./tools.js";
import { extractAcceptanceContract } from "../runstate/contract.js";
import { loadProjectCommands } from "../reliability/projectCommands.js";
import { symbolSnippet } from "../reliability/symbolSlice.js";
import { localTscBin } from "../reliability/typeCheckGate.js";
import { failureCard, renderCard } from "./sidecar.js";
import { extractWorkedExamples, extractSetupVars, runExampleTest, renderExampleFailures, type WorkedExample } from "./workedExamples.js";
import { deriveBans, forbiddenScan, renderBanViolation } from "./constraints.js";

/** Live progress from the finish gate's real checks, so a UI can show verification as it happens.
 *  `failed` is deliberately absent: a finish-gate rejection already surfaces as a gate_block →
 *  verification.failed event, and reporting it twice would double every red line in a client. */
export interface VerificationProgress {
  phase: "started" | "evidence" | "passed";
  /** started: what the gate is about to check. */
  what?: string;
  /** evidence: the executed check + its result + how long it took. */
  check?: string;
  passed?: boolean;
  durationMs?: number;
  /** passed: what the receipt was. */
  detail?: string;
}

export interface ReliableParams {
  task: string;
  cwd: string;
  llm: KittenLLM;
  model?: string;
  /** Agent profile instructions layered ahead of the reliability contract. */
  systemPrompt?: string;
  maxTurns?: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  onEvent?: AgentRunParams["onEvent"];
  signal?: AbortSignal;
  /** A1 diversity: a stance/plan/repair directive appended to the system prompt for this sample. */
  extraDirective?: string;
  /** A1 diversity: override/reorder which contract files scout slices first (the localization axis). */
  localizationFiles?: string[];
  /** Effort dial: how many contract files the scout pre-slices into the first message (default 4). */
  scoutFiles?: number;
  /** A3 experience: primed approach-shape from similar past solves, injected into the first message. */
  experiencePrime?: string;
  /** P1: capture per-token logprobs → self-certainty (owned-engine selection signal). */
  captureConfidence?: boolean;
  /** Candidates in this round; self-certainty is only captured when there is something to compare. */
  candidateCount?: number;
  /** Hard cap on thinking tokens per turn; forwarded to the agent loop. */
  reasoningBudget?: number;
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
  /** Live verification progress from the finish gate (started / per-check evidence / passed). */
  onVerification?: (e: VerificationProgress) => void;
  tools?: Tool[];
  spawnTask?: AgentRunParams["spawnTask"];
  allowedFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
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
  const candidateFiles = (params.localizationFiles?.length ? params.localizationFiles : contract.files).slice(0, Math.max(1, params.scoutFiles ?? 4));
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
    params.systemPrompt,
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

  // Snapshot which modules already import, BEFORE the agent touches anything, so the finish gate can
  // tell "the agent broke this" from "this was already broken / needs absent packages".
  const importBaseline = pythonImportBaseline(cwd);

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
    candidateCount: params.candidateCount,
    reasoningBudget: params.reasoningBudget,
    decode: params.decode,
    disableThinking: params.disableThinking,
    commandGate: params.commandGate,
    contextPreamble: params.contextPreamble,
    streamDeltas: params.streamDeltas,
    tools: params.tools,
    spawnTask: params.spawnTask,
    allowedFiles: params.allowedFiles,
    forbiddenFiles: params.forbiddenFiles,
    postToolHook: (call, res, ctx) => postEditSyntaxGate(call, res, ctx),
    finishGate: (state) => finishGate(state, testCmd, params.llm, { module: pyModule, examples: workedExamples, setupVars, bans: params.banForbidden ? deriveBans(contract, task) : [] }, params.onVerification, importBaseline)
  });
  return { ...result, contractTargets: [...contract.files, ...contract.symbols] };
}

/** Tier A2: compile-check a just-edited code file; a syntax error is returned so the model fixes it now. */
export function postEditSyntaxGate(call: { name: string; args: Record<string, unknown> }, res: ToolResult, ctx: ToolContext): string | undefined {
  if (res.isError) return undefined;
  if (call.name !== "edit" && call.name !== "write") return undefined;
  const path = typeof call.args.path === "string" ? call.args.path : "";
  const ext = extname(path).toLowerCase();
  if (!CODE_EXT.has(ext)) return undefined;
  const full = join(ctx.cwd, path);
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") return typeScriptSyntaxGate(ctx.cwd, path, full);
  let check: { cmd: string; args: string[] } | null = null;
  if (ext === ".py") check = { cmd: "python", args: ["-m", "py_compile", full] };
  else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") check = { cmd: "node", args: ["--check", full] };
  if (!check) return undefined;
  try {
    const r = spawnSync(check.cmd, check.args, { encoding: "utf8", timeout: 20000, windowsHide: true });
    if (r.status !== 0) {
      const diag = (r.stderr || r.stdout || "").split(/\r?\n/).filter(Boolean).slice(-4).join("\n").slice(0, 400);
      return `SYNTAX CHECK FAILED for ${path}:\n${diag}\nFix this before continuing — the file will not run as written.`;
    }
  } catch { /* checker missing -> skip silently */ }
  if (ext === ".py") return pythonSelfCallGate(path, full);
  return undefined;
}

/**
 * Catch a `self.method(...)` call whose argument count cannot match the method's own definition.
 *
 * Syntax checks pass such code and a smoke test only catches it if the run happens to take that
 * branch — measured live: a model shipped an expression parser whose ONLY bad call site,
 * `self._consume(")")`, sat on the parenthesis path. Its own verification ran `2 + 3`, never took
 * that branch, and the finish gate accepted the green receipt. `(1+2)*3` then raised TypeError.
 *
 * Deterministic and conservative: only methods defined in the SAME class body, no decorators, no
 * *args/**kwargs. Anything it cannot prove wrong, it leaves alone.
 */
function pythonSelfCallGate(path: string, full: string): string | undefined {
  const program = `
import ast, sys
try:
    tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
except Exception:
    sys.exit(0)
problems = []
for cls in [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]:
    methods = {}
    for fn in cls.body:
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if fn.decorator_list or fn.args.vararg or fn.args.kwarg:
            continue          # properties/staticmethods/varargs: not provably wrong
        pos = len(fn.args.args) + len(fn.args.posonlyargs) - 1          # drop self
        methods[fn.name] = (pos - len(fn.args.defaults), pos)
    for node in ast.walk(cls):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        if not (isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "self"):
            continue
        if f.attr not in methods or any(isinstance(a, ast.Starred) for a in node.args) or node.keywords:
            continue
        lo, hi = methods[f.attr]
        n = len(node.args)
        if n < lo or n > hi:
            want = str(lo) if lo == hi else "%d-%d" % (lo, hi)
            problems.append("line %d: self.%s(...) passes %d argument(s) but %s() accepts %s"
                            % (node.lineno, f.attr, n, f.attr, want))
if problems:
    print("\\n".join(problems[:5]))
    sys.exit(1)
`;
  try {
    const r = spawnSync("python", ["-c", program, full], { encoding: "utf8", timeout: 20000, windowsHide: true });
    if (r.status === 1 && (r.stdout ?? "").trim()) {
      return `METHOD CALL CHECK FAILED for ${path}:\n${r.stdout.trim().slice(0, 400)}\nThis will raise TypeError as soon as that line runs. Fix the signature or the call before continuing.`;
    }
  } catch { /* no python -> skip silently */ }
  return undefined;
}

/** tsc reserves TS1xxx for grammar errors; TS2xxx and up are semantic and are not this gate's job. */
const TS_SYNTAX_ERROR = /error\s+TS1\d{3}:/;

/**
 * Reduce a single-file tsc run to a model-facing message, or undefined when there is nothing to say.
 * Pure and exported because this filter is the whole safety argument for running tsc per edit: keep
 * grammar errors, drop the module-resolution noise that compiling one file out of its project always
 * produces.
 */
export function typeScriptSyntaxDiagnostic(path: string, output: string): string | undefined {
  const diag = (output ?? "")
    .split(/\r?\n/)
    .filter((line) => TS_SYNTAX_ERROR.test(line))
    .slice(0, 4)
    .map((line) => line.trim().slice(0, 240));
  if (!diag.length) return undefined;
  return `SYNTAX CHECK FAILED for ${path}:\n${diag.join("\n")}\nFix this before continuing — the file will not compile as written.`;
}

/**
 * Syntax-check a just-edited TypeScript file.
 *
 * This used to be skipped outright ("no cheap standalone check without tsc"), which left the repo's
 * own primary language as the one hole in the post-edit gate. The check is a single-file `tsc` run,
 * and two things make it safe to run per edit:
 *   - It reports ONLY TS1xxx grammar errors. Compiling one file outside its project produces plenty
 *     of TS2xxx module-resolution noise ("cannot find module './x'") that is an artifact of the
 *     single-file invocation, not a defect in the edit. Reporting that would send the model chasing
 *     phantoms — strictly worse than skipping.
 *   - It only runs when tsc is installed locally, and never blocks when it is missing or times out.
 *
 * Measured at ~1s per edit on this repo, against ~0.3s for `py_compile`; the same order as the
 * checks that were already running. `node --check` was tried first and rejected: it rejects valid
 * TypeScript (`enum`) and its module detection is inconsistent, so it produced false failures.
 */
function typeScriptSyntaxGate(cwd: string, path: string, full: string): string | undefined {
  const bin = localTscBin(cwd);
  if (!bin) return undefined; // no local tsc -> honest skip, same rule as the typecheck gate
  try {
    // Shell form: the local binary is a .cmd shim on Windows, which spawnSync cannot exec directly.
    const command = `"${bin}" --noEmit --skipLibCheck --target es2022 --module esnext --moduleResolution bundler "${full}"`;
    const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: 20000, windowsHide: true });
    if (r.signal === "SIGTERM" || r.signal === "SIGKILL") return undefined; // a slow check must never dead-end the model
    return typeScriptSyntaxDiagnostic(path, `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch { /* checker missing/unrunnable -> skip silently */ }
  return undefined;
}

/**
 * Which pre-existing Python modules import cleanly right now.
 *
 * This is the baseline half of a "don't break what worked" invariant. A multi-file change is the
 * case where a model most often fixes one file and silently breaks another — rename a function and
 * forget the importer, move a helper and leave a dangling `from x import y`. Neither a syntax check
 * nor the model's own smoke test on the file it just edited will notice; the next importer explodes.
 *
 * Only modules that ALREADY imported are recorded, so a repo that was broken to begin with, or a
 * module needing absent third-party packages, can never be blamed on the agent. New files the agent
 * creates are deliberately not imported here — their correctness is the model's own to demonstrate,
 * and importing freshly generated code for a gate check is not something to do behind the user's back.
 */
export function pythonImportBaseline(cwd: string): string[] {
  const program = `
import importlib, json, os, sys, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.getcwd())
SKIP = {"__pycache__", ".git", ".venv", "venv", "node_modules", ".cheater", "build", "dist"}
mods = []
for root, dirs, files in os.walk("."):
    dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith(".")]
    for f in files:
        if not f.endswith(".py") or f.startswith("_accept"):
            continue
        rel = os.path.relpath(os.path.join(root, f), ".")
        parts = rel[:-3].replace("\\\\", "/").split("/")
        if parts[-1] == "__init__":
            parts = parts[:-1]
        if not parts or any(not p.isidentifier() for p in parts):
            continue
        mods.append(".".join(parts))
ok = []
for m in sorted(set(mods)):
    try:
        importlib.import_module(m)
        ok.append(m)
    except BaseException:
        pass
print(json.dumps(ok))
`;
  try {
    const r = spawnSync("python", ["-c", program], { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });
    if (r.status !== 0) return [];
    return JSON.parse((r.stdout ?? "[]").trim()) as string[];
  } catch { return []; }
}

/** Re-import the baseline modules; returns a model-facing message when one that worked now fails. */
export function pythonImportRegression(cwd: string, baseline: readonly string[]): string | undefined {
  if (!baseline.length) return undefined;
  const program = `
import importlib, json, sys, os, warnings, traceback
warnings.filterwarnings("ignore")
sys.path.insert(0, os.getcwd())
broken = []
for m in json.loads(sys.argv[1]):
    try:
        importlib.import_module(m)
    except BaseException as e:
        broken.append("%s: %s: %s" % (m, type(e).__name__, str(e)[:160]))
print(json.dumps(broken))
`;
  try {
    const r = spawnSync("python", ["-c", program, JSON.stringify(baseline)], { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });
    if (r.status !== 0) return undefined;
    const broken = JSON.parse((r.stdout ?? "[]").trim()) as string[];
    if (!broken.length) return undefined;
    return `You have BROKEN modules that imported cleanly before your change:\n${broken.slice(0, 5).map((b) => `  - ${b}`).join("\n")}\nA change is not done while it breaks an existing importer. Fix every caller of anything you renamed or moved, then re-check.`;
  } catch { return undefined; }
}

// Does a bash command look like it actually executed the code under change (not a trivial probe)?
const EXECUTED_RE = /\b(pytest|unittest|python3?\s+\S+\.py|python3?\s+-c|node\s+\S+\.(m|c)?js|node\s+-e|npm\s+(run\s+)?test|go\s+test|cargo\s+test|bash\s+\S+\.sh|\.\/\S+)\b/i;

/** Finish gate: refuse "done" without an execution receipt; ground a failure via the sidecar. */
async function finishGate(
  state: FinishGateState,
  testCmd: string | null,
  llm: import("./llm.js").KittenLLM,
  worked?: { module: string | null; examples: WorkedExample[]; setupVars: string[]; bans: string[] },
  onVerification?: (e: VerificationProgress) => void,
  importBaseline: readonly string[] = [],
): Promise<{ allowed: boolean; feedback?: string }> {
  onVerification?.({
    phase: "started",
    what: testCmd ? `finish gate: ${testCmd}` : worked?.examples.length ? "finish gate: worked examples" : "finish gate: execution receipt",
  });
  // "Don't break what worked" comes FIRST: a change that leaves an existing importer broken is not
  // done, whatever else passes. This is the multi-file failure the model cannot see from the one
  // file it edited.
  if (importBaseline.length) {
    const regressed = pythonImportRegression(state.cwd, importBaseline);
    if (regressed) {
      onVerification?.({ phase: "evidence", check: "existing modules still import", passed: false, durationMs: 0 });
      return { allowed: false, feedback: regressed };
    }
    onVerification?.({ phase: "evidence", check: `${importBaseline.length} pre-existing module(s) still import`, passed: true, durationMs: 0 });
  }
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
    const exStarted = Date.now();
    const r = runExampleTest(state.cwd, worked.module, worked.examples, worked.setupVars);
    if (r.ran) onVerification?.({ phase: "evidence", check: "worked examples (ground truth)", passed: r.failures.length === 0, durationMs: Date.now() - exStarted });
    if (r.ran && r.failures.length) {
      return { allowed: false, feedback: renderExampleFailures(r) + "\nFix the cause and re-check these exact calls before finishing." };
    }
  }
  if (testCmd) {
    // Re-run the project tests as the receipt. Allowed only if they pass now.
    const testStarted = Date.now();
    const r = spawnSync(testCmd, { cwd: state.cwd, shell: true, encoding: "utf8", timeout: 120000, windowsHide: true });
    const passed = (r.status ?? 1) === 0;
    onVerification?.({ phase: "evidence", check: testCmd, passed, durationMs: Date.now() - testStarted });
    if (passed) { onVerification?.({ phase: "passed", detail: `\`${testCmd}\` passed` }); return { allowed: true }; }
    // The sidecar (qwen-2b, parallel to the GPU) turns the raw failure into a tight card the main
    // model repairs against — grounded repair, not a wall of stderr. Deterministic floor inside.
    const raw = (r.stdout + "\n" + r.stderr).slice(-4000);
    const { card } = await failureCard(llm, raw);
    return { allowed: false, feedback: `\`${testCmd}\` did not pass.\n${renderCard(card)}\nFix the cause and re-run it before finishing.` };
  }
  // Held-out: require an execution receipt among the successful bash commands.
  const verified = state.bashOk.some((c) => EXECUTED_RE.test(c) && !/--version|-V\b/.test(c));
  if (verified) {
    onVerification?.({ phase: "passed", detail: "execution receipt present (the change was actually run)" });
    return { allowed: true };
  }
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
