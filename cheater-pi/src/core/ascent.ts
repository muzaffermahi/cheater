// Kitten Ascent — the orchestrator. Assembles every lever into one pass@k→pass@1 run:
//
//   coverage (Part A)         selection (Part B)        affordability (Part C)
//   ─────────────────         ──────────────────        ──────────────────────
//   A1 diverse best-of-N  →   B1 execution signals  ←   C1 cheap→expensive cascade
//   A2 web augmentation       B2 consensus vote         C2 cloud-burst (same weights)
//   A3 experience RAG         B3 trained ORM            C3 budget governor
//   A4 skill playbooks        B4 fusion + finish gate
//
// Flow: prime the generator from the task family (A4) + similar past solves (A3); generate a diverse,
// budgeted batch (A1) — in the cloud in parallel or locally (C2), each in an isolated workspace; if the
// first round finds nothing eligible, look up the blocking error (A2) and repair-resample; cut the field
// cheaply (C1); execution-verify the survivors and select the winner (B); adopt its workspace; on a
// verifier-confirmed solve, remember it (A3, disjoint). Every lever is TOGGLEABLE so Part D's ablation
// can measure each one's marginal Best@1 — and each lever fails gracefully to the path below it.

import { distillAttempt, renderDigests, digestsAreInformative, digestReceiptLine } from "./distill.js";
import type { KittenLLM } from "./llm.js";
import type { AgentEvent } from "./agent.js";
import { extractAcceptanceContract } from "../runstate/contract.js";
import { loadProjectCommands } from "../reliability/projectCommands.js";
import { planAttempts, repairDirective } from "./diversity.js";
import { computeBudget, type HardnessSignal } from "../runtime/computeBudget.js";
import { BudgetGovernor, type ComputeCeiling } from "./budget.js";
import { classifyFamily, playbookFor, primeFromPlaybook, type TaskFamily } from "./playbooks.js";
import { ExperienceStore, primeFromRetrieved, localizationPriorFromRetrieved, summarizeApproach, defaultExperienceDir } from "./experience.js";
import { WebAugmentor, decideTrigger, webAugmentReceiptLines, defaultWebAugmentor } from "./webAugment.js";
import { loadOrm } from "./orm.js";
import { runCascade, cascadeReceiptLines, type CascadeCandidate } from "./cascade.js";
import { Verifier, verifierReceiptLines, type Candidate } from "./verifier.js";
import { generateFnProbes } from "./synthtest.js";
import { generateReproScript, isRepoShaped } from "./reproTest.js";
import { generatePlans, selectPlan, planDirective, type CandidatePlan } from "./planFirst.js";
import { extractWorkedExamples, extractSetupVars, runExampleTest, renderExampleFailures } from "./workedExamples.js";
import { buildBanDecode } from "./constraints.js";
import type { OrmScorer } from "./orm.js";
import { cloudBurstGenerate, cloudLlm, adoptWorkspace, cleanupBurst, checkpointCandidates, clearCheckpoints, CHECKPOINT_DIR, cloudBurstConfigFromEnv, type BurstAttempt, type CloudBurstConfig, type RunOne } from "./cloudBurst.js";
import { EvalRegistry, defaultRegistry } from "./disjointness.js";

/** Which levers are ON. Part D3 flips these one at a time to measure each lever's marginal Best@1. */
export interface AscentLevers {
  diversity: boolean;    // A1 — multi-axis best-of-N (off ⇒ k=1)
  web: boolean;          // A2 — web augmentation on an unresolved error
  experience: boolean;   // A3 — experience RAG priming + admission
  skills: boolean;       // A4 — task-family playbook priming
  cascade: boolean;      // C1 — cheap→expensive pre-filter
  cloudBurst: boolean;   // C2 — parallel cloud generation (needs a cloud config)
  orm: boolean;          // B3 — ORM ranking (needs an orm)
  confidence: boolean;   // P1 — self-certainty selection tiebreaker (owned engine, needs logprobs)
  banForbidden: boolean; // P2 — decode-time forbidden-construct ban + finish-gate scan
  samplerDiversity: boolean; // P5 — per-sample sampler profiles to decorrelate the batch
  leanReasoning: boolean;    // iter-1 — no-think fast forward pass on easy tasks (owned engine, --jinja)
}

