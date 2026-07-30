// Sidecar use-case catalog. Each job has a deterministic floor, so the app can remain useful when the
// small model is absent, busy, malformed, or slower than the foreground task.

import type { KittenLLM } from "./llm.js";
import type { WorkspaceIndex } from "./workspaceIndex.js";
import { SidecarControlPlane, type SidecarPriority, type SidecarTier, type SidecarResult } from "./sidecarControlPlane.js";

export type SidecarJobType =
  | "classify_task" | "extract_contract" | "rank_files" | "orient_task" | "postflight_review" | "select_tests" | "compress_context" | "summarize_output"
  | "cluster_failure" | "detect_loop" | "review_diff" | "audit_evidence" | "predict_conflict" | "prepare_capsule"
  | "title" | "progress" | "choose_model" | "estimate_risk" | "summarize_diff" | "suggest_commands" | "explain_error"
  | "map_dependencies" | "generate_test_cases" | "detect_secrets" | "triage_logs" | "draft_commit" | "find_duplicates" | "estimate_tokens" | "summarize_tree";

export const SIDECAR_JOB_TYPES = [
  "classify_task", "extract_contract", "rank_files", "orient_task", "postflight_review", "select_tests", "compress_context", "summarize_output",
  "cluster_failure", "detect_loop", "review_diff", "audit_evidence", "predict_conflict", "prepare_capsule",
  "title", "progress", "choose_model", "estimate_risk", "summarize_diff", "suggest_commands", "explain_error",
  "map_dependencies", "generate_test_cases", "detect_secrets", "triage_logs", "draft_commit", "find_duplicates", "estimate_tokens", "summarize_tree",
] as const satisfies readonly SidecarJobType[];

export function isSidecarJobType(value: string): value is SidecarJobType {
  return (SIDECAR_JOB_TYPES as readonly string[]).includes(value);
}

export type SidecarWorkflowId = "task-intake" | "change-review" | "failure-triage" | "release-readiness" | "refactor-plan" | "test-hardening" | "dependency-audit";

export interface SidecarWorkflowStep {
  id: string;
  type: SidecarJobType;
  label: string;
}

export interface SidecarWorkflowDefinition {
  id: SidecarWorkflowId;
  name: string;
  description: string;
  steps: SidecarWorkflowStep[];
}

/** Coherent, bounded sidecar workflows exposed by the native toolbox. Each step remains validated
 * independently and can fall back without turning the entire workflow into a false success. */
