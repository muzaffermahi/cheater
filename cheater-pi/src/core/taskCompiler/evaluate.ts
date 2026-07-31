// Task Compiler — evaluation harness.
//
// The compiler must not be declared universally successful. The report is explicit that a layer which
// improves vague feature prompts can HURT precise bug reports, so the comparison is per-arm AND
// per-family, and the output is a table of facts — never one aggregate "it works" number.
//
//   arm A `raw`      — the user's request, unmodified (today's behavior)
//   arm B `contract` — a structured contract with NO repository reads
//   arm C `grounded` — the full repository-grounded compiled task (production)
//
// Two classes of metric, deliberately separated because they cost different things to obtain:
//
//   COMPILE-SIDE metrics need no model and are measured here and now: prompt tokens, evidence used,
//   clarification rate, mode distribution, and — the one that actually matters — INVENTED
//   REQUIREMENTS, counted against each fixture's declared forbidden vocabulary.
//
//   RUNTIME metrics (verified completion, main-model calls, repair iterations, wall clock) require
//   live inference on real tasks. They are supplied by a driver through `EvaluationOutcome`; this
//   module aggregates and renders them but never fabricates them. A missing outcome renders as "—",
//   not as a zero that would quietly read as a measurement.

import { compileTask, type TaskCompilerFlag } from "./compile.js";
import { approxTokens, type CompilationMode, type TaskFamily } from "./ir.js";

export type EvaluationArm = "raw" | "contract" | "grounded";
export const EVALUATION_ARMS: readonly EvaluationArm[] = ["raw", "contract", "grounded"];

export interface EvaluationCase {
  id: string;
  request: string;
  /** The family this case is expected to compile to — a family drift is itself a regression. */
  expectedFamily: TaskFamily;
  /** Terms that must NEVER appear in a rendered contract for this case: the invented-feature probe. */
  forbiddenTerms: readonly string[];
  /** True when the request is already a precise contract, so arm C must not inflate it. */
  precise?: boolean;
  /** True when the request is genuinely unanswerable and a clarification is the correct outcome. */
  expectsClarification?: boolean;
}

/** Runtime results for one case/arm, supplied by a driver that actually ran the model. */
export interface EvaluationOutcome {
  caseId: string;
  arm: EvaluationArm;
  verified: boolean;
  firstPatchVerified: boolean;
  mainModelCalls: number;
  repairIterations: number;
  promptTokens: number;
  reasoningTokens: number;
  answerTokens: number;
  wallMs: number;
  malformedToolCalls: number;
  incorrectFileSelections: number;
  userCorrections: number;
}

export interface CompileSideMeasurement {
  caseId: string;
  arm: EvaluationArm;
  family: TaskFamily;
  familyMatchedExpectation: boolean;
  mode: CompilationMode;
  requestTokens: number;
  contractTokens: number;
  /** contract ÷ request. >1 means the compiler ADDED tokens; for a precise case that is a failure. */
  inflation: number;
  evidenceCount: number;
  repositoryQueries: number;
  assumptionCount: number;
  /** Material ambiguities found. A precise request that names a MISSING file legitimately acquires
   *  one — the compiler escalating there is correct, not inflation, and the metric must not conflate
   *  the two (running the fixtures against an unrelated repository is exactly how that shows up). */
  materialAmbiguities: number;
  clarificationRequested: boolean;
  clarificationCorrect: boolean;
  /** Forbidden terms that leaked into the rendered contract. Any hit is a hard failure. */
  inventedTerms: string[];
  compileMs: number;
}

