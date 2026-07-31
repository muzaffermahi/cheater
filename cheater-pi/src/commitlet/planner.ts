import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AutopilotDecision } from "../autopilot/types.js";
import type { BlueprintPlan, WorkPacket } from "../blueprint/types.js";
import { splitPacketsByTouchedFile } from "../reliability/perFilePackets.js";
import { defaultVerificationCommand } from "../reliability/projectCommands.js";
import { commitletConfig } from "./config.js";
import { forgeCommitletSpec } from "./spec.js";
import { selectSingleFileForGoal } from "./constraintGraph.js";
import type { Commitlet, CommitletHealthBudget, CommitletPlan, CommitletPlanInput, VerificationStep } from "./types.js";
import { verificationFromBlueprint, workPacketToAllowedFiles } from "./types.js";
import { emptyHealthReport } from "./health.js";
import { globalConstraintsFor } from "../runstate/repoIdentity.js";
import { isManifestPath, installCommandForManifest, type ScaffoldFile } from "../blueprint/scaffold.js";

export function createCommitletPlan(input: CommitletPlanInput): CommitletPlan {
  const projectTestCommand = defaultVerificationCommand(input.repoRoot);
  const commitlets = input.commitlets && input.commitlets.length
    ? input.commitlets
    : input.blueprintPlan
      ? commitletsFromBlueprint(input.blueprintPlan, input.autopilotDecision)
      : commitletsFromDecision(input.userGoal, input.autopilotDecision, projectTestCommand, input.repoRoot);
  const finalVerification = mergeFinalVerification(commitlets);
  const plan: CommitletPlan = {
    id: `commitlet-plan-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    repoRoot: input.repoRoot,
    userGoal: input.userGoal,
    summary: summarize(input.autopilotDecision, commitlets.length),
    commitlets,
    currentIndex: 0,
    status: "planning",
    // Cheater-dev constraints (Pi wrapper, Pi owns the loop) apply ONLY to Cheater's own repo; any
    // other project gets stack-agnostic guidance so the model builds THAT app, not a Pi extension.
    globalConstraints: globalConstraintsFor(input.repoRoot),
    finalVerification,
    finalReview: {
      accepted: false,
      summary: "Final review has not run.",
      commitlets: [],
      finalVerification,
      health: emptyHealthReport(),
      blockingIssues: ["Commitlet plan has not completed."],
      warnings: [],
      suggestedFollowups: []
    },
    risk: input.autopilotDecision.risk,
    autopilotDecision: input.autopilotDecision,
    blueprintPlanId: input.blueprintPlan?.id,
    buildMode: input.buildMode ?? "surgical"
  };
  return {
    ...plan,
    commitlets: plan.commitlets.map((commitlet) => ({
      ...commitlet,
      spec: forgeCommitletSpec(commitlet, input.autopilotDecision.taskKind, input.userGoal)
    }))
  };
}

export function commitletsFromBlueprint(plan: BlueprintPlan, decision: AutopilotDecision): Commitlet[] {
  const packets = splitPacketsByTouchedFile(plan.workPackets, 1).filter((packet) => packet.type !== "inspect" && packet.type !== "review");
  return packets.map((packet, index) => commitletFromPacket(packet, index, decision));
}

// Files a verification failure explicitly NAMES (compiler/test errors like `consumer.ts(12,5)` or
// `src/api.ts:3:10`). Used to break the coupled-file deadlock (M2): when a scoped edit fails a
// typecheck because a DIFFERENT file must change too, the repair may touch the named file. Filtered
// to real relative source paths, never tests/node_modules, capped so a repair can't sprawl.
export function filesNamedInFailure(text: string): string[] {
  const files = new Set<string>();
  const re = /([A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[A-Za-z0-9]+)(?=[:(]\d|["'\s:)]|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const file = match[1].replace(/\\/g, "/");
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cc|cpp|cs|css|scss|vue|svelte|json)$/i.test(file)) continue;
    if (/(^|\/)node_modules\//.test(file) || file.startsWith("/") || /(^|\/)(test_|.*\.test\.|.*\.spec\.|.*_test\.)/i.test(file)) continue;
    files.add(file);
  }
  return [...files].slice(0, 4);
}

export function createRepairCommitlet(failed: Commitlet, failureSummary: string): Commitlet {
  // Evidence (the cheat sheet, and the sidecar-distilled "Repair focus" block) belongs ONLY in
  // observedFailure. The purpose/acceptance slices must be built from the bare failure, or
  // evidence headers pollute acceptance criteria and leak into attempts that deliberately
  // withhold evidence. Strip at whichever evidence marker appears first.
  const evidenceStart = ["=== CHEATER CHEAT SHEET", "Repair focus (distilled):"]
    .map((marker) => failureSummary.indexOf(marker))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  const bareFailure = (evidenceStart !== undefined ? failureSummary.slice(0, evidenceStart) : failureSummary).trim();
  // M2: a scoped edit can fail its typecheck/build because a COUPLED file must change too (edit
  // types.ts -> consumer.ts no longer compiles). If the repair stayed locked to the original file it
  // could never pass -> deadlock. So let the repair also touch the specific file(s) the failure NAMES
  // (bounded, non-test). Scope still stays tight - only what the error points at, capped at +2.
  const originalFiles = failed.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/"));
  const coupled = filesNamedInFailure(bareFailure)
    .filter((file) => !originalFiles.some((own) => own === file || own.endsWith(`/${file}`) || file.endsWith(`/${own}`)))
    .slice(0, 2);
  const allowedFiles = coupled.length ? [...failed.allowedFiles, ...coupled] : failed.allowedFiles;
  const maxFilesTouched = Math.max(failed.maxFilesTouched, originalFiles.length + coupled.length);
  return {
    ...failed,
    id: `${failed.id}-repair`,
    title: `Repair ${failed.title}`,
    purpose: `Repair failed commitlet without expanding scope: ${bareFailure.slice(0, 220)}`,
    status: "pending",
    maxModelCalls: 1,
    allowedFiles,
    maxFilesTouched,
    expectedFilesTouched: allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/")),
    spec: {
      behaviorMustHold: [`Original commitlet passes after repair: ${failed.title}`],
      behaviorMustNotChange: failed.spec?.behaviorMustNotChange ?? ["Unrelated behavior must not change."],
      edgeCases: ["Do not weaken tests or broaden the diff to hide the failure."],
      acceptanceCriteria: [`Focused verification failure is resolved: ${bareFailure.slice(0, 220)}`],
      temporaryTestsAllowed: false,
      permanentTestsAllowed: failed.healthBudget.allowTestEdits,
      // 2600 chars fits one compressed failure card (~900) plus a full rendered cheat sheet
      // (<= 1300), so the harness-retrieved evidence survives into the repair packet - the
      // repair worker (and each of its resample attempts) receives it with zero tool calls.
      observedFailure: failureSummary.slice(0, 2600),
      expectedBehavior: "Focused verification passes.",
      nonGoals: [
        coupled.length
          ? `Stay within allowedFiles - the coupled file(s) the failure named (${coupled.join(", ")}) are already included; do not widen further.`
          : "Do not touch files outside the original allowedFiles.",
        "Do not add dependencies, lockfiles, generated artifacts, or broad rewrites."
      ]
    },
    result: undefined,
    // Carry the ORIGINAL commitlet's pre-edit rollback point so reverting a failed repair
    // restores the clean prior state, not the already-broken intermediate the repair started
    // from. Without this the harness reports "reverted" while leaving broken code on disk.
    rollbackPoint: failed.rollbackPoint
  };
}

export function createCleanupCommitlet(plan: CommitletPlan, healthSummary: string): Commitlet {
  const allowedFiles = cleanupAllowedFiles(plan);
  const cleanup = makeCommitlet({
    id: `c${plan.commitlets.length + 1}-cleanup-health`,
    title: "Cleanup low-risk patch health issues",
    purpose: `Resolve final review patch-health warnings without expanding scope: ${healthSummary.slice(0, 220)}`,
    scope: "cleanup",
    allowedFiles,
    expectedFilesTouched: allowedFiles,
    focusedVerification: plan.finalVerification.length
      ? plan.finalVerification
      : defaultVerification({ taskKind: "refactor" } as AutopilotDecision, defaultVerificationCommand(plan.repoRoot)),
    risk: "low",
    allowTestEdits: false
  });
  return {
    ...cleanup,
    spec: {
      behaviorMustHold: [
        "Original user goal remains satisfied after cleanup.",
        "Final review patch-health score reaches the preferred threshold."
      ],
      behaviorMustNotChange: [
        "No behavior changes, public API changes, dependency edits, lockfile edits, generated artifacts, or test weakening."
      ],
      edgeCases: [
        "Prefer deleting duplication, simplifying branches, or splitting concentrated complexity over broad rewrites."
      ],
      acceptanceCriteria: [
        `Final review health warning is resolved: ${healthSummary.slice(0, 220)}`,
        "Focused verification remains green."
      ],
      temporaryTestsAllowed: false,
      permanentTestsAllowed: false,
      observedFailure: healthSummary.slice(0, 600),
      expectedBehavior: "Cleanup is health-only and final review can pass.",
      nonGoals: [
        "Do not introduce new behavior.",
        "Do not edit tests, dependencies, lockfiles, generated artifacts, or files outside allowedFiles.",
        "Do not continue into another cleanup after this commitlet."
      ]
    }
  };
}

/**
 * Build create-commitlets for a from-scratch build from the MODEL-proposed file list (blueprint/
 * scaffold.ts - there is NO per-framework template). Files are GROUPED INTO ORDERED PHASES (config
 * -> foundation -> features -> validation), ONE commitlet per phase, so a 20-file app becomes ~5
 * commitlets instead of 20 one-file round-trips (each of which, in the old shape, forced a cold
 * fresh-worker prefill and a grade pass). Each phase allows exactly its own files and runs
 * in-session; the config phase may edit the manifest + lockfile. Pass these to createCommitletPlan
 * via its `commitlets` override together with buildMode:"scaffold".
 */
export function buildScaffoldCommitlets(files: ScaffoldFile[], userGoal: string, decision: AutopilotDecision): Commitlet[] {
  const phases = groupScaffoldFilesIntoPhases(files);
  return phases.map((phase, index) => {
    const paths = phase.files.map((file) => file.path);
    const manifestPath = paths.find(isManifestPath);
    const hasManifest = !!manifestPath;
    const hasTest = paths.some((path) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(path));
    const manifestNote = manifestPath ? ` and run \`${installCommandForManifest(manifestPath)}\`` : "";
    const base = makeCommitlet({
      id: `c${index + 1}-scaffold-${phase.key}`,
      title: `Create ${phase.label} (${paths.length} file${paths.length === 1 ? "" : "s"})`,
      purpose: `Create the ${phase.label} for: ${userGoal.slice(0, 100)}`,
      scope: "scaffold",
      allowedFiles: paths,
      expectedFilesTouched: paths,
      focusedVerification: [{ purpose: `Create ${phase.label}${manifestNote}`, required: false }],
      risk: "medium",
      allowTestEdits: hasTest || phase.key === "validation"
    });
    // A whole phase of new files is a big pure-addition; scale the diff cap with the file count and
    // let the phase touch all of its own files. The config phase edits the manifest + lockfile.
    base.maxFilesTouched = Math.max(1, paths.length);
    base.maxDiffLines = Math.max(4000, paths.length * 1500);
    base.healthBudget.allowDependencyEdits = hasManifest;
    base.healthBudget.allowLockfileEdits = hasManifest;
    return { ...base, spec: forgeCommitletSpec(base, decision.taskKind, userGoal) };
  });
}

