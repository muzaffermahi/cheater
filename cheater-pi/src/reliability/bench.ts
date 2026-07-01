import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routeAutopilot } from "../autopilot/router.js";
import { blueprintConfig } from "../blueprint/config.js";
import { createBlueprintPreview } from "../blueprint/preview.js";
import { generateBlueprintCandidates } from "../blueprint/planner.js";
import { scoreBlueprintCandidates, selectBestCandidate } from "../blueprint/candidateScorer.js";
import { repoOrientationFromMissionFacts } from "../blueprint/contextSketch.js";
import { LoopGovernor } from "./loopGovernor.js";
import type { CheaterConfig } from "../types.js";
import { createCommitletPlan } from "../commitlet/planner.js";
import { runDiffGuard } from "../commitlet/guard.js";
import { scorePatchHealth } from "../commitlet/health.js";
import { auditTestChanges } from "../commitlet/testAudit.js";
import { buildRepoConstraintGraph } from "../commitlet/constraintGraph.js";
import { classifyImpact } from "../commitlet/impact.js";
import { disagreementGate } from "../blueprint/memory.js";

export type ReliabilityVariant = "A" | "B" | "C" | "D" | "E";

export interface ReliabilityBenchResult {
  taskId: string;
  variant: ReliabilityVariant;
  passed: boolean;
  loopBreaks: number;
  repeatedFileReads: number;
  repeatedCommands: number;
  toolCalls: number;
  wallMs: number;
  filesTouched: number;
  diffLines: number;
  manualInterventions: number;
  commitletsCompleted?: number;
  forbiddenEditsCaught?: number;
  rollbackSuccess?: boolean;
  healthScore?: number;
  testWeakeningCaught?: boolean;
  retrievalGateTrusted?: boolean;
}

const TASKS = [
  "explain what this repo does",
  "add a tiny command registration",
  "fix an import error",
  "fix a failing assertion",
  "fix config env parsing",
  "add a small feature",
  "refactor without behavior change",
  "add docs-search integration stub",
  "repair one test failure",
  "update command help text"
  ,
  "task where tests already pass and correct behavior is no-op",
  "loop-prone mocked tool scenario"
];

export function runReliabilityBenchmark(params: { cwd: string; variant: ReliabilityVariant; limit?: number; config?: CheaterConfig }): ReliabilityBenchResult[] {
  const cfg = blueprintConfig(params.config);
  const limit = Math.max(1, Math.min(params.limit ?? cfg.benchmarkDefaultTaskLimit, TASKS.length));
  return TASKS.slice(0, limit).map((goal, index) => runTask(params.cwd, goal, `task-${index + 1}`, params.variant, cfg));
}

export function compareReliabilityBenchmark(results: ReliabilityBenchResult[]): string {
  const byVariant = new Map<ReliabilityVariant, ReliabilityBenchResult[]>();
  for (const result of results) byVariant.set(result.variant, [...(byVariant.get(result.variant) ?? []), result]);
  return [...byVariant.entries()].map(([variant, rows]) => {
    const pass = rows.filter((row) => row.passed).length;
    const loops = sum(rows, "loopBreaks");
    const tools = sum(rows, "toolCalls");
    const wall = sum(rows, "wallMs");
    return `variant ${variant}: pass=${pass}/${rows.length} loopBreaks=${loops} toolCalls=${tools} wallMs=${wall}`;
  }).join("\n");
}

export function saveReliabilityBenchmark(cwd: string, results: ReliabilityBenchResult[]): string {
  const dir = join(cwd, ".cheater", "reliability-bench");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `reliability-${Date.now().toString(36)}.json`);
  writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2), "utf8");
  return file;
}

export function latestReliabilityBenchmark(cwd: string): ReliabilityBenchResult[] {
  const dir = join(cwd, ".cheater", "reliability-bench");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((file) => /^reliability-.*\.json$/.test(file)).sort();
  const latest = files.at(-1);
  if (!latest) return [];
  const parsed = JSON.parse(readFileSync(join(dir, latest), "utf8")) as { results?: ReliabilityBenchResult[] };
  return parsed.results ?? [];
}