export interface ArmSummary {
  arm: EvaluationArm;
  cases: number;
  medianContractTokens: number;
  medianInflation: number;
  clarificationRate: number;
  /** Cases where the compiler invented at least one forbidden term. Must be 0. */
  inventedRequirementCases: number;
  familyMisclassifications: number;
  /** Precise cases that were inflated instead of passed through. Must be 0 for arm C. */
  inflatedPreciseCases: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Render the prompt block an arm would inject. Arm A injects nothing — that is the baseline. */
export function renderArm(testCase: EvaluationCase, cwd: string, arm: EvaluationArm, flag: TaskCompilerFlag = "auto"): { block: string; measurement: CompileSideMeasurement } {
  const requestTokens = approxTokens(testCase.request);
  if (arm === "raw") {
    return {
      block: "",
      measurement: {
        caseId: testCase.id, arm, family: testCase.expectedFamily, familyMatchedExpectation: true,
        mode: "passthrough", requestTokens, contractTokens: 0, inflation: 0,
        evidenceCount: 0, repositoryQueries: 0, assumptionCount: 0, materialAmbiguities: 0,
        clarificationRequested: false, clarificationCorrect: !testCase.expectsClarification,
        inventedTerms: [], compileMs: 0,
      },
    };
  }
  const result = compileTask({
    taskId: `eval_${testCase.id}_${arm}`,
    request: testCase.request,
    cwd,
    flag,
    groundingEnabled: arm === "grounded",
  });
  const block = result.contractBlock;
  const lower = block.toLowerCase();
  const inventedTerms = testCase.forbiddenTerms.filter((term) => lower.includes(term.toLowerCase()));
  const contractTokens = approxTokens(block);
  return {
    block,
    measurement: {
      caseId: testCase.id, arm,
      family: result.task.family,
      familyMatchedExpectation: result.task.family === testCase.expectedFamily,
      mode: result.task.compilationMode,
      requestTokens,
      contractTokens,
      inflation: requestTokens > 0 ? contractTokens / requestTokens : 0,
      evidenceCount: result.telemetry.evidenceCount,
      repositoryQueries: result.telemetry.repositoryQueries,
      assumptionCount: result.telemetry.assumptionCount,
      materialAmbiguities: result.telemetry.ambiguityCounts.material ?? 0,
      clarificationRequested: result.telemetry.clarificationRequested,
      clarificationCorrect: result.telemetry.clarificationRequested === Boolean(testCase.expectsClarification),
      inventedTerms,
      compileMs: result.telemetry.totalMs,
    },
  };
}

/** Measure every case against every arm. No model required. */
export function measureCompileSide(cases: readonly EvaluationCase[], cwd: string): CompileSideMeasurement[] {
  const out: CompileSideMeasurement[] = [];
  for (const testCase of cases) {
    for (const arm of EVALUATION_ARMS) out.push(renderArm(testCase, cwd, arm).measurement);
  }
  return out;
}

export function summarizeArm(measurements: readonly CompileSideMeasurement[], cases: readonly EvaluationCase[], arm: EvaluationArm): ArmSummary {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rows = measurements.filter((m) => m.arm === arm);
  return {
    arm,
    cases: rows.length,
    medianContractTokens: median(rows.map((r) => r.contractTokens)),
    medianInflation: median(rows.map((r) => r.inflation)),
    clarificationRate: rows.length ? rows.filter((r) => r.clarificationRequested).length / rows.length : 0,
    inventedRequirementCases: rows.filter((r) => r.inventedTerms.length > 0).length,
    familyMisclassifications: rows.filter((r) => !r.familyMatchedExpectation).length,
    // Only counted when the compiler had NO reason to intervene. A precise request whose named file
    // is absent produces a material ambiguity, and grounding it is the correct outcome.
    inflatedPreciseCases: rows.filter((r) => byId.get(r.caseId)?.precise && r.contractTokens > 0 && r.materialAmbiguities === 0).length,
  };
}

/** Per-family breakdown, because an arm that helps one family can hurt another. */
export function summarizeByFamily(measurements: readonly CompileSideMeasurement[], arm: EvaluationArm): Map<TaskFamily, { cases: number; medianContractTokens: number; medianInflation: number }> {
  const out = new Map<TaskFamily, { cases: number; medianContractTokens: number; medianInflation: number }>();
  const rows = measurements.filter((m) => m.arm === arm);
  const families = [...new Set(rows.map((r) => r.family))];
  for (const family of families) {
    const familyRows = rows.filter((r) => r.family === family);
    out.set(family, {
      cases: familyRows.length,
      medianContractTokens: median(familyRows.map((r) => r.contractTokens)),
      medianInflation: median(familyRows.map((r) => r.inflation)),
    });
  }
  return out;
}

export function renderEvaluation(
  measurements: readonly CompileSideMeasurement[],
  cases: readonly EvaluationCase[],
  outcomes: readonly EvaluationOutcome[] = [],
): string {
  const lines = [
    "── Task Compiler evaluation — compile-side (no model required) ──────────────",
    "  arm        cases  contract tok  inflation  clarify%  invented  misfamily  inflated-precise",
  ];
  for (const arm of EVALUATION_ARMS) {
    const s = summarizeArm(measurements, cases, arm);
    lines.push(
      `  ${arm.padEnd(9)}  ${String(s.cases).padStart(5)}  ${String(s.medianContractTokens).padStart(12)}  ` +
      `${s.medianInflation.toFixed(2).padStart(9)}  ${(100 * s.clarificationRate).toFixed(0).padStart(7)}%  ` +
      `${String(s.inventedRequirementCases).padStart(8)}  ${String(s.familyMisclassifications).padStart(9)}  ` +
      `${String(s.inflatedPreciseCases).padStart(16)}`,
    );
  }
  lines.push("", "  per-family (arm: grounded)");
  for (const [family, stats] of summarizeByFamily(measurements, "grounded")) {
    lines.push(`    ${family.padEnd(26)} n=${String(stats.cases).padStart(2)}  tok=${String(stats.medianContractTokens).padStart(4)}  x${stats.medianInflation.toFixed(2)}`);
  }

  lines.push("", "── runtime (requires live inference; supplied by a driver) ──────────────────");
  if (!outcomes.length) {
    // Say plainly that these were not measured. A zero here would read as a result.
    lines.push("  not measured in this run — verified%, main-model calls, repairs and wall clock");
    lines.push("  require running the arms against a real model on real tasks.");
  } else {
    lines.push("  arm        verified%  first-patch%  main calls  repairs  wall(s)");
    for (const arm of EVALUATION_ARMS) {
      const rows = outcomes.filter((o) => o.arm === arm);
      if (!rows.length) { lines.push(`  ${arm.padEnd(9)}  ${"—".padStart(9)}`); continue; }
      const mean = (pick: (o: EvaluationOutcome) => number): number => rows.reduce((n, o) => n + pick(o), 0) / rows.length;
      lines.push(
        `  ${arm.padEnd(9)}  ${(100 * mean((o) => (o.verified ? 1 : 0))).toFixed(0).padStart(8)}%  ` +
        `${(100 * mean((o) => (o.firstPatchVerified ? 1 : 0))).toFixed(0).padStart(11)}%  ` +
        `${mean((o) => o.mainModelCalls).toFixed(1).padStart(10)}  ${mean((o) => o.repairIterations).toFixed(1).padStart(7)}  ` +
        `${(mean((o) => o.wallMs) / 1000).toFixed(1).padStart(7)}`,
      );
    }
  }
  lines.push("─".repeat(78));
  return lines.join("\n");
}

/**
 * The evaluation fixtures. Small, hand-checked, and chosen to cover the required families plus the
 * behaviors that separate a compiler from a rewriter. `forbiddenTerms` is the invented-feature probe:
 * plausible additions a helpful-but-wrong compiler would reach for.
 */
export const EVALUATION_FIXTURES: readonly EvaluationCase[] = [
  {
    id: "bug-health-500",
    request: "The /health endpoint in src/export.ts returns 500 instead of 200. Fix it.",
    expectedFamily: "bug_fix",
    forbiddenTerms: ["authentication", "rate limit", "monitoring", "alerting", "kubernetes"],
  },
  {
    id: "feature-markdown-export",
    request: "Add Markdown export for the active conversation. Keep the existing JSON export working.",
    expectedFamily: "feature_implementation",
    forbiddenTerms: ["pdf", "docx", "analytics", "authentication", "cloud sync"],
  },
  {
    id: "refactor-export-dedup",
    request: "Refactor src/export.ts to remove the duplicated formatting logic without changing behavior.",
    expectedFamily: "refactor",
    forbiddenTerms: ["rewrite in", "new architecture", "microservice", "dependency injection framework"],
  },
  {
    id: "investigate-retry-budget",
    request: "Where is the retry budget enforced?",
    expectedFamily: "repository_investigation",
    forbiddenTerms: ["implement", "refactor", "add a test", "fix"],
  },
  {
    id: "vague-dino-game",
    request: "Create a dinosaur jumping game.",
    expectedFamily: "new_application",
    forbiddenTerms: ["sound", "achievement", "leaderboard", "account", "level select", "settings menu", "mobile controls", "asset pipeline"],
  },
  {
    id: "precise-export-empty",
    request: "In src/export.ts, exportJson must return an empty object literal when the conversation has no messages. Do not change the function signature. Verify with `npm test` and confirm the typecheck passes.",
    expectedFamily: "feature_implementation",
    forbiddenTerms: ["logging", "caching", "authentication"],
    precise: true,
  },
  {
    id: "contradiction-endpoint",
    request: "You must add a new endpoint for user search. Do not add a new endpoint.",
    expectedFamily: "feature_implementation",
    forbiddenTerms: [],
    expectsClarification: true,
  },
  {
    id: "tests-for-export",
    request: "Write tests for the export service.",
    expectedFamily: "test_creation",
    forbiddenTerms: ["end-to-end browser", "load testing", "mutation testing", "100% coverage"],
  },
];