export const SIDECAR_WORKFLOWS: readonly SidecarWorkflowDefinition[] = [
  {
    id: "task-intake",
    name: "Task intake",
    description: "Classify the request, locate candidate files, extract constraints, and draft edge cases.",
    steps: [
      { id: "classify", type: "classify_task", label: "Classify task" },
      { id: "files", type: "rank_files", label: "Rank candidate files" },
      { id: "contract", type: "extract_contract", label: "Extract requirements" },
      { id: "dependencies", type: "map_dependencies", label: "Map dependencies" },
      { id: "tests", type: "generate_test_cases", label: "Draft edge cases" },
      { id: "model", type: "choose_model", label: "Choose model tier" },
    ],
  },
  {
    id: "change-review",
    name: "Change review",
    description: "Review a bounded diff for secrets, risk, evidence gaps, and focused verification.",
    steps: [
      { id: "summary", type: "summarize_diff", label: "Summarize diff" },
      { id: "review", type: "review_diff", label: "Review diff" },
      { id: "secrets", type: "detect_secrets", label: "Scan for secrets" },
      { id: "risk", type: "estimate_risk", label: "Estimate risk" },
      { id: "evidence", type: "audit_evidence", label: "Audit evidence" },
      { id: "tests", type: "generate_test_cases", label: "Draft edge cases" },
      { id: "commands", type: "suggest_commands", label: "Suggest checks" },
    ],
  },
  {
    id: "failure-triage",
    name: "Failure triage",
    description: "Turn logs or an error into a compact signature, likely cause, loop signal, and next checks.",
    steps: [
      { id: "cluster", type: "cluster_failure", label: "Cluster failure" },
      { id: "triage", type: "triage_logs", label: "Triage logs" },
      { id: "explain", type: "explain_error", label: "Explain likely cause" },
      { id: "loop", type: "detect_loop", label: "Detect repeated loop" },
      { id: "tests", type: "select_tests", label: "Select focused tests" },
      { id: "commands", type: "suggest_commands", label: "Suggest checks" },
    ],
  },
  {
    id: "release-readiness",
    name: "Release readiness",
    description: "Summarize the workspace, find duplicates/secrets, estimate context, and surface safe checks.",
    steps: [
      { id: "tree", type: "summarize_tree", label: "Summarize workspace" },
      { id: "duplicates", type: "find_duplicates", label: "Find duplicate files" },
      { id: "secrets", type: "detect_secrets", label: "Scan for secrets" },
      { id: "tokens", type: "estimate_tokens", label: "Estimate context" },
      { id: "risk", type: "estimate_risk", label: "Estimate risk" },
      { id: "commands", type: "suggest_commands", label: "Suggest checks" },
    ],
  },
  {
    id: "refactor-plan",
    name: "Refactor plan",
    description: "Map a change across the workspace, surface conflicts, choose a model tier, and draft focused acceptance cases.",
    steps: [
      { id: "orient", type: "orient_task", label: "Orient the task" },
      { id: "files", type: "rank_files", label: "Rank affected files" },
      { id: "dependencies", type: "map_dependencies", label: "Map dependencies" },
      { id: "conflicts", type: "predict_conflict", label: "Predict edit conflicts" },
      { id: "contract", type: "extract_contract", label: "Extract invariants" },
      { id: "tests", type: "generate_test_cases", label: "Draft regression cases" },
      { id: "model", type: "choose_model", label: "Choose execution tier" },
    ],
  },
  {
    id: "test-hardening",
    name: "Test hardening",
    description: "Find focused checks, identify missing edge cases, and audit whether a change has convincing evidence.",
    steps: [
      { id: "tree", type: "summarize_tree", label: "Summarize test surface" },
      { id: "tests", type: "select_tests", label: "Select focused tests" },
      { id: "cases", type: "generate_test_cases", label: "Draft edge cases" },
      { id: "review", type: "review_diff", label: "Review the change" },
      { id: "evidence", type: "audit_evidence", label: "Audit evidence" },
      { id: "commands", type: "suggest_commands", label: "Suggest verification" },
    ],
  },
  {
    id: "dependency-audit",
    name: "Dependency audit",
    description: "Trace imports, find duplicate paths, scan for exposed secrets, and produce safe release checks.",
    steps: [
      { id: "tree", type: "summarize_tree", label: "Summarize workspace" },
      { id: "dependencies", type: "map_dependencies", label: "Trace imports" },
      { id: "duplicates", type: "find_duplicates", label: "Find duplicate files" },
      { id: "secrets", type: "detect_secrets", label: "Scan for secrets" },
      { id: "risk", type: "estimate_risk", label: "Estimate release risk" },
      { id: "commands", type: "suggest_commands", label: "Suggest safe checks" },
    ],
  },
];

export function sidecarWorkflow(id: string): SidecarWorkflowDefinition | undefined {
  return SIDECAR_WORKFLOWS.find((workflow) => workflow.id === id);
}

export interface SidecarJobInput {
  id: string;
  type: SidecarJobType;
  premise: string;
  text?: string;
  query?: string;
  diff?: string;
  output?: string;
  files?: string[];
  tests?: string[];
  facts?: string[];
  maxChars?: number;
  /** Optional wall-clock budget for opportunistic/background jobs. */
  deadlineMs?: number;
}

export interface SidecarJobOutput {
  type: SidecarJobType;
  value: unknown;
  confidence: "high" | "medium" | "low";
  notes: string[];
}

const priorities: Record<SidecarJobType, SidecarPriority> = {
  classify_task: "user-blocking", extract_contract: "user-blocking", rank_files: "context", orient_task: "user-blocking", postflight_review: "verification", select_tests: "verification",
  compress_context: "context", summarize_output: "context", cluster_failure: "verification", detect_loop: "user-blocking",
  review_diff: "verification", audit_evidence: "verification", predict_conflict: "context", prepare_capsule: "context",
  title: "speculative", progress: "speculative", choose_model: "user-blocking", estimate_risk: "verification", summarize_diff: "context", suggest_commands: "verification", explain_error: "verification",
  map_dependencies: "context", generate_test_cases: "verification", detect_secrets: "verification", triage_logs: "verification", draft_commit: "context", find_duplicates: "context", estimate_tokens: "context", summarize_tree: "context",
};