// leanReasoning DEFAULT OFF: no-think on the MAIN agent tanks tasks that genuinely need reasoning
// (measured: json_query, a nested JSON-path evaluator, went 0/56 → 16/56 no-think). The static hardness
// score can't tell "mechanically trivial" from "looks easy but needs CoT", so the main agent keeps its
// reasoning. The pure win — no-think on the MECHANICAL sidecar — lives in llm.sidecar(), not this lever.
export const ALL_LEVERS: AscentLevers = { diversity: true, web: true, experience: true, skills: true, cascade: true, cloudBurst: false, orm: true, confidence: true, banForbidden: true, samplerDiversity: true, leanReasoning: false };
export const NO_LEVERS: AscentLevers = { diversity: false, web: false, experience: false, skills: false, cascade: false, cloudBurst: false, orm: false, confidence: false, banForbidden: false, samplerDiversity: false, leanReasoning: false };

/** Live progress from the ascent machine, for the app event stream (repair rounds + verification). */
export type AscentProgress =
  | { kind: "repair.started"; round: number; reason: string }
  | { kind: "verification.started"; what: string }
  | { kind: "verification.evidence"; index: number; check: string; passed: boolean; durationMs: number }
  | { kind: "verification.passed"; detail: string }
  | { kind: "verification.failed"; detail: string };

export interface AscentConfig {
  llm: KittenLLM;
  registry?: EvalRegistry;
  experienceStore?: ExperienceStore | null;
  orm?: OrmScorer | null;
  webAugmentor?: WebAugmentor | null;
  cloudBurst?: CloudBurstConfig | null;
  ceiling?: ComputeCeiling;
  levers?: Partial<AscentLevers>;
  /** Effort dial: repair-round bound (replaces the hardcoded samples<=1?1:2 when set). */
  maxRepairRounds?: number;
  /** Live progress sink (repair rounds, verification phases). Advisory; never changes the grade. */
  onProgress?: (e: AscentProgress) => void;
  /** Injectable generator (default: cloudBurstGenerate). Tests supply a deterministic one. */
  runOne?: RunOne;
  /** Rough per-sample token estimate for the budget governor. */
  estTokensPerSample?: number;
  /** Measurement hook (D1): awaited with all candidate workspaces + the verdict BEFORE cleanup, so a
   *  rig can oracle-score every candidate (pass@k) not just the winner. */
  onVerified?: (ctx: { attempts: BurstAttempt[]; verdict: { winner: number | null; slate: Array<{ index: number }> } }) => void | Promise<void>;
  /** Durable candidate cards for the desktop/app event stream. Only ever fired with a REAL resolved
   *  attempt, which is why "started" is a separate hook — at start there is no attempt yet. */
  onCandidate?: (event: { phase: "completed" | "rejected"; attempt: BurstAttempt; reason?: string }) => void | Promise<void>;
  /** The competing plans and the one chosen to implement (plan-diversity mode). */
  onPlanSelected?: (event: { considered: CandidatePlan[]; chosen: CandidatePlan; reason: string }) => void;
  /** A candidate has begun generating. Fires immediately, not once the burst resolves. */
  onCandidateStart?: (event: { index: number; lead: boolean }) => void;
  /** Live agent events from the lead candidate, so the generation phase is not a black box. */
  onLeadEvent?: (e: AgentEvent) => void;
}

export interface AscentParams {
  task: string;
  cwd: string;
  taskId?: string;
  hardness?: HardnessSignal;
  /** Measurement-only (D1): force the sample count to a fixed N, overriding the hardness budget. */
  forceSamples?: number;
  /** Effort dial: clamp the hardness-budgeted sample count into [kFloor, kCap] (the governor still
   *  caps downward — ceilings are hard). forceSamples bypasses the clamp (measurement stays exact). */
  kFloor?: number;
  kCap?: number;
  maxTurns?: number;
  reasoningEffort?: "low" | "medium" | "high";
  /** Model-facing conversation context (prior turns + repo truth); every candidate gets the same one. */
  contextPreamble?: string;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Effective model ID for this run. Passed through to cloudBurstGenerate per-call ChatParams. */
  model?: string;
}

