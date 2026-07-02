// Durable worker plans, worker reports, and the controller file.
//
// The controller writes each worker a small .md plan; each finished worker leaves a compact
// .md report. controller.md holds the task summary, contract, decomposition, and next step.
// Together with the digest and the two ledgers these files ARE the run's memory: a respawned
// controller reconstructs the plot from disk (reconstructRunState) and never needs the dead
// session's chat. Reports are deliberately structured so they can be folded into the next
// capsule as one or two lines each.

import type { PromptCapsule } from "./promptCapsule.js";
import { readRunFile, runDirFor, writeRunFile } from "./runDir.js";
import { sanitizeReportText } from "./sanitize.js";
import { loadContract, type AcceptanceContract } from "./contract.js";
import { MutationLedger } from "./mutationLedger.js";
import { ValidationLedger } from "./validationLedger.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WorkerReport {
  workerRole: string;
  capsuleId?: string;
  summary: string;
  filesChanged: string[];
  commandsRun: string[];
  validationResults: string[];
  problems: string[];
  recommendedNextAction: string;
  contractSatisfied: "yes" | "no" | "unknown";
  needsAnotherWorker?: string;
}

/** Write workers/<role>.md - the worker's whole briefing, generated from its capsule. */
export function writeWorkerPlan(runDir: string, capsule: PromptCapsule): string {
  const lines: string[] = [];
  lines.push(`# Worker plan: ${capsule.workerRole}`);
  lines.push("");
  lines.push(`- capsule: ${capsule.capsuleId}`);
  lines.push(`- task: ${capsule.taskId}`);
  lines.push("");
  lines.push("## Goal");
  lines.push(capsule.workerGoal);
  if (capsule.nonGoals.length) {
    lines.push("");
    lines.push("## Non-goals");
    lines.push(...capsule.nonGoals.map((nonGoal) => `- ${nonGoal}`));
  }
  if (capsule.allowedFiles.length) {
    lines.push("");
    lines.push("## Allowed files");
    lines.push(...capsule.allowedFiles.map((file) => `- ${file}`));
  }
  if (capsule.acceptanceContract.length) {
    lines.push("");
    lines.push("## Acceptance");
    lines.push(...capsule.acceptanceContract.map((term) => `- ${term}`));
  }
  if (capsule.constraints.length) {
    lines.push("");
    lines.push("## Constraints");
    lines.push(...capsule.constraints.map((constraint) => `- ${constraint}`));
  }
  if (capsule.validationPlan.length) {
    lines.push("");
    lines.push("## Validation");
    lines.push(...capsule.validationPlan.map((step) => `- ${step}`));
  }
  lines.push("");
  lines.push("## Report format");
  lines.push(...capsule.outputInstructions.map((instruction) => `- ${instruction}`));
  return writeRunFile(runDir, `workers/${capsule.workerRole}.md`, lines.join("\n") + "\n");
}

/**
 * Write reports/<role>-report.md and return the compact one-line digest for capsules.
 * Model-authored fields pass through poison prevention first: thinking blocks stripped,
 * repeated lines compressed, code dumps truncated, hard length caps - a poisoned report
 * would otherwise be re-injected into every future capsule.
 */
export function writeWorkerReport(runDir: string, rawReport: WorkerReport): { path: string; compactLine: string } {
  const report: WorkerReport = {
    ...rawReport,
    summary: sanitizeReportText(rawReport.summary, 1600),
    problems: rawReport.problems.map((problem) => sanitizeReportText(problem, 300)),
    validationResults: rawReport.validationResults.map((result) => sanitizeReportText(result, 300)),
    recommendedNextAction: sanitizeReportText(rawReport.recommendedNextAction, 300)
  };
  const lines: string[] = [];
  lines.push(`# Worker report: ${report.workerRole}`);
  lines.push("");
  if (report.capsuleId) lines.push(`- capsule: ${report.capsuleId}`);
  lines.push(`- contract satisfied: ${report.contractSatisfied}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(report.summary.slice(0, 800) || "(none)");
  lines.push("");
  lines.push("## Files changed");
  lines.push(...(report.filesChanged.length ? report.filesChanged.map((file) => `- ${file}`) : ["- (none)"]));
  lines.push("");
  lines.push("## Commands run");
  lines.push(...(report.commandsRun.length ? report.commandsRun.slice(0, 10).map((command) => `- ${command.slice(0, 160)}`) : ["- (none)"]));
  lines.push("");
  lines.push("## Validation");
  lines.push(...(report.validationResults.length ? report.validationResults.map((result) => `- ${result.slice(0, 200)}`) : ["- (none run)"]));
  if (report.problems.length) {
    lines.push("");
    lines.push("## Problems / remaining risks");
    lines.push(...report.problems.slice(0, 6).map((problem) => `- ${problem.slice(0, 200)}`));
  }
  lines.push("");
  lines.push("## Recommended next action");
  lines.push(report.recommendedNextAction.slice(0, 300) || "(none)");
  if (report.needsAnotherWorker) {
    lines.push("");
    lines.push(`## Needs another worker`);
    lines.push(report.needsAnotherWorker.slice(0, 200));
  }
  const path = writeRunFile(runDir, `reports/${report.workerRole}-report.md`, lines.join("\n") + "\n");
  const compactLine =
    `${report.workerRole}: ${report.contractSatisfied === "yes" ? "done" : report.contractSatisfied === "no" ? "NOT satisfied" : "unclear"}; ` +
    `${report.filesChanged.length ? `changed ${report.filesChanged.slice(0, 3).join(", ")}` : "no file changes"}; ` +
    `next: ${report.recommendedNextAction.slice(0, 100) || "none"}`;
  return { path, compactLine };
}