const tiers: Record<SidecarJobType, SidecarTier> = {
  classify_task: "clerk", extract_contract: "clerk", rank_files: "scout", orient_task: "scout", postflight_review: "specialist", select_tests: "scout", compress_context: "clerk",
  summarize_output: "clerk", cluster_failure: "scout", detect_loop: "clerk", review_diff: "specialist", audit_evidence: "specialist",
  predict_conflict: "scout", prepare_capsule: "scout", title: "clerk", progress: "clerk", choose_model: "clerk", estimate_risk: "specialist", summarize_diff: "clerk", suggest_commands: "scout", explain_error: "scout",
  map_dependencies: "scout", generate_test_cases: "scout", detect_secrets: "specialist", triage_logs: "scout", draft_commit: "clerk", find_duplicates: "scout", estimate_tokens: "clerk", summarize_tree: "clerk",
};

export function sidecarJobDefaults(input: SidecarJobInput): { priority: SidecarPriority; tier: SidecarTier } {
  return { priority: priorities[input.type], tier: tiers[input.type] };
}

export function deterministicSidecar(input: SidecarJobInput, index?: WorkspaceIndex): SidecarJobOutput {
  const text = input.text ?? "";
  switch (input.type) {
    case "classify_task": return { type: input.type, value: classify(text), confidence: "medium", notes: ["regex floor"] };
    case "extract_contract": return { type: input.type, value: extractContract(text), confidence: "low", notes: ["explicit requirements only"] };
    case "rank_files": return { type: input.type, value: index ? index.search(input.query ?? text, 20).map((hit) => ({ path: hit.path, score: hit.score })) : (input.files ?? []).slice(0, 20), confidence: index ? "medium" : "low", notes: [index ? "workspace index" : "candidate order"] };
    case "orient_task": {
      const contract = extractContract(text);
      return { type: input.type, value: { classification: classify(text), files: index ? index.search(input.query ?? text, 12).map((hit) => ({ path: hit.path, score: hit.score })) : (input.files ?? []).slice(0, 12).map((path) => ({ path })), requirements: contract.requirements.slice(0, 12) }, confidence: index ? "medium" : "low", notes: [index ? "workspace index + bounded contract" : "deterministic orientation floor"] };
    }
    case "postflight_review": return { type: input.type, value: deterministicPostflight(input), confidence: "medium", notes: ["composed deterministic audit floor"] };
    case "select_tests": return { type: input.type, value: (input.tests ?? []).filter((test) => input.files?.some((file) => test.toLowerCase().includes(file.toLowerCase().replace(/\.[^.]+$/, ""))) ?? true).slice(0, 20), confidence: "medium", notes: ["filename proximity floor"] };
    case "compress_context": return { type: input.type, value: compress(text, input.maxChars ?? 4000), confidence: "low", notes: ["line-preserving truncation floor"] };
    case "summarize_output": return { type: input.type, value: summarizeOutput(input.output ?? text), confidence: "medium", notes: ["error-line extraction floor"] };
    case "cluster_failure": return { type: input.type, value: failureSignature(input.output ?? text), confidence: "medium", notes: ["normalized failure signature"] };
    case "detect_loop": return { type: input.type, value: detectLoop(text), confidence: "medium", notes: ["repeated action/error floor"] };
    case "review_diff": return { type: input.type, value: reviewDiff(input.diff ?? text), confidence: "low", notes: ["heuristic review only"] };
    case "audit_evidence": return { type: input.type, value: auditEvidence(input.diff ?? text, input.facts ?? []), confidence: "medium", notes: ["receipt presence floor"] };
    case "predict_conflict": return { type: input.type, value: conflicts(input.files ?? []), confidence: "high", notes: ["overlap check"] };
    case "prepare_capsule": return { type: input.type, value: { text: compress(text, input.maxChars ?? 6000), files: (input.files ?? []).slice(0, 32), facts: (input.facts ?? []).slice(0, 32) }, confidence: "medium", notes: ["bounded capsule floor"] };
    case "title": return { type: input.type, value: text.trim().split(/\s+/).slice(0, 6).join(" ") || "New task", confidence: "medium", notes: ["deterministic title floor"] };
    case "progress": return { type: input.type, value: summarizeOutput(input.output ?? text), confidence: "low", notes: ["bounded progress floor"] };
    case "choose_model": return { type: input.type, value: chooseModel(text, input.files ?? []), confidence: "medium", notes: ["task complexity floor"] };
    case "estimate_risk": return { type: input.type, value: estimateRisk(input.diff ?? text), confidence: "medium", notes: ["safety keyword floor"] };
    case "summarize_diff": return { type: input.type, value: summarizeDiff(input.diff ?? text), confidence: "medium", notes: ["bounded diff summary floor"] };
    case "suggest_commands": return { type: input.type, value: suggestCommands(input.files ?? [], input.tests ?? []), confidence: "low", notes: ["known-runner floor"] };
    case "explain_error": return { type: input.type, value: explainError(input.output ?? text), confidence: "medium", notes: ["failure signature floor"] };
    case "map_dependencies": return { type: input.type, value: mapDependencies(index, input.files ?? []), confidence: index ? "medium" : "low", notes: [index ? "workspace import graph" : "candidate list floor"] };
    case "generate_test_cases": return { type: input.type, value: generateTestCases(text), confidence: "low", notes: ["acceptance sentence floor"] };
    case "detect_secrets": return { type: input.type, value: detectSecrets(input.diff ?? text), confidence: "medium", notes: ["high-signal pattern scan"] };
    case "triage_logs": return { type: input.type, value: triageLogs(input.output ?? text), confidence: "medium", notes: ["severity and signature floor"] };
    case "draft_commit": return { type: input.type, value: draftCommit(text, input.diff ?? ""), confidence: "low", notes: ["bounded commit message floor"] };
    case "find_duplicates": return { type: input.type, value: findDuplicates(input.files ?? []), confidence: "high", notes: ["normalized path overlap floor"] };
    case "estimate_tokens": return { type: input.type, value: estimateTokens(text || input.output || input.diff || ""), confidence: "medium", notes: ["character ratio estimate"] };
    case "summarize_tree": return { type: input.type, value: summarizeTree(index), confidence: index ? "medium" : "low", notes: [index ? "workspace index" : "empty index floor"] };
  }
}