interface ScaffoldPhase { key: "config" | "foundation" | "features" | "entry" | "validation"; label: string; files: ScaffoldFile[]; }

const SCAFFOLD_PHASE_LABEL: Record<ScaffoldPhase["key"], string> = {
  config: "project config",
  foundation: "app foundation",
  features: "feature modules",
  entry: "app entry & wiring",
  validation: "tests / validation"
};

/**
 * Bucket the model's ordered file list into ordered phases (config -> foundation -> features ->
 * entry -> validation), preserving within-phase order, and split any oversize phase (mainly
 * `features`) into chunks so no single commitlet builds too many files at once. Deterministic.
 *
 * The `entry` phase (App.tsx / main.tsx - the app SHELL that imports everything) comes AFTER
 * `features` on purpose: if App is built first (the old order) the components it should import do not
 * exist yet, so the model inlines every feature into one giant unbuildable App.tsx AND leaves the
 * component files unused. Building entry last means the components already exist -> the model imports
 * them -> a thin App and focused, debuggable component files.
 */
export function groupScaffoldFilesIntoPhases(files: ScaffoldFile[], maxFilesPerPhase = 8): ScaffoldPhase[] {
  const order: ScaffoldPhase["key"][] = ["config", "foundation", "features", "entry", "validation"];
  const buckets = new Map<ScaffoldPhase["key"], ScaffoldFile[]>();
  for (const file of files) {
    const key = classifyScaffoldFile(file.path);
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push(file);
  }
  const phases: ScaffoldPhase[] = [];
  for (const key of order) {
    const bucket = buckets.get(key);
    if (!bucket || !bucket.length) continue;
    const split = bucket.length > maxFilesPerPhase;
    for (let i = 0; i < bucket.length; i += maxFilesPerPhase) {
      const chunk = bucket.slice(i, i + maxFilesPerPhase);
      const label = split ? `${SCAFFOLD_PHASE_LABEL[key]} ${Math.floor(i / maxFilesPerPhase) + 1}` : SCAFFOLD_PHASE_LABEL[key];
      phases.push({ key, label, files: chunk });
    }
  }
  // Degenerate fallback: classification should never drop every file (a manifest is guaranteed
  // present), but if it did, put everything in one config phase so the build still runs.
  if (!phases.length && files.length) phases.push({ key: "config", label: SCAFFOLD_PHASE_LABEL.config, files });
  return phases;
}