export interface AscentResult {
  finished: boolean;
  summary: string;
  winner: number | null;
  selector: string;
  winnerHasExecutionReceipt: boolean;
  family: TaskFamily;
  samples: number;
  rounds: number;
  receipts: string[];
  usage: { prompt: number; completion: number; reasoning: number };
  formatRescues?: number;
  wallMs: number;
  /** Files the winner's workspace brought in. The authoritative "what changed" when the workspace is
   *  not a git repository and there is therefore no snapshot to diff against. */
  adoptedFiles: string[];
}

const DEFAULT_EST_TOKENS = 8000;

/**
 * Assemble the standard ascent config from env: the disjointness firewall (with the SWE-Verified
 * manifest if KITTEN_SWE_MANIFEST is set), the experience store (loaded eagerly so a poisoned store
 * HARD-FAILS at startup, not silently mid-run), the ORM (if a checkpoint is configured), the web
 * augmentor, and cloud-burst (if KITTEN_CLOUD_* is set). This is what the CLI's --ascent path uses.
 */
export function defaultAscentConfig(llm: KittenLLM, cwd: string): AscentConfig {
  const registry = defaultRegistry(process.env.KITTEN_SWE_MANIFEST);
  const experienceStore = new ExperienceStore({ dir: defaultExperienceDir(cwd), registry, llm });
  experienceStore.load(); // throws DisjointnessError on a poisoned store — the guarantee is meant to be fatal
  const cloud = cloudBurstConfigFromEnv();
  return {
    llm, registry, experienceStore,
    orm: loadOrm(llm),
    webAugmentor: defaultWebAugmentor(registry),
    cloudBurst: cloud,
    levers: { ...ALL_LEVERS, cloudBurst: !!cloud }
  };
}

/** Assemble a compact trajectory string (for the ORM + cascade) from an attempt's result. */
function buildTrajectory(a: BurstAttempt): string {
  const toolLines = a.result.events
    .filter((e) => e.kind === "tool")
    .map((e) => `${e.detail}${e.data?.output ? `\n${String(e.data.output).slice(0, 300)}` : ""}`)
    .slice(-8);
  return [
    `finished: ${a.result.finished} (${a.result.stopReason})`,
    `summary: ${a.result.summary}`,
    `files: ${a.result.filesWritten.join(", ")}`,
    ...toolLines
  ].join("\n").slice(0, 4000);
}

/** Extract an error signature from an attempt's tool outputs (for the A2 web trigger). */
function errorSignatureOf(a: BurstAttempt): string | undefined {
  for (const e of [...a.result.events].reverse()) {
    if (e.kind === "tool" && e.data?.error && e.data?.output) {
      const m = String(e.data.output).match(/([A-Za-z]*(Error|Exception)[^\n]*)/);
      if (m) return m[1].slice(0, 200);
    }
  }
  return undefined;
}

function lever<K extends keyof AscentLevers>(config: AscentConfig, key: K): boolean {
  const l = { ...ALL_LEVERS, ...(config.levers ?? {}) };
  return l[key];
}

/**
 * Run the full ascent machine over one task. Returns the winner + the complete receipts (the audit
 * trail: family, priming, budget, cascade cuts, verifier slate, web fetches, experience admission).
 */