/** Extract one bounded JSON value from a model response, tolerating markdown fences but never prose injection. */
export function extractSidecarJson(raw: string): unknown | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let quote = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quote = false;
        continue;
      }
      if (ch === '"') { quote = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

function boundedString(value: unknown, max = 4000): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** Validate sidecar output against the request's candidate set; invalid output falls back deterministically. */
export function validateSidecarValue(input: SidecarJobInput, value: unknown): unknown | null {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) value = (value as { value: unknown }).value;
  switch (input.type) {
    case "classify_task": {
      const label = typeof value === "string" ? value : value && typeof value === "object" ? (value as { label?: unknown; classification?: unknown }).label ?? (value as { classification?: unknown }).classification : undefined;
      return typeof label === "string" && /^(question|bug|feature|refactor|general)$/i.test(label) ? label.toLowerCase() : null;
    }
    case "title": return boundedString(value, 120);
    case "compress_context":
    case "summarize_output":
    case "cluster_failure":
    case "progress": return boundedString(value, input.maxChars ?? 4000);
    case "rank_files": {
      const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { files?: unknown }).files) ? (value as { files: unknown[] }).files : null;
      if (!list) return null;
      const candidates = new Set(input.files ?? []);
      return list.map((item) => typeof item === "string" ? { path: item } : item).filter((item): item is { path: string; score?: number } => Boolean(item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" && (!candidates.size || candidates.has((item as { path: string }).path)))).slice(0, 20);
    }
    case "orient_task": {
      if (!value || typeof value !== "object") return null;
      const obj = value as { classification?: unknown; files?: unknown; requirements?: unknown };
      if (!/^(question|bug|feature|refactor|general)$/i.test(String(obj.classification)) || !Array.isArray(obj.files) || !Array.isArray(obj.requirements)) return null;
      const candidates = new Set(input.files ?? []);
      const files = obj.files.map((item) => typeof item === "string" ? { path: item } : item).filter((item): item is { path: string; score?: number } => Boolean(item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" && (!candidates.size || candidates.has((item as { path: string }).path)))).slice(0, 12);
      return { classification: String(obj.classification).toLowerCase(), files, requirements: obj.requirements.map(String).filter(Boolean).slice(0, 12) };
    }
    case "postflight_review": {
      if (!value || typeof value !== "object") return null;
      const obj = value as Record<string, unknown>;
      const arrays = ["secrets", "warnings", "evidenceWarnings", "recommendedTests", "suggestedCommands", "riskReasons", "generatedTestCases"];
      if (!arrays.every((key) => Array.isArray(obj[key]))) return null;
      if (obj.risk !== "low" && obj.risk !== "medium" && obj.risk !== "high") return null;
      const tests = new Set(input.tests ?? []);
      const bounded = (key: string, max: number, filter?: (value: string) => boolean): string[] => (obj[key] as unknown[]).map(String).filter((item) => !filter || filter(item)).slice(0, max);
      return {
        secrets: bounded("secrets", 12), warnings: bounded("warnings", 24), evidenceWarnings: bounded("evidenceWarnings", 24),
        recommendedTests: bounded("recommendedTests", 12, (item) => !tests.size || tests.has(item)),
        suggestedCommands: bounded("suggestedCommands", 8), risk: obj.risk, riskReasons: bounded("riskReasons", 12), generatedTestCases: bounded("generatedTestCases", 12),
      };
    }
    case "select_tests": {
      const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { tests?: unknown }).tests) ? (value as { tests: unknown[] }).tests : null;
      if (!list) return null;
      const candidates = new Set(input.tests ?? []);
      return list.map(String).filter((item) => !candidates.size || candidates.has(item)).slice(0, 20);
    }
    case "extract_contract": {
      if (!value || typeof value !== "object") return null;
      const obj = value as { requirements?: unknown; forbidden?: unknown };
      if (!Array.isArray(obj.requirements) || !Array.isArray(obj.forbidden)) return null;
      return { requirements: obj.requirements.map(String).slice(0, 24), forbidden: obj.forbidden.map(String).slice(0, 24) };
    }
    case "prepare_capsule": {
      if (!value || typeof value !== "object") return null;
      const obj = value as { text?: unknown; files?: unknown; facts?: unknown };
      if (typeof obj.text !== "string" || !Array.isArray(obj.files) || !Array.isArray(obj.facts)) return null;
      const candidates = new Set(input.files ?? []);
      return { text: obj.text.slice(0, input.maxChars ?? 6000), files: obj.files.map(String).filter((file) => !candidates.size || candidates.has(file)).slice(0, 32), facts: obj.facts.map(String).slice(0, 32) };
    }
    case "detect_loop": {
      if (!value || typeof value !== "object") return null;
      const obj = value as { repeated?: unknown; signature?: unknown };
      return typeof obj.repeated === "boolean" && typeof obj.signature === "string" ? { repeated: obj.repeated, signature: obj.signature.slice(0, 240) } : null;
    }
    case "review_diff": {
      if (!value || typeof value !== "object" || !Array.isArray((value as { warnings?: unknown }).warnings)) return null;
      return { warnings: (value as { warnings: unknown[] }).warnings.map(String).slice(0, 24) };
    }
    case "audit_evidence": {
      if (!value || typeof value !== "object") return null;
      const obj = value as { hasDiff?: unknown; evidenceCount?: unknown; warnings?: unknown };
      return typeof obj.hasDiff === "boolean" && typeof obj.evidenceCount === "number" && Array.isArray(obj.warnings) ? { hasDiff: obj.hasDiff, evidenceCount: Math.max(0, Math.min(64, Math.floor(obj.evidenceCount))), warnings: obj.warnings.map(String).slice(0, 24) } : null;
    }
    case "predict_conflict": {
      if (!value || typeof value !== "object" || !Array.isArray((value as { conflicts?: unknown }).conflicts)) return null;
      const candidates = new Set(input.files ?? []);
      return { conflicts: (value as { conflicts: unknown[] }).conflicts.map(String).filter((file) => !candidates.size || candidates.has(file)).slice(0, 64) };
    }
    case "choose_model":
    case "estimate_risk":
    case "summarize_diff":
    case "suggest_commands":
    case "explain_error":
      return value && typeof value === "object" ? value : null;
    case "map_dependencies": {
      if (!value || typeof value !== "object" || !Array.isArray((value as { edges?: unknown }).edges)) return null;
      const rawEdges = (value as { edges: unknown[] }).edges;
      if (!rawEdges.every((edge) => Boolean(edge && typeof edge === "object" && typeof (edge as { from?: unknown }).from === "string" && typeof (edge as { to?: unknown }).to === "string"))) return null;
      return { edges: rawEdges.map((edge) => ({ from: (edge as { from: string }).from, to: (edge as { to: string }).to })).slice(0, 128) };
    }
    case "generate_test_cases":
    case "detect_secrets":
    case "find_duplicates": {
      if (!value || typeof value !== "object") return null;
      const list = (value as { cases?: unknown; findings?: unknown; duplicates?: unknown }).cases ?? (value as { findings?: unknown }).findings ?? (value as { duplicates?: unknown }).duplicates;
      return Array.isArray(list) ? { [input.type === "generate_test_cases" ? "cases" : input.type === "detect_secrets" ? "findings" : "duplicates"]: list.map(String).slice(0, 32) } : null;
    }
    case "triage_logs": {
      if (!value || typeof value !== "object") return null;
      const obj = value as { severity?: unknown; signature?: unknown; lines?: unknown };
      return /^(error|warning|info)$/.test(String(obj.severity)) && typeof obj.signature === "string" && Array.isArray(obj.lines) ? { severity: obj.severity, signature: obj.signature.slice(0, 240), lines: obj.lines.map(String).slice(-12) } : null;
    }
    case "draft_commit": {
      if (!value || typeof value !== "object") return null;
      const obj = value as { title?: unknown; body?: unknown };
      return typeof obj.title === "string" && typeof obj.body === "string" ? { title: obj.title.slice(0, 120), body: obj.body.slice(0, 2000) } : null;
    }
    case "estimate_tokens": {
      if (!value || typeof value !== "object") return null;
      const obj = value as { characters?: unknown; estimatedTokens?: unknown };
      return typeof obj.characters === "number" && typeof obj.estimatedTokens === "number" ? { characters: Math.max(0, Math.floor(obj.characters)), estimatedTokens: Math.max(0, Math.floor(obj.estimatedTokens)) } : null;
    }
    case "summarize_tree": {
      if (!value || typeof value !== "object") return null;
      const obj = value as { files?: unknown; bytes?: unknown; tests?: unknown; languages?: unknown };
      return typeof obj.files === "number" && typeof obj.bytes === "number" && typeof obj.tests === "number" && obj.languages && typeof obj.languages === "object" ? { files: Math.max(0, Math.floor(obj.files)), bytes: Math.max(0, Math.floor(obj.bytes)), tests: Math.max(0, Math.floor(obj.tests)), languages: obj.languages as Record<string, number> } : null;
    }
    default: return value;
  }
}