/**
 * Which scaffold phase a file belongs to, by path/name. Manifest + build/config files -> config;
 * tests/validation -> validation; the app entry/shell (main.*, App.*, root index.*) -> entry (built
 * LAST so it imports the components instead of inlining them); UI feature dirs -> features; everything
 * else (styles, types, data, hooks, store, lib, utils) -> foundation.
 */
export function classifyScaffoldFile(path: string): ScaffoldPhase["key"] {
  const p = path.toLowerCase().replace(/\\/g, "/");
  const base = p.split("/").pop() ?? p;
  if (isManifestPath(path)) return "config";
  // Tests + validation come before the generic *.config.* rule so vitest/jest configs land here.
  if (/(^|\/)(test|tests|__tests__|spec|e2e|cypress)(\/|$)|\.(test|spec)\.[jt]sx?$|^(vitest|jest)\.config\.[jt]s$|^validate[\w.-]*\.[jt]s$/i.test(p) || /^(vitest|jest)\.config\.[jt]s$/i.test(base)) return "validation";
  if (/\.config\.[jt]s$/i.test(base) || /^(tsconfig[\w.-]*\.json|jsconfig\.json|index\.html|\.gitignore|\.npmrc|\.eslintrc[\w.-]*|\.prettierrc[\w.-]*|components\.json)$/i.test(base) || /^\.env/i.test(base)) return "config";
  // The app entry/shell: the wiring hub that imports the rest. Built AFTER features so its imports
  // already exist. (index.html is config, handled above; a subdir barrel index.ts is NOT entry.)
  if (/^main\.[jt]sx?$/i.test(base) || /^app\.[jt]sx?$/i.test(base) || /^index\.[jt]sx$/i.test(base)) return "entry";
  if (/(^|\/)(components?|pages?|views?|features?|routes?|screens?|widgets?|containers?|sections?|modules?)(\/|$)/i.test(p)) return "features";
  return "foundation";
}