export async function runAscent(params: AscentParams, config: AscentConfig): Promise<AscentResult> {
  const started = Date.now();
  const registry = config.registry ?? defaultRegistry();
  const receipts: string[] = [];
  const contract = extractAcceptanceContract(params.task);
  const project = loadProjectCommands(params.cwd);
  const testCommand = project.focusedTestCommand ?? project.testCommand ?? null;

  // C3 — budget: hardness → sample count, capped by the governor's ceiling.
  const budget = computeBudget(params.hardness ?? {}, { adaptiveComputeEnabled: true });
  const governor = new BudgetGovernor(config.ceiling ?? {});
  const estTokens = config.estTokensPerSample ?? DEFAULT_EST_TOKENS;
  let samples = params.forceSamples ?? (lever(config, "diversity") ? Math.max(1, budget.samples) : 1);
  // Effort clamp (forceSamples = measurement, stays exact): floor then cap, then the governor's hard
  // downward cap — ceilings always win over floors.
  if (params.forceSamples === undefined) {
    if (params.kFloor && params.kFloor > samples) samples = params.kFloor;
    if (params.kCap && params.kCap < samples) samples = params.kCap;
  }
  samples = governor.capSamples(samples, estTokens);
  receipts.push(`budget: hardness ${budget.hardness} → k=${samples} (${budget.reason})`);

  // A4 — skills: classify the task family and prime the plan with its procedure.
  let family: TaskFamily = "general";
  let skillPrime = "";
  if (lever(config, "skills")) {
    try {
      const c = await classifyFamily(config.llm, params.task);
      family = c.family;
      skillPrime = primeFromPlaybook(playbookFor(family));
      receipts.push(`family: ${family} (${c.source})`);
    } catch { /* keep general */ }
  }

  // A3 — experience: retrieve similar past solves; prime the generator (the primer lists the files the
  // similar solves touched, which also steers scout's localization).
  let experiencePrime = "";
  if (lever(config, "experience") && config.experienceStore) {
    try {
      const hits = await config.experienceStore.retrieve(params.task);
      if (hits.length) {
        experiencePrime = primeFromRetrieved(hits);
        receipts.push(`experience: primed from ${hits.length} similar solve(s) [top sim ${hits[0].score.toFixed(2)}, files ${localizationPriorFromRetrieved(hits).join(", ") || "n/a"}]`);
      }
    } catch { /* store may hard-fail on disjointness — surfaced by load(), not here */ }
  }
  const basePrime = [skillPrime, experiencePrime].filter(Boolean).join("\n\n");

  // B2 target (single-fn consensus), computed once.
  const probe = await generateFnProbes(config.llm, params.task, contract).catch(() => null);

  // B1 red-then-green for a REPO-shaped task. The probes above cover the single-function case; a task
  // that is "here is a codebase and an issue" has no worked examples and its existing suite usually
  // passes on the unfixed code, so `reproduction` was permanently n/a and eligibility collapsed to
  // "did not break anything" — satisfied by a candidate that changed nothing of consequence. One
  // model call buys the missing signal, and the verifier screens it on the base before believing it.
  // Only asked when there is a base to screen against; an unscreened script is worse than none.
  // The base IS `params.cwd`: candidates run in isolated copies and the winner is applied only after
  // verification, so until then the project directory still holds the unchanged code. Nothing is ever
  // written into it — the script runs from a temp directory with the workspace on the import path.
  const reproScript = !probe && isRepoShaped(contract, params.task)
    ? await generateReproScript(config.llm, params.task, contract).catch(() => null)
    : null;
  if (reproScript) receipts.push("generated a reproduction script (screened against the base before it counts)");

  // Consensus floor: a statically-"easy" task (hardness 0 → k=1) can still hide edge-case difficulty —
  // json_query reads easy yet a lone k=1 candidate shipped 2/56 wrong. When a self-probe exists and the
  // caller didn't pin k, floor easy tasks to k=2 so there are ≥2 candidates to select between. Originally
  // k=3 (for a majority vote), but the ground-truth eligibility gate + mid-loop repair now filter wrong
  // candidates directly — so k=2 recovers json_query (measured 0/56) at ⅓ less latency than k=3, and a
  // task that stays wrong earns more depth from the repair round anyway. Hard tasks keep their budgeted k.
  if (probe && lever(config, "diversity") && params.forceSamples === undefined && budget.hardness < 2 && samples < 2 && (params.kCap ?? 2) >= 2) {
    const floored = governor.capSamples(2, estTokens);
    if (floored > samples) { samples = floored; receipts.push(`consensus floor: k→${samples} (self-probe present → select between candidates)`); }
  }

  const genLlm = lever(config, "cloudBurst") && config.cloudBurst ? cloudLlm(config.cloudBurst) : config.llm;
  const concurrency = lever(config, "cloudBurst") && config.cloudBurst ? (config.cloudBurst.concurrency ?? 6) : 1;

  // P2 — decode-time forbidden-construct ban: derive bans from the task's stated prohibitions, and (on a
  // native engine with /tokenize) build the logit_bias hard-ban. The finish-gate SOURCE SCAN (in
  // reliable.ts) is the engine-agnostic layer that always runs when banForbidden is on.
  let banDecode: { logitBias?: Record<number, number> } | undefined;
  if (lever(config, "banForbidden")) {
    try {
      const ban = await buildBanDecode(config.llm, contract, params.task);
      if (ban.bans.length) receipts.push(`forbidden: ${ban.bans.join("/")}${Object.keys(ban.logitBias).length ? ` (decode-banned ${Object.keys(ban.logitBias).length} tokens)` : " (finish-gate scan only)"}`);
      if (Object.keys(ban.logitBias).length) banDecode = { logitBias: ban.logitBias };
    } catch { /* ban derivation best-effort */ }
  }

  // Ground truth (the prompt's worked examples) — extracted once, used both to decide mid-loop whether a
  // finished candidate is actually RIGHT (not just done) and later to gate verifier eligibility.
  const pyModule = contract.files.find((f) => f.toLowerCase().endsWith(".py")) ?? null;
  const workedExamples = pyModule ? extractWorkedExamples(params.task, contract.symbols) : [];
  const setupVars = workedExamples.length ? extractSetupVars(params.task) : [];
  const passesGroundTruth = (ws: string): boolean => {
    if (!workedExamples.length || !pyModule) return true; // no ground truth ⇒ can't refute; treat as ok
    const r = runExampleTest(ws, pyModule, workedExamples, setupVars);
    return !r.ran || r.failures.length === 0; // couldn't run ⇒ don't block; ran clean ⇒ good
  };

  // Coverage rounds (A1 + A2 repair). Round 1 primes from A3/A4; a repair round adds A2's web brief.
  let allAttempts: BurstAttempt[] = [];
  let repairSeed: string | undefined;
  let round = 0;
  const maxRounds = lever(config, "diversity") ? (config.maxRepairRounds ?? (samples <= 1 ? 1 : 2)) : 1;

  // Plan-diversity: spend k on PLANS, then implement once. Only when the candidates would serialize
  // (concurrency 1 — a local single-slot runtime); a cloud burst runs them concurrently and keeps the
  // stronger implementation-diversity. See planFirst.ts for the measurement behind this.
  let planDirectiveText: string | undefined;
  if (samples > 1 && concurrency === 1 && lever(config, "diversity")) {
    const generated = await generatePlans(genLlm, params.task, samples, params.signal);
    const selection = await selectPlan(genLlm, params.task, generated, params.signal);
    if (selection.chosen) {
      planDirectiveText = planDirective(selection.chosen);
      receipts.push(`plan-first: ${generated.length} plan(s) generated, ${selection.reason} → 1 implementation (candidates would have run serially)`);
      try { config.onPlanSelected?.({ considered: selection.considered, chosen: selection.chosen, reason: selection.reason }); } catch { /* UI hook */ }
      // The diversity budget was spent on plans. Implementing k times as well would be paying twice.
      samples = 1;
    }
  }

  for (round = 1; round <= maxRounds; round++) {
    if (governor.exhausted()) { receipts.push("budget exhausted → stop generating"); break; }
    const plans = planAttempts(samples, {
      multiFile: contract.files.length > 1,
      localizationVariants: Math.max(1, Math.min(4, contract.files.length)),
      repairSeed,
      samplerDiversity: lever(config, "samplerDiversity")
    });
    // Iter-1: on an easy task (low hardness score) run ornith with its chain-of-thought OFF — it writes
    // the code directly ~2x faster and the harness supplies the correctness. Hard tasks keep their CoT,
    // and any candidate that hits the finish gate gets its reasoning back for the repair turns.
    const leanReasoning = lever(config, "leanReasoning") && budget.hardness < 2;
    if (round === 1 && leanReasoning) receipts.push("lean-reasoning: no-think forward pass (easy task)");
    // cloudBurst assigns round-local indices 1..k, but cascade/verifier/measure use `index` as a stable
    // GLOBAL identity. Without reindexing, a repair round's indices collide with round 1 — collapsing the
    // survivorsByIndex map (round 2 shadows round 1), adopting the wrong round's workspace, and
    // misattributing Best@1. Give each attempt a unique index across rounds. Computed BEFORE the burst
    // so a candidate announced at start carries the same identity it will report at completion.
    const indexBase = allAttempts.length;
    const attempts = await cloudBurstGenerate(
      { task: params.task, cwd: params.cwd, llm: genLlm, model: params.model, maxTurns: params.maxTurns, reasoningEffort: params.reasoningEffort, experiencePrime: [basePrime, planDirectiveText].filter(Boolean).join("\n\n"), contextPreamble: params.contextPreamble,
        decode: banDecode, banForbidden: lever(config, "banForbidden"), disableThinking: leanReasoning, signal: params.signal },
      plans,
      {
        concurrency, runOne: config.runOne,
        // Announce each candidate as it STARTS. This used to run after the burst resolved, which meant
        // the whole generation phase — the longest part of the run — reported nothing at all.
        onStart: (plan) => {
          // Global index, matching the reindexing applied to the resolved attempts below, so a
          // "started" and its later "completed" name the same candidate.
          const slot = plans.findIndex((p) => p === plan);
          try { config.onCandidateStart?.({ index: indexBase + (slot < 0 ? 0 : slot) + 1, lead: slot === 0 }); } catch { /* UI hook */ }
        },
        onLeadEvent: config.onLeadEvent,
      }
    );
    for (const a of attempts) governor.record(a.result.usage.prompt + a.result.usage.completion + a.result.usage.reasoning, a.result.wallMs);
    attempts.forEach((a, j) => { a.index = indexBase + j + 1; });
    allAttempts = allAttempts.concat(attempts);

    // Did anything finish AND actually satisfy the prompt's ground-truth examples? "Finished" alone is
    // not enough — a candidate can pass its own finish gate yet be wrong on the worked examples, and
    // stopping here would just hand the verifier a slate of wrong answers to pick the least-bad from.
    // Keep a repair round in reserve for exactly this: finished-but-wrong seeds a grounded resample.
    const finished = attempts.filter((a) => a.result.finished);
    // Survive an interrupt with something to show for the time. Until the winner is adopted (far
    // below), every candidate lives in an isolated workspace and `cwd` is untouched — so a kill here
    // leaves the user with nothing, which is exactly what json_patch did after fifteen minutes.
    const checkpointed = checkpointCandidates(params.cwd, finished, round);
    if (checkpointed.length) receipts.push(`round ${round}: ${checkpointed.length} candidate(s) checkpointed to ${CHECKPOINT_DIR}/`);
    if (finished.some((a) => passesGroundTruth(a.workspace))) break;
    if (finished.length && workedExamples.length) receipts.push(`round ${round}: ${finished.length} finished but none pass the worked examples → repair`);
    if (round < maxRounds) {
      // Prefer a ground-truth failure as the repair seed (concrete got≠expected), else the error sig.
      let gtFailSeed = "";
      const failing = finished.find((a) => !passesGroundTruth(a.workspace));
      if (failing && pyModule) {
        const r = runExampleTest(failing.workspace, pyModule, workedExamples, setupVars);
        if (r.ran && r.failures.length) gtFailSeed = renderExampleFailures(r);
      }
      const worst = attempts.find((a) => errorSignatureOf(a)) ?? attempts[0];
      const errSig = worst ? errorSignatureOf(worst) : undefined;
      let webBrief = "";
      if (lever(config, "web") && config.webAugmentor && errSig) {
        const trigger = decideTrigger({ repairRound: round, errorSignature: errSig });
        if (trigger) {
          const brief = await config.webAugmentor.augment(trigger).catch(() => null);
          receipts.push(...webAugmentReceiptLines(brief));
          if (brief && brief.brief) webBrief = brief.brief;
        }
      }
      // A concrete got≠expected on a real example is the strongest repair signal — lead with it.
      const failReason = gtFailSeed ? `Your previous attempt finished but FAILED the task's own examples:\n${gtFailSeed}` : (errSig ?? "the previous attempt did not finish");

      // PDR (arXiv 2604.16529): condition the next round on a distilled summary of EVERY prior
      // attempt, not just the one failure that happened to be found first. Two candidates can fail
      // for two different reasons, and the second reason used to be discarded — which meant the
      // repair round could walk straight back into it. Reuse is cheaper than another rollout here:
      // a third candidate costs ~290 s on this hardware, this costs a few hundred prompt tokens.
      const digests = allAttempts.map((attempt) => distillAttempt(
        attempt,
        // Attach ground-truth evidence to the attempt it actually belongs to.
        attempt === failing && gtFailSeed ? gtFailSeed : undefined,
      ));
      const priorEvidence = digestsAreInformative(digests) ? renderDigests(digests) : "";
      if (priorEvidence) receipts.push(digestReceiptLine(digests));

      repairSeed = [repairDirective(failReason, worst?.plan.stance), priorEvidence, webBrief].filter(Boolean).join("\n\n");
      try { config.onProgress?.({ kind: "repair.started", round: round + 1, reason: failReason.slice(0, 300) }); } catch { /* advisory */ }
    }
  }

  // C1 — cascade: cut the field cheaply before the expensive execution verify.
  const cascadeCandidates: CascadeCandidate[] = allAttempts.map((a) => ({
    index: a.index, workspace: a.workspace, codeFiles: a.result.filesWritten.filter((f) => /\.(py|js|mjs|cjs)$/i.test(f)), trajectory: buildTrajectory(a), finished: a.result.finished
  }));
  let survivorIdx = allAttempts.map((a) => a.index);
  if (lever(config, "cascade") && allAttempts.length > 1) {
    const cas = await runCascade(cascadeCandidates, { orm: lever(config, "orm") ? config.orm ?? null : null, task: params.task });
    survivorIdx = cas.survivors;
    receipts.push(...cascadeReceiptLines(cas));
  }
  const survivorsByIndex = new Map(allAttempts.map((a) => [a.index, a]));
  const survivors = survivorIdx.map((i) => survivorsByIndex.get(i)!).filter(Boolean);

  // B — verify the survivors and select the winner. The prompt's worked examples are ground truth: a
  // candidate that fails them is ineligible regardless of consensus (real I/O beats model-generated votes).
  const verifier = new Verifier({
    llm: config.llm, task: params.task, contract, testCommand,
    // The unchanged project directory is the base every red-then-green screen is measured against.
    baseWorkspace: params.cwd,
    reproScript,
    behavioralChecks: contract.commands, probe, orm: lever(config, "orm") ? config.orm ?? null : null,
    confidence: lever(config, "confidence"), module: pyModule,
    workedExamples, workedModule: pyModule, setupVars,
    onCheck: (e) => { try { config.onProgress?.({ kind: "verification.evidence", ...e }); } catch { /* advisory */ } }
  });
  const candidates: Candidate[] = survivors.map((a) => ({ index: a.index, workspace: a.workspace, finished: a.result.finished, summary: a.result.summary, trajectory: buildTrajectory(a), selfCertainty: a.result.confidence?.selfCertainty }));
  try { config.onProgress?.({ kind: "verification.started", what: `verifying ${candidates.length} candidate(s) by execution` }); } catch { /* advisory */ }
  const verdict = await verifier.verify(candidates);
  receipts.push(...verifierReceiptLines(verdict));
  try {
    if (verdict.winner != null && verdict.winnerHasExecutionReceipt) {
      config.onProgress?.({ kind: "verification.passed", detail: `winner: attempt ${verdict.winner} via ${verdict.selector} (green execution receipt)` });
    } else if (verdict.winner == null) {
      config.onProgress?.({ kind: "verification.failed", detail: "no candidate was eligible (no execution evidence passed)" });
    }
    // winner-without-receipt = "checked, not verified" — neither a pass nor a failure; run.completed says it.
  } catch { /* advisory */ }

  for (const attempt of allAttempts) {
    const signal = verdict.slate.find((entry) => entry.index === attempt.index);
    const participated = survivorsByIndex.has(attempt.index);
    try {
      await config.onCandidate?.({
        phase: participated ? "completed" : "rejected",
        attempt,
        reason: participated ? undefined : "removed by cascade before verification",
      });
      if (participated && signal && !signal.executionEligible) {
        await config.onCandidate?.({ phase: "rejected", attempt, reason: signal.receipt.slice(-2).join("; ") || "failed execution eligibility" });
      }
    } catch { /* candidate cards are advisory and never change the grade */ }
  }

  const winnerAttempt = verdict.winner ? survivorsByIndex.get(verdict.winner) ?? null : null;
  // Clear the interrupt checkpoints BEFORE adopting: adoptWorkspace clears cwd and copies the
  // winner in, and a stale `.kitten-candidates/` left behind would be both litter and a liability
  // (the next run's checkpoint would be indistinguishable from this run's). A run that reaches this
  // line no longer needs them — the winner is about to land in cwd for real.
  if (winnerAttempt) clearCheckpoints(params.cwd);
  const adoptedFiles = winnerAttempt ? adoptWorkspace(params.cwd, winnerAttempt.workspace) : [];

  // A3 — remember a verifier-confirmed solve (disjoint by construction; admit() hard-fails on an eval id).
  if (winnerAttempt && verdict.winnerHasExecutionReceipt && lever(config, "experience") && config.experienceStore && params.taskId) {
    try {
      if (!registry.isEvalId(params.taskId)) {
        const { shape, files } = summarizeApproach("", winnerAttempt.result.summary);
        await config.experienceStore.admit({
          id: params.taskId, taskText: params.task, family, approachShape: shape,
          filesTouched: files.length ? files : winnerAttempt.result.filesWritten.slice(0, 6), verified: true
        });
        receipts.push(`experience: admitted this solve (${family})`);
      }
    } catch { /* disjointness/other — never blocks the run */ }
  }

  receipts.push(...governor.receiptLines());
  const usage = allAttempts.reduce((u, a) => ({ prompt: u.prompt + a.result.usage.prompt, completion: u.completion + a.result.usage.completion, reasoning: u.reasoning + a.result.usage.reasoning }), { prompt: 0, completion: 0, reasoning: 0 });
  const formatRescues = allAttempts.reduce((total, attempt) => total + (attempt.result.formatRescues ?? 0), 0);
  if (formatRescues > 0) receipts.push(`format rescues: ${formatRescues} optional structured-output constraint(s) removed after endpoint rejection`);

  const result: AscentResult = {
    finished: !!winnerAttempt && verdict.winnerHasExecutionReceipt,
    summary: winnerAttempt?.result.summary ?? "",
    adoptedFiles,
    winner: verdict.winner,
    selector: verdict.selector,
    winnerHasExecutionReceipt: verdict.winnerHasExecutionReceipt,
    family, samples, rounds: round, receipts, usage, ...(formatRescues ? { formatRescues } : {}), wallMs: Date.now() - started
  };

  // Measurement hook (D1): let a rig oracle-score every candidate workspace before they're removed.
  if (config.onVerified) { try { await config.onVerified({ attempts: allAttempts, verdict }); } catch { /* rig hook best-effort */ } }

  // Clean up isolated workspaces AFTER adopting the winner (and after the measurement hook).
  cleanupBurst(allAttempts);
  return result;
}