export async function runCatalogJob(scheduler: SidecarControlPlane, llm: KittenLLM | null, index: WorkspaceIndex | undefined, input: SidecarJobInput): Promise<SidecarResult<SidecarJobOutput>> {
  const defaults = sidecarJobDefaults(input);
  return scheduler.enqueue({ id: input.id, type: input.type, tier: defaults.tier, priority: defaults.priority, premise: input.premise, deadlineMs: input.deadlineMs,
    run: async (signal) => {
      if (!llm) return deterministicSidecar(input, index);
      const prompt = `Return a concise JSON object for sidecar job ${input.type}. Do not invent files or evidence.\n${JSON.stringify(input).slice(0, 12000)}`;
      const response = await llm.sidecar({ messages: [{ role: "user", content: prompt }], maxTokens: 512, disableThinking: true, signal });
      if (!response.ok || !response.content.trim()) throw new Error(response.error ?? "sidecar returned no content");
      const parsed = extractSidecarJson(response.content);
      const value = parsed === null ? null : validateSidecarValue(input, parsed);
      if (value === null) throw new Error("sidecar returned malformed or out-of-scope JSON");
      return { type: input.type, value, confidence: "medium", notes: ["sidecar model", "validated JSON"] };
    },
    fallback: () => deterministicSidecar(input, index),
  });
}