function commitletFromPacket(packet: WorkPacket, index: number, decision: AutopilotDecision): Commitlet {
  const allowedFiles = workPacketToAllowedFiles(packet);
  const verification = packet.verification.map(verificationFromBlueprint);
  return makeCommitlet({
    id: `c${index + 1}-${safeId(packet.id)}`,
    title: packet.title,
    purpose: packet.acceptanceCriteria.join(" ") || packet.title,
    scope: packet.type,
    allowedFiles,
    expectedFilesTouched: allowedFiles,
    focusedVerification: verification,
    risk: packet.risk,
    allowTestEdits: packet.type === "test" || decision.taskKind === "test_failure"
  });
}

function commitletsFromDecision(userGoal: string, decision: AutopilotDecision, projectTestCommand: string | null, repoRoot: string): Commitlet[] {
  if (decision.executionDiscipline === "none") return [];
  if (decision.executionDiscipline === "single_commitlet" || decision.executionDiscipline === "fast_path") {
    return [directCommitlet("c1-single", userGoal, decision, inferAllowedFiles(userGoal, decision, repoRoot), projectTestCommand)];
  }
  const parts = splitGoalIntoScopes(userGoal, decision, repoRoot);
  return parts.map((part, index) => directCommitlet(`c${index + 1}-${safeId(part.scope)}`, part.title, decision, part.files, projectTestCommand, part.scope));
}

