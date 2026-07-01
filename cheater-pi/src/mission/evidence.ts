import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { searchBugMemories, type BugMemorySearchHit } from "../bug-memory.js";
import type { EvidencePacket, MemoryHit, ProjectFacts, ReproResult } from "./types.js";

export interface GatherEvidenceOptions {
  cwd: string;
  query: string;
  repro: ReproResult | null;
  orientation: ProjectFacts | null;
  onlineEnabled?: boolean;
  offlineStackOverflowEnabled?: boolean;
  maxItems?: number;
  topK?: number;
  memoryPath?: string;
  docsRoots?: string[];
}

const DO_NOT_DO_DEFAULTS = [
  "Do not edit lockfiles or dependency manifests without user confirmation.",
  "Do not edit tests to make a failing test pass.",
  "Do not silence errors by widening types or disabling lint rules.",
  "Do not patch before reproducing the failure."
];

function classifyFailureKind(repro: ReproResult | null): string {
  if (!repro) return "unknown";
  if (repro.alreadyPassing) return "none";
  if (repro.environmentFailure) return "environment";
  return repro.failureKind || "unknown";
}

function memoryHitsFromBugMemories(hits: BugMemorySearchHit[]): MemoryHit[] {
  return hits.map((hit) => ({
    id: hit.id,
    score: hit.score,
    bugType: hit.bugType,
    rootCause: hit.rootCause,
    fixPattern: hit.fixPattern,
    source: "compacted_bug_memory"
  }));
}

function findInstructionDocs(cwd: string, roots: string[]): string[] {
  const candidates = ["AGENTS.md", "CLAUDE.md", "CONVENTIONS.md", "README.md", "CONTRIBUTING.md"];
  const out: string[] = [];
  for (const root of roots.length > 0 ? roots : [cwd]) {
    for (const name of candidates) {
      const path = join(root, name);
      if (existsSync(path) && statSync(path).size < 32_000) {
        try {
          const lines = readFileSync(path, "utf8").split(/\r?\n/).slice(0, 80);
          out.push(`${name} (${root}): ${lines.join(" ").slice(0, 600)}`);
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  return out;
}

function derivePackageFacts(cwd: string, failureKind: string): string[] {
  const facts: string[] = [];
  const manifestChecks: Array<[string, RegExp]> = [
    ["package.json", /"name"\s*:\s*"([^"]+)"/],
    ["package.json", /"type"\s*:\s*"([^"]+)"/],
    ["pyproject.toml", /\[project\][\s\S]*?name\s*=\s*"([^"]+)"/i]
  ];
  for (const [file, pattern] of manifestChecks) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const match = text.match(pattern);
      if (match) {
        facts.push(`${file} declares ${basename(file)} name/value: ${match[1].slice(0, 80)}`);
      }
    } catch {
      // ignore
    }
  }
  if (failureKind === "import_error") {
    facts.push("Import failure detected: prefer inspecting declared dependency + import path before adding new packages.");
  }
  return facts;
}

function deriveDoNotDo(repro: ReproResult | null, orientation: ProjectFacts | null): string[] {
  const items = [...DO_NOT_DO_DEFAULTS];
  if (repro?.alreadyPassing) items.push("The command already passes. Do not patch unless the user asked for a proactive change.");
  if (orientation?.doNotTouch?.length) items.push(`Do not touch: ${orientation.doNotTouch.join(", ")}`);
  return items;
}

function recommendStrategy(repro: ReproResult | null, memoryHits: MemoryHit[], hasOrientation: boolean): string {
  if (repro?.alreadyPassing) return "no_change_needed: report passing run and ask if proactive change is wanted";
  if (repro?.environmentFailure) return "fix environment first (install missing tool, correct PATH, add missing dep)";
  if (memoryHits.length > 0) {
    return `verify the top memory against the failing code; if the root_cause matches, apply the fix_pattern with the smallest diff`;
  }
  if (hasOrientation) return "use the focused test command from orientation; read the failing file region; patch the smallest likely cause";
  return "read the failing region; gather one more piece of evidence (memory, repo docs, or installed package) before patching";
}

function computeConfidence(repro: ReproResult | null, memoryHits: MemoryHit[], hasOrientation: boolean, docsCount: number): number {
  let score = 0.2;
  if (repro?.reproduced) score += 0.3;
  if (repro?.alreadyPassing) score += 0.1;
  if (memoryHits.length > 0) score += 0.25;
  if (hasOrientation) score += 0.1;
  if (docsCount > 0) score += 0.05;
  if (repro?.environmentFailure) {
    score -= 0.4;
    score = Math.min(score, 0.25);
  }
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

export async function gatherEvidence(options: GatherEvidenceOptions): Promise<EvidencePacket> {
  const maxItems = options.maxItems ?? 5;
  const failureKind = classifyFailureKind(options.repro);
  const memoryHits: MemoryHit[] = [];
  let memoryDocCount = 0;

  if (options.repro && !options.repro.alreadyPassing) {
    const result = await searchBugMemories({
      cwd: options.cwd,
      query: options.query,
      topK: options.topK ?? maxItems,
      memoryPath: options.memoryPath
    });
    memoryDocCount = result.docCount;
    memoryHits.push(...memoryHitsFromBugMemories(result.hits).slice(0, maxItems));
  }

  const docsRoots = options.docsRoots ?? (options.orientation ? [options.cwd] : []);
  const docsFacts = findInstructionDocs(options.cwd, docsRoots).slice(0, maxItems);
  const packageFacts = derivePackageFacts(options.cwd, failureKind).slice(0, maxItems);
  const stackoverflowFacts = options.offlineStackOverflowEnabled
    ? []
    : ["offline StackOverflow disabled by config; relying on bug memory + local docs"];
  const recommendedStrategy = recommendStrategy(options.repro, memoryHits, !!options.orientation);
  const doNotDo = deriveDoNotDo(options.repro, options.orientation);
  const confidence = computeConfidence(options.repro, memoryHits, !!options.orientation, docsFacts.length);

  return {
    failureKind,
    reproduced: options.repro?.reproduced ?? false,
    memoryHits,
    projectFacts: options.orientation,
    packageFacts,
    docsFacts,
    stackoverflowFacts,
    recommendedStrategy,
    doNotDo,
    confidence
  };
}

export function formatEvidencePacket(packet: EvidencePacket): string {
  const lines: string[] = [];
  lines.push(`Cheater evidence`);
  lines.push(`failure: ${packet.failureKind}`);
  lines.push(`reproduced: ${packet.reproduced}`);
  lines.push(`confidence: ${packet.confidence}`);
  lines.push(`memory hits: ${packet.memoryHits.length}`);
  for (const hit of packet.memoryHits.slice(0, 3)) {
    lines.push(`  - ${hit.id} (${hit.score}) -> ${hit.bugType}`);
  }
  if (packet.projectFacts) {
    const o = packet.projectFacts;
    lines.push(`orientation: ${o.languages.join(", ") || "(unknown)"} via ${o.packageManagers.join(", ") || "(unknown)"}`);
    if (o.testCommands.length) lines.push(`focused test: ${o.testCommands[0]}`);
  }
  for (const fact of packet.docsFacts.slice(0, 2)) lines.push(`doc: ${fact.slice(0, 200)}`);
  for (const fact of packet.packageFacts.slice(0, 2)) lines.push(`package: ${fact.slice(0, 200)}`);
  lines.push(`strategy: ${packet.recommendedStrategy}`);
  if (packet.doNotDo.length) {
    lines.push(`do not:`);
    for (const item of packet.doNotDo.slice(0, 5)) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}