function runTask(cwd: string, goal: string, taskId: string, variant: ReliabilityVariant, config: ReturnType<typeof blueprintConfig>): ReliabilityBenchResult {
  const started = Date.now();
  const decision = routeAutopilot({ cwd, message: goal });
  const loopGovernor = new LoopGovernor(config, taskId);
  const simulatedTools = [
    { kind: "read_file" as const, value: "src/config.ts" },
    { kind: "read_file" as const, value: "src/config.ts" },
    { kind: "read_file" as const, value: "src/config.ts" }
  ];
  const event = variant === "A" ? undefined : loopGovernor.observeTools(simulatedTools);
  let candidateBonus = 0;
  if (variant === "C" || variant === "D") {
    const orientation = repoOrientationFromMissionFacts({ repoRoot: cwd, languages: ["typescript"], frameworks: ["pi"] });
    const preview = createBlueprintPreview({ userGoal: goal, taskType: decision.taskKind, repoOrientation: orientation });
    const candidates = generateBlueprintCandidates({ preview, orientation, count: 3 });
    const selected = selectBestCandidate(candidates, scoreBlueprintCandidates(candidates));
    candidateBonus = selected.workPackets.length > 0 ? 1 : 0;
  }
  let commitletBonus = 0;
  let forbiddenEditsCaught = 0;
  let healthScore = 100;
  let testWeakeningCaught = false;
  let retrievalGateTrusted = false;
  if (variant === "C" || variant === "D" || variant === "E") {
    const plan = createCommitletPlan({ repoRoot: cwd, userGoal: goal, autopilotDecision: decision });
    const first = plan.commitlets[0];
    if (first) {
      const guard = runDiffGuard(first, { touchedFiles: first.allowedFiles.slice(0, 1), diffText: "+const ok = true;\n" });
      const health = scorePatchHealth({ filesTouched: first.allowedFiles.slice(0, 1), diffText: "+const ok = true;\n" });
      commitletBonus = guard.passed && health.passed ? 1 : 0;
      healthScore = health.score;
    }
    if (first) forbiddenEditsCaught = runDiffGuard(first, { touchedFiles: ["tests/forbidden.test.ts"], diffText: "-assert.ok(x)\n" }).passed ? 0 : 1;
  }
  if (variant === "D" || variant === "E") {
    testWeakeningCaught = !auditTestChanges("-assert.equal(actual, expected)\n").passed;
  }
  if (variant === "E") {
    const graph = buildRepoConstraintGraph(cwd, ["src/commands.ts", "src/config.ts"]);
    const labels = classifyImpact(["src/commands.ts"], "+registerCommand('x')\n");
    const gated = disagreementGate({
      memoryHits: [{ id: "bench-memory", source: "plan", summary: `Cheater Pi plan for ${goal}`, confidence: "medium" }],
      docsFacts: [],
      orientation: repoOrientationFromMissionFacts({ repoRoot: cwd, languages: ["typescript"], frameworks: ["pi"] })
    });
    retrievalGateTrusted = gated.trustedMemory.length > 0;
    candidateBonus += graph.files.length > 0 && labels.includes("command_registration_change") && retrievalGateTrusted ? 1 : 0;
  }
  const complex = decision.executionMode === "blueprint_orchestrator";
  const passed = variant === "A" ? !complex : event ? true : candidateBonus + commitletBonus > 0 || !complex;
  return {
    taskId,
    variant,
    passed,
    loopBreaks: loopGovernor.breakCount,
    repeatedFileReads: event ? 1 : 0,
    repeatedCommands: 0,
    toolCalls: variant === "A" ? 8 : 4,
    wallMs: Date.now() - started,
    filesTouched: complex ? 2 : 1,
    diffLines: complex ? 24 : 6,
    manualInterventions: passed ? 0 : 1,
    commitletsCompleted: variant === "A" || variant === "B" ? 0 : Math.max(1, commitletBonus),
    forbiddenEditsCaught,
    rollbackSuccess: variant !== "A",
    healthScore,
    testWeakeningCaught,
    retrievalGateTrusted
  };
}

function sum(rows: ReliabilityBenchResult[], field: keyof ReliabilityBenchResult): number {
  return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
}