function directCommitlet(id: string, title: string, decision: AutopilotDecision, allowedFiles: string[], projectTestCommand: string | null, scope: string = decision.taskKind): Commitlet {
  return makeCommitlet({
    id,
    title,
    purpose: title,
    scope,
    allowedFiles,
    expectedFilesTouched: allowedFiles,
    focusedVerification: defaultVerification(decision, projectTestCommand),
    risk: decision.risk,
    allowTestEdits: decision.taskKind === "test_failure" || /\btest\b/i.test(title)
  });
}

function makeCommitlet(params: {
  id: string;
  title: string;
  purpose: string;
  scope: string;
  allowedFiles: string[];
  expectedFilesTouched: string[];
  focusedVerification: VerificationStep[];
  risk: Commitlet["risk"];
  allowTestEdits?: boolean;
}): Commitlet {
  const cfg = commitletConfig();
  const healthBudget: CommitletHealthBudget = {
    maxComplexityIncrease: 12,
    maxDuplicationIncrease: 2,
    maxFunctionLengthIncrease: 60,
    allowNewLargeFunction: false,
    allowTestEdits: Boolean(params.allowTestEdits),
    allowDependencyEdits: false,
    allowLockfileEdits: false
  };
  return {
    id: params.id,
    title: params.title,
    purpose: params.purpose,
    status: "pending",
    scope: params.scope,
    allowedFiles: params.allowedFiles,
    forbiddenFiles: [],
    allowedActions: ["inspect", "edit", "run_test", "run_lint", "run_typecheck", "stop_blocked"],
    forbiddenActions: ["dependency edit without approval", "lockfile edit without approval", "test edit unless allowed", "unrelated file edit", "generated artifact edit"],
    maxFilesTouched: Math.min(cfg.maxFilesTouchedDefault, Math.max(1, params.allowedFiles.length || 1)),
    maxDiffLines: cfg.maxDiffLinesDefault,
    maxToolCalls: 10,
    maxModelCalls: cfg.maxModelCallsPerCommitlet,
    expectedFilesTouched: params.expectedFilesTouched,
    focusedVerification: params.focusedVerification,
    broaderVerification: [],
    healthBudget,
    risk: params.risk
  };
}

