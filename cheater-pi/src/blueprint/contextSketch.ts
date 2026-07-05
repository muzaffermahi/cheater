import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FilePlan, OfficialDocsFact, RepoOrientation, WorkPacket } from "./types.js";
import type { GraphFileTarget } from "../commitlet/constraintGraph.js";

export function repoOrientationFromMissionFacts(facts: {
  repoRoot: string;
  languages?: string[];
  frameworks?: string[];
  testCommands?: string[];
  typecheckCommands?: string[];
  entrypoints?: string[];
  importantPaths?: string[];
}): RepoOrientation {
  return {
    repoRoot: facts.repoRoot,
    languages: facts.languages ?? [],
    frameworks: facts.frameworks ?? [],
    testCommands: facts.testCommands ?? [],
    typecheckCommands: facts.typecheckCommands ?? [],
    entrypoints: facts.entrypoints ?? [],
    importantPaths: facts.importantPaths ?? []
  };
}

export function inferFilePlans(goal: string, orientation: RepoOrientation, graphTargets?: GraphFileTarget[]): FilePlan[] {
  const lower = goal.toLowerCase();
  const plans: FilePlan[] = [];
  const add = (path: string, reason: string) => plans.push({ path, reason });
  if (graphTargets && graphTargets.length) {
    for (const target of graphTargets) add(target.path, `${target.reason} (graph evidence: ${target.evidence.join("; ")})`);
  }
  const touchableFromGraph = new Set((graphTargets ?? []).filter((t) => t.role === "touch").map((t) => t.path));
  const frontendGoal = /\b(frontend|ui|ux|modern|style|styles|css|html|template|templates|page|layout|responsive)\b/.test(lower);
  // These fallbacks are Cheater-repo-SHAPED filenames. ONLY suggest one when it actually EXISTS in the
  // target repo - otherwise an empty/foreign repo (a from-scratch app) had "src/commands.ts" /
  // "src/config.ts" injected (Cheater's OWN filenames), which is exactly how "build a web app" ended up
  // editing a Pi command module. From-scratch builds get a model-derived file plan instead (Track B).
  const existsInRepo = (relPath: string) => Boolean(orientation.repoRoot) && existsSync(join(orientation.repoRoot, relPath));
  const needsCommand = /\bcommand|slash|cli\b/.test(lower) && !touchableFromGraph.has("src/commands.ts") && !plans.some((plan) => /command registration/.test(plan.reason));
  const needsTool = /\btool|schema\b/.test(lower) && !touchableFromGraph.has("src/tools.ts") && !plans.some((plan) => /tool registration/.test(plan.reason));
  const needsConfig = /\bconfig|setting|defaults?\b/.test(lower) && !plans.some((plan) => /config definition/.test(plan.reason));
  if (needsCommand && existsInRepo("src/commands.ts")) add("src/commands.ts", "fallback: command registration and help text pattern");
  if (needsTool && existsInRepo("src/tools.ts")) add("src/tools.ts", "fallback: tool registration pattern");
  if (needsConfig && existsInRepo("src/config.ts")) add("src/config.ts", "fallback: configuration loading/defaults");
  if (/\bprompt|system prompt|startup\b/.test(lower) && existsInRepo("src/prompts.ts")) add("src/prompts.ts", "Cheater prompt contract");
  if (/\bdocs?|readme\b/.test(lower)) add("README.md", "user-facing documentation");
  if (frontendGoal) {
    for (const path of [...orientation.importantPaths, ...orientation.entrypoints]) {
      if (/(^|\/)(templates|static|public|app|src)(\/|$)|\.(html|css|scss|tsx|jsx|vue|svelte)$/i.test(path)) {
        add(path, "frontend/template styling target; edit surgically by line range");
      }
    }
    if (!plans.length) {
      add("templates/", "likely server-rendered frontend templates; inspect before editing");
      add("static/", "likely frontend CSS/assets; inspect before editing");
      add("src/", "likely frontend source; inspect before editing");
    }
  }
  for (const entry of orientation.entrypoints.slice(0, 3)) {
    if (!plans.some((plan) => plan.path === entry)) add(entry, "repo entrypoint");
  }
  return dedupe(plans).slice(0, 8);
}

export function graphTouchTargets(graphTargets: GraphFileTarget[] | undefined): string[] {
  return [...new Set((graphTargets ?? []).filter((t) => t.role === "touch" && !t.path.startsWith("(") && !t.path.endsWith("/")).map((t) => t.path))];
}

export function buildPacketContext(packet: WorkPacket, previousSummaries: string[] = [], docsFacts: OfficialDocsFact[] = []): string {
  return [
    `packet: ${packet.id} ${packet.title}`,
    `type: ${packet.type}`,
    `inspect: ${packet.filesToInspect.map((f) => f.path).join(", ") || "(none)"}`,
    `touch: ${packet.filesToTouch.map((f) => f.path).join(", ") || "(none)"}`,
    `acceptance: ${packet.acceptanceCriteria.join("; ")}`,
    docsFacts.length ? `docs: ${docsFacts.slice(0, 3).map((fact) => `${fact.packageOrLibrary}:${fact.sourceUrl}`).join(" | ")}` : "docs: none",
    previousSummaries.length ? `previous: ${previousSummaries.join(" | ")}` : "previous: none"
  ].join("\n");
}

export function fileSnippet(cwd: string | undefined, file: string, maxChars = 2000): string {
  if (!cwd || !file) return "";
  const path = join(cwd, file);
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function dedupe(plans: FilePlan[]): FilePlan[] {
  const seen = new Set<string>();
  return plans.filter((plan) => {
    if (seen.has(plan.path)) return false;
    seen.add(plan.path);
    return true;
  });
}
