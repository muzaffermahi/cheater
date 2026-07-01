import type { ClassificationResult, Mission, OracleReport, Playbook, ProjectFacts, ReproResult } from "./types.js";

const DASHBOARD_LIMIT = 60;

function truncate(value: string, limit = DASHBOARD_LIMIT): string {
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

export function formatMissionDashboard(mission: Mission): string {
  const lines: string[] = [];
  lines.push(`Cheater mission ${mission.id.slice(0, 8)}`);
  lines.push(`type: ${mission.missionType}    status: ${mission.status}    step: ${mission.currentStep}`);
  if (mission.classification) {
    lines.push(`classification: ${mission.classification.missionType} (conf ${mission.classification.confidence}, risk ${mission.classification.risk})`);
  }
  if (mission.playbook) {
    lines.push(`playbook: ${mission.playbook.name}`);
  }
  if (mission.repro) {
    lines.push(`repro: ${summarizeRepro(mission.repro)}`);
  } else {
    lines.push(`repro: pending`);
  }
  if (mission.evidence) {
    lines.push(`evidence: ${mission.evidence.memoryHits.length} memory hit(s), confidence ${mission.evidence.confidence}`);
  } else {
    lines.push(`evidence: pending`);
  }
  if (mission.verification) {
    lines.push(`oracle: ${summarizeOracle(mission.verification)}`);
  } else {
    lines.push(`oracle: pending`);
  }
  if (mission.commandsRun.length) lines.push(`commands: ${truncate(mission.commandsRun.join(" | "), 120)}`);
  if (mission.filesTouched.length) lines.push(`files: ${truncate(mission.filesTouched.join(", "), 120)}`);
  if (mission.testsRun.length) lines.push(`tests: ${truncate(mission.testsRun.join(", "), 120)}`);
  if (mission.riskFlags.length) lines.push(`risk flags: ${mission.riskFlags.join(", ")}`);
  if (mission.learned.length) lines.push(`learned: ${truncate(mission.learned.join(" | "), 120)}`);
  return lines.join("\n");
}

export function summarizeRepro(repro: ReproResult): string {
  if (repro.alreadyPassing) return `passing (exit ${repro.exitCode}) -> no change needed`;
  if (repro.environmentFailure) return `environment failure: ${repro.summary}`;
  if (repro.reproduced) return `reproduced (${repro.failureKind}) failing=${repro.failingTests.length} files=${repro.topStackFiles.length}`;
  return `not reproduced: ${repro.summary || repro.failureKind}`;
}

export function summarizeOracle(report: OracleReport): string {
  const status: string[] = [];
  if (report.focusedTestsOk === true) status.push("focused ok");
  if (report.focusedTestsOk === false) status.push("focused FAIL");
  if (report.typecheckOk === true) status.push("typecheck ok");
  if (report.typecheckOk === false) status.push("typecheck FAIL");
  if (report.lintOk === true) status.push("lint ok");
  if (report.lintOk === false) status.push("lint FAIL");
  if (report.broadTestsOk === true) status.push("broad ok");
  if (report.broadTestsOk === false) status.push("broad FAIL");
  return status.length ? status.join(", ") : report.summary;
}

export function formatClassification(result: ClassificationResult): string {
  return [
    `mission: ${result.missionType} (conf ${result.confidence}, risk ${result.risk})`,
    `shouldPatch: ${result.shouldPatch}    needsRepro: ${result.needsRepro}`,
    `why: ${result.why}`,
    `next:`,
    ...result.recommendedFirstSteps.map((step) => `  - ${step}`)
  ].join("\n");
}

export function formatPlaybook(playbook: Playbook): string {
  return [
    `playbook: ${playbook.name}`,
    `trigger: ${playbook.trigger}`,
    `steps:`,
    ...playbook.steps.map((step) => `  - ${step}`),
    `allowed: ${playbook.allowedTools.join(", ")}`,
    `forbidden: ${playbook.forbiddenActions.join("; ")}`,
    `verification: ${playbook.verification.join("; ") || "(none)"}`
  ].join("\n");
}

export function formatOrientation(facts: ProjectFacts): string {
  return [
    `orientation: ${facts.repoRoot}`,
    `languages: ${facts.languages.join(", ") || "(unknown)"}`,
    `frameworks: ${facts.frameworks.join(", ") || "(none detected)"}`,
    `package managers: ${facts.packageManagers.join(", ") || "(unknown)"}`,
    `test commands: ${facts.testCommands.join(", ") || "(none)"}`,
    `lint commands: ${facts.lintCommands.join(", ") || "(none)"}`,
    `typecheck commands: ${facts.typecheckCommands.join(", ") || "(none)"}`,
    `entrypoints: ${facts.entrypoints.join(", ") || "(none)"}`,
    `important paths: ${facts.importantPaths.join(", ") || "(none)"}`,
    `do not touch: ${facts.doNotTouch.join(", ")}`,
    `last updated: ${facts.lastUpdated}`
  ].join("\n");
}