function splitGoalIntoScopes(userGoal: string, decision: AutopilotDecision, repoRoot: string): Array<{ scope: string; title: string; files: string[] }> {
  const lower = userGoal.toLowerCase();
  const parts: Array<{ scope: string; title: string; files: string[] }> = [];
  if (/\bconfig|setting|defaults?\b/.test(lower)) parts.push({ scope: "config", title: "Apply scoped config/default change", files: inferAllowedFiles(userGoal, decision, repoRoot, "src/config.ts") });
  if (/\bcommand|slash|\/[a-z]/.test(lower)) parts.push({ scope: "command_registration", title: "Register command and command help", files: inferAllowedFiles(userGoal, decision, repoRoot, "src/commands.ts") });
  if (/\btool|schema\b/.test(lower)) parts.push({ scope: "tool_registration", title: "Update tool registration/schema", files: inferAllowedFiles(userGoal, decision, repoRoot, "src/tools.ts") });
  if (/\bdocs?|readme|help\b/.test(lower)) parts.push({ scope: "docs", title: "Update docs/help separately", files: ["README.md"] });
  if (/\btest|coverage|regression\b/.test(lower)) parts.push({ scope: "tests", title: "Add or update focused tests", files: ["test/"] });
  if (!parts.length) parts.push({ scope: decision.taskKind, title: "Implement minimal scoped change", files: inferAllowedFiles(userGoal, decision, repoRoot) });
  return parts;
}

/**
 * Real, data-driven file selection: scan the actual repo's source for a file whose symbols,
 * exports, or command/tool/config registrations match the goal's terms. Only Cheater's own
 * repo happens to have files literally named "src/commands.ts"/"src/config.ts"; every other
 * project needs its OWN target file discovered from its OWN source, not a guessed filename.
 * `conventionalFallback` is tried only if the repo scan finds nothing AND happens to exist.
 */
function inferAllowedFiles(userGoal: string, decision: AutopilotDecision, repoRoot: string, conventionalFallback?: string): string[] {
  const lower = userGoal.toLowerCase();
  if (/\bdocs?|readme\b/.test(lower)) return ["README.md"];
  const found = selectSingleFileForGoal(repoRoot, userGoal);
  if (found) return [found];
  if (conventionalFallback && existsSync(join(repoRoot, conventionalFallback))) return [conventionalFallback];
  return decision.taskKind === "docs" ? ["README.md"] : ["(select one target file after inspection)"];
}

function cleanupAllowedFiles(plan: CommitletPlan): string[] {
  const changed = plan.commitlets.flatMap((commitlet) => commitlet.result?.filesChanged ?? []);
  const expected = plan.commitlets.flatMap((commitlet) => commitlet.expectedFilesTouched);
  const allowed = [...changed, ...expected]
    .filter((file) => file && !file.startsWith("(") && !file.endsWith("/"))
    .filter((file, index, all) => all.indexOf(file) === index);
  return allowed.slice(0, Math.max(1, commitletConfig().maxFilesTouchedDefault));
}

function defaultVerification(decision: AutopilotDecision, projectTestCommand: string | null): VerificationStep[] {
  if (decision.taskKind === "docs") return [{ purpose: "Manual docs review", required: true }];
  if (!projectTestCommand) {
    // No detected command: a command-less step passes as "manual review" instead of
    // running a guessed `npm test` that reverts correct work in a non-npm repo.
    return [{ purpose: "No project test command detected; verify manually or via cheater_verification_run", required: false }];
  }
  return [{ command: projectTestCommand, purpose: "Detected local test command", required: true }];
}

function mergeFinalVerification(commitlets: Commitlet[]): VerificationStep[] {
  const seen = new Set<string>();
  return commitlets.flatMap((commitlet) => commitlet.focusedVerification).filter((step) => {
    const key = step.command ?? step.purpose;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(decision: AutopilotDecision, count: number): string {
  return `${decision.taskKind} routed as ${decision.executionDiscipline}; ${count} commitlet${count === 1 ? "" : "s"} planned.`;
}

function safeId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "commitlet";
}