function classify(text: string): string { if (/\bwhy|how|what is|explain\b/i.test(text) && !/\b(fix|add|change|implement|create)\b/i.test(text)) return "question"; if (/\b(fix|bug|broken|failing|error|regression)\b/i.test(text)) return "bug"; if (/\b(refactor|rename|migrate|cleanup)\b/i.test(text)) return "refactor"; if (/\b(add|create|implement|build)\b/i.test(text)) return "feature"; return "general"; }
function extractContract(text: string): { requirements: string[]; forbidden: string[] } { return { requirements: text.split(/[.!?\n]+/).map((s) => s.trim()).filter((s) => /\b(must|should|need|ensure|accept|return|support)\b/i.test(s)).slice(0, 24), forbidden: [...text.matchAll(/\b(?:do not|don't|never)\s+([^.!?\n]+)/gi)].map((m) => m[1].trim()).slice(0, 24) }; }
function compress(text: string, max: number): string { if (text.length <= max) return text; const lines = text.split(/\r?\n/); const head = lines.slice(0, 8).join("\n"); const tail = lines.slice(-Math.max(4, Math.floor(max / 300))).join("\n"); return `${head}\n…[compacted]…\n${tail}`.slice(0, max); }
function summarizeOutput(text: string): string { const lines = text.split(/\r?\n/).filter((line) => /error|fail|warning|passed|success|test/i.test(line)); return (lines.length ? lines : text.split(/\r?\n/)).slice(-12).join("\n").slice(0, 3000); }
function failureSignature(text: string): string { return (text.match(/(?:error|exception|failed?)[^\n:]*(?::\s*)?[^\n]*/i)?.[0] ?? text.trim().split(/\r?\n/).filter(Boolean)[0] ?? "unknown failure").toLowerCase().replace(/\d+/g, "#").slice(0, 240); }
function detectLoop(text: string): { repeated: boolean; signature: string } { const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); const normalized = lines.map((s) => s.replace(/\d+/g, "#")); const repeated = new Set(normalized).size < Math.max(1, normalized.length * 0.6); return { repeated, signature: failureSignature(text) }; }
function reviewDiff(diff: string): { warnings: string[] } { const warnings: string[] = []; if (/console\.log|print\(/.test(diff)) warnings.push("debug output may be unintended"); if (/TODO|FIXME/.test(diff)) warnings.push("new TODO/FIXME marker"); if (/password|api[_-]?key|secret/i.test(diff)) warnings.push("possible secret in diff"); return { warnings }; }
function auditEvidence(diff: string, facts: string[]): { hasDiff: boolean; evidenceCount: number; warnings: string[] } { const warnings: string[] = []; if (!diff.trim()) warnings.push("no diff supplied"); if (!facts.length) warnings.push("no execution evidence supplied"); return { hasDiff: Boolean(diff.trim()), evidenceCount: facts.length, warnings }; }
function conflicts(files: string[]): { conflicts: string[] } { const seen = new Set<string>(); const conflicts: string[] = []; for (const file of files) { if (seen.has(file)) conflicts.push(file); seen.add(file); } return { conflicts }; }
function chooseModel(text: string, files: string[]): { tier: "main" | "sidecar"; reason: string } { const hard = /architect|security|migration|multi[- ]file|complex|debug|implement|refactor/i.test(text) || files.length > 4; return hard ? { tier: "main", reason: "creation or cross-file reasoning" } : { tier: "sidecar", reason: "clerical or narrow task" }; }
function estimateRisk(diff: string): { level: "low" | "medium" | "high"; reasons: string[] } { const reasons: string[] = []; if (/secret|password|token|api[_-]?key/i.test(diff)) reasons.push("possible secret"); if (/delete|rm\s+-|drop\s+table|chmod\s+777/i.test(diff)) reasons.push("destructive operation"); if (/auth|permission|crypto|security/i.test(diff)) reasons.push("security-sensitive surface"); return { level: reasons.some((reason) => /secret|destructive/.test(reason)) ? "high" : reasons.length ? "medium" : "low", reasons }; }
function summarizeDiff(diff: string): { files: string[]; additions: number; removals: number; highlights: string[] } { const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]).slice(0, 32); const additions = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length; const removals = diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length; const highlights = diff.split(/\r?\n/).filter((line) => /^\+[^+]|^-[^-]/.test(line)).slice(0, 12).map((line) => line.slice(0, 240)); return { files, additions, removals, highlights }; }
function suggestCommands(files: string[], tests: string[]): string[] { const all = [...files, ...tests].join(" "); if (/\.py\b|pytest/i.test(all)) return ["python -m pytest"]; if (/Cargo\.toml|\.rs\b/i.test(all)) return ["cargo test"]; if (/package\.json|\.tsx?\b|\.jsx?\b/i.test(all)) return ["npm test", "npm run typecheck", "npm run build"]; return tests.slice(0, 5).filter(Boolean); }
function explainError(text: string): { signature: string; likelyCause: string } { const signature = failureSignature(text); const likelyCause = /module not found|cannot find module/i.test(text) ? "dependency or import resolution" : /typeerror|attributeerror/i.test(text) ? "unexpected value shape or missing member" : /syntaxerror|parseerror/i.test(text) ? "syntax or parser mismatch" : /timeout|timed out/i.test(text) ? "slow or blocked external operation" : "inspect the cited file and reproduce the failure"; return { signature, likelyCause }; }
function mapDependencies(index: WorkspaceIndex | undefined, files: string[]): { edges: Array<{ from: string; to: string }> } {
  if (!index) return { edges: [] };
  const selected = new Set(files);
  const edges: Array<{ from: string; to: string }> = [];
  for (const record of index.list()) {
    if (selected.size && !selected.has(record.path)) continue;
    for (const imported of record.imports.slice(0, 32)) {
      const target = index.list().find((candidate) => candidate.path.includes(imported.replace(/^\.\//, "")) || candidate.path.replace(/\.[^.]+$/, "").endsWith(imported.replace(/^\.\//, "")));
      if (target) edges.push({ from: record.path, to: target.path });
    }
  }
  return { edges: edges.slice(0, 128) };
}
function generateTestCases(text: string): { cases: string[] } {
  const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const cases = sentences.filter((s) => /\b(must|should|when|if|accept|return|reject|preserve|handle)\b/i.test(s)).slice(0, 16).map((s) => `Verify: ${s}`);
  return { cases: cases.length ? cases : ["Verify the requested behavior on the happy path.", "Verify invalid input fails safely.", "Verify the existing regression path remains green."] };
}
function detectSecrets(text: string): { findings: string[] } {
  const findings: string[] = [];
  const patterns: Array<[RegExp, string]> = [[/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}/i, "credential-like assignment"], [/-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----/i, "private key material"], [/gh[pousr]_[A-Za-z0-9_]{20,}/, "GitHub token pattern"], [/sk-[A-Za-z0-9]{20,}/, "OpenAI-style key pattern"]];
  for (const [pattern, label] of patterns) if (pattern.test(text)) findings.push(label);
  return { findings };
}
function deterministicPostflight(input: SidecarJobInput): { secrets: string[]; warnings: string[]; evidenceWarnings: string[]; recommendedTests: string[]; suggestedCommands: string[]; risk: "low" | "medium" | "high"; riskReasons: string[]; generatedTestCases: string[] } {
  const diff = input.diff ?? input.text ?? "";
  const review = reviewDiff(diff);
  const secrets = detectSecrets(diff);
  const evidence = auditEvidence(diff, input.facts ?? []);
  const risk = estimateRisk(diff);
  const selected = (input.tests ?? []).filter((test) => input.files?.some((file) => test.toLowerCase().includes(file.toLowerCase().replace(/\.[^.]+$/, ""))) ?? true).slice(0, 12);
  const commands = suggestCommands(input.files ?? [], input.tests ?? []);
  const cases = generateTestCases(input.text ?? diff);
  return { secrets: secrets.findings, warnings: review.warnings, evidenceWarnings: evidence.warnings, recommendedTests: selected, suggestedCommands: commands, risk: risk.level, riskReasons: risk.reasons, generatedTestCases: cases.cases };
}
function triageLogs(text: string): { severity: "error" | "warning" | "info"; signature: string; lines: string[] } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const severity = /fatal|panic|exception|error|failed/i.test(text) ? "error" : /warn|deprecated|retry/i.test(text) ? "warning" : "info";
  return { severity, signature: failureSignature(text), lines: lines.filter((line) => /fatal|panic|exception|error|failed|warn|deprecated|retry/i.test(line)).slice(-12) };
}
function draftCommit(text: string, diff: string): { title: string; body: string } {
  const source = (text || diff).replace(/^diff --git.*$/gm, "").trim();
  const title = (source.split(/\r?\n/).find(Boolean) ?? "update project").replace(/^[+#\-\s]+/, "").slice(0, 68);
  return { title: title.charAt(0).toUpperCase() + title.slice(1), body: "Summary of the bounded change.\n\nVerification: inspect the recorded execution receipts before committing." };
}
function findDuplicates(files: string[]): { duplicates: string[] } {
  const seen = new Set<string>(); const duplicates: string[] = [];
  for (const file of files) { const normalized = file.toLowerCase().replaceAll("\\", "/").replace(/\.(tsx?|jsx?|py|rs|go|java|cs)$/, ""); if (seen.has(normalized)) duplicates.push(file); else seen.add(normalized); }
  return { duplicates };
}
function estimateTokens(text: string): { characters: number; estimatedTokens: number } { return { characters: text.length, estimatedTokens: Math.ceil(text.length / 4) }; }
function summarizeTree(index: WorkspaceIndex | undefined): { files: number; bytes: number; tests: number; languages: Record<string, number> } {
  const overview = index?.overview();
  return overview ? { files: overview.files, bytes: overview.bytes, tests: overview.tests, languages: overview.languages } : { files: 0, bytes: 0, tests: 0, languages: {} };
}