export interface ControllerFileInput {
  taskId: string;
  goal: string;
  contractSummary: string;
  planSummary: string;
  workerDecomposition: Array<{ role: string; goal: string; status: string }>;
  globalConstraints: string[];
  phaseLine: string;
  status: string;
  nextStep: string;
}

/** Write controller.md - the controller's own durable brain. */
export function writeControllerFile(runDir: string, input: ControllerFileInput): string {
  const lines: string[] = [];
  lines.push(`# Controller: ${input.taskId}`);
  lines.push("");
  lines.push("## Task");
  lines.push(input.goal.slice(0, 400));
  lines.push("");
  lines.push("## Acceptance contract");
  lines.push(input.contractSummary);
  lines.push("");
  lines.push("## Plan");
  lines.push(input.planSummary.slice(0, 600));
  if (input.workerDecomposition.length) {
    lines.push("");
    lines.push("## Workers");
    for (const worker of input.workerDecomposition.slice(0, 10)) {
      lines.push(`- [${worker.status}] ${worker.role}: ${worker.goal.slice(0, 120)}`);
    }
  }
  if (input.globalConstraints.length) {
    lines.push("");
    lines.push("## Global constraints");
    lines.push(...input.globalConstraints.slice(0, 8).map((constraint) => `- ${constraint.slice(0, 140)}`));
  }
  lines.push("");
  lines.push("## Phase / budget");
  lines.push(input.phaseLine);
  lines.push("");
  lines.push(`## Status: ${input.status}`);
  lines.push("");
  lines.push("## Next orchestration step");
  lines.push(input.nextStep.slice(0, 300));
  return writeRunFile(runDir, "controller.md", lines.join("\n") + "\n");
}

export interface ReconstructedRun {
  taskId: string;
  runDir: string;
  controllerMd: string | null;
  workspaceDigest: string | null;
  contract: AcceptanceContract | null;
  mutations: MutationLedger;
  validations: ValidationLedger;
  reportFiles: string[];
  latestReports: string[];
}

/**
 * Context reincarnation: rebuild everything a respawned controller needs from disk.
 * The dead session's chat context is not required and not wanted.
 */
export function reconstructRunState(repoRoot: string, taskId: string): ReconstructedRun {
  const runDir = runDirFor(repoRoot, taskId);
  const reportsDir = join(runDir, "reports");
  let reportFiles: string[] = [];
  if (existsSync(reportsDir)) {
    try {
      reportFiles = readdirSync(reportsDir).filter((name) => name.endsWith(".md")).sort();
    } catch {
      reportFiles = [];
    }
  }
  const latestReports = reportFiles
    .slice(-4)
    .map((name) => readRunFile(runDir, `reports/${name}`) ?? "")
    .filter(Boolean)
    .map((text) => text.slice(0, 900));
  return {
    taskId,
    runDir,
    controllerMd: readRunFile(runDir, "controller.md"),
    workspaceDigest: readRunFile(runDir, "workspace-digest.md"),
    contract: loadContract(runDir),
    mutations: MutationLedger.load(runDir),
    validations: ValidationLedger.load(runDir),
    reportFiles,
    latestReports
  };
}

/** Compact re-briefing for a respawned controller, built purely from durable files. */
export function renderReincarnationBrief(run: ReconstructedRun, maxChars = 4000): string {
  const lines: string[] = [];
  lines.push(`Resuming task ${run.taskId} from durable state (previous controller context is gone and not needed).`);
  if (run.controllerMd) {
    lines.push("");
    lines.push(run.controllerMd.slice(0, 1400));
  }
  if (run.workspaceDigest) {
    lines.push("");
    lines.push(run.workspaceDigest.slice(0, 1200));
  }
  const validationLines = run.validations.renderSummaryLines();
  if (validationLines.length) {
    lines.push("");
    lines.push(...validationLines);
  }
  if (run.latestReports.length) {
    lines.push("");
    lines.push(`Latest worker reports: ${run.reportFiles.slice(-4).join(", ")} (in ${run.runDir})`);
  }
  const text = lines.join("\n");
  return text.length <= maxChars ? text : text.slice(0, maxChars - 12) + "\n[clipped]";
}
