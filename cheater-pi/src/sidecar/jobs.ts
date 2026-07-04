// Sidecar jobs: bounded fuzzy chores expressed as pure functions of a SidecarClient plus a
// deterministic fallback. A job NEVER trusts the sidecar blindly - it validates/clamps the
// output and, on anything missing or off-shape, returns the deterministic result instead. So
// every job works (in degraded form) even with the sidecar off, and the sidecar can only ever
// improve a result, never break or stall one.

import { clampBool, clampNum, clampStr, clampStrList, extractJsonObject } from "./schemas.js";
import type { SidecarClient, SidecarJobOutcome } from "./types.js";
import type { TaskKind } from "../autopilot/types.js";

const SIDECAR_SYSTEM =
  "You are a terse engineering clerk. You do not plan or write code. You compress the given "
  + "information into the exact small JSON shape requested and nothing else.";

/** A tiny, repair-ready distillation of a verification/tool failure. */
export interface FailureDistillation {
  /** One line: the single most likely cause. */
  cause: string;
  /** One line: the smallest concrete fix direction (not a full plan). */
  hint: string;
  /** Up to two short "do not do X again" notes to steer the next attempt off dead ends. */
  dontRepeat: string[];
}

// Matches an error-looking line: bare keywords AND camelCase *Error/*Exception tokens
// (AssertionError, TypeError, ModuleNotFoundError, RuntimeException) which have no internal
// word boundary and so are missed by a plain \bassert\b / \berror\b alternation.
const ERROR_LINE = /(^|\b)(error|failed|failure|assert(ion)?|exception|traceback|cannot|not\s+found|undefined|unresolved|TS\d{4}|[A-Za-z]*(Error|Exception))\b/i;

/** Deterministic distill: pick the strongest error-looking line as the cause; generic hint. */
export function deterministicDistill(failureText: string): FailureDistillation {
  const lines = (failureText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const causeLine = lines.find((line) => ERROR_LINE.test(line)) ?? lines[0] ?? "verification failed";
  return {
    cause: causeLine.slice(0, 200),
    hint: "Re-read the exact failing region and make the smallest change that satisfies the check; do not broaden scope.",
    dontRepeat: []
  };
}

/** Render a distillation as a compact block for injection into a repair packet's failure note. */
export function renderDistillation(distill: FailureDistillation): string {
  const lines = [
    "Repair focus (distilled):",
    `- likely cause: ${distill.cause}`,
    `- smallest fix: ${distill.hint}`
  ];
  if (distill.dontRepeat.length) lines.push(`- do not repeat: ${distill.dontRepeat.join("; ")}`);
  return lines.join("\n");
}

/**
 * Distill a raw failure (verification summary + failing output) into a tiny repair note. The
 * sidecar, when available, produces a sharper cause/hint and "don't repeat" list from the noise;
 * otherwise the deterministic distill is used. Bounded: 256-token budget, short timeout, strict
 * JSON extraction with per-field clamping.
 */
export async function distillFailureSidecar(
  client: SidecarClient,
  failureText: string,
  opts: { goal?: string; timeoutMs?: number } = {}
): Promise<SidecarJobOutcome<FailureDistillation>> {
  const label = "distill_failure";
  const deterministic = deterministicDistill(failureText);
  if (!client.available()) {
    return { value: deterministic, source: "deterministic", confidence: 0.4, note: "sidecar unavailable; used deterministic distill", label };
  }
  const prompt = [
    opts.goal ? `Task goal: ${opts.goal.slice(0, 200)}` : "",
    "A code change failed its check. Compress the failure below into this exact JSON:",
    '{"cause": "one line - the single most likely cause", "hint": "one line - the smallest fix direction", "dontRepeat": ["short note", "short note"]}',
    "Rules: base it ONLY on the failure text; no speculation beyond it; keep each field short; dontRepeat may be empty.",
    "",
    "Failure:",
    (failureText ?? "").slice(0, 4000)
  ].filter(Boolean).join("\n");

  const res = await client.complete({ system: SIDECAR_SYSTEM, prompt, maxOutputTokens: 256, timeoutMs: opts.timeoutMs, label });
  if (!res.ok) {
    return { value: deterministic, source: "deterministic", confidence: 0.4, note: `sidecar failed (${res.error}); used deterministic distill`, label };
  }
  const obj = extractJsonObject(res.text);
  const cause = clampStr(obj?.cause, 200);
  const hint = clampStr(obj?.hint, 200);
  const dontRepeat = clampStrList(obj?.dontRepeat ?? (obj as Record<string, unknown> | null)?.["dont_repeat"], 2, 120);
  if (!cause && !hint) {
    return { value: deterministic, source: "deterministic", confidence: 0.4, note: "sidecar output unusable; used deterministic distill", label };
  }
  return {
    value: { cause: cause ?? deterministic.cause, hint: hint ?? deterministic.hint, dontRepeat },
    source: "sidecar",
    confidence: 0.7,
    note: "sidecar distilled the failure",
    label
  };
}

const KNOWN_TASK_KINDS = new Set<TaskKind>([
  "explanation_only", "tiny_edit", "bug_fix", "test_failure", "feature_addition",
  "refactor", "tooling", "docs", "migration", "benchmark", "unknown"
]);

/** A second opinion on how to route a request, used ONLY to break a low-confidence deterministic tie. */
export interface RouteAssist {
  taskKind: TaskKind;
  /** Does this request change code (true) or is it a question/orientation (false)? */
  editIntent: boolean;
  confidence: number;
}

/**
 * Sidecar routing assist. The deterministic regex classifier is the floor and is authoritative for
 * clear cases; this is consulted ONLY when it is uncertain, and it can only refine taskKind /
 * edit-intent, never override a read-only or destructive deterministic verdict. Falls back to the
 * deterministic classification on anything missing or off-shape.
 */
export async function routeGoalSidecar(
  client: SidecarClient,
  message: string,
  deterministic: { taskKind: TaskKind; confidence: number },
  opts: { timeoutMs?: number } = {}
): Promise<SidecarJobOutcome<RouteAssist>> {
  const label = "route_goal";
  const fallback: RouteAssist = { taskKind: deterministic.taskKind, editIntent: deterministic.taskKind !== "explanation_only" && deterministic.taskKind !== "unknown", confidence: deterministic.confidence };
  if (!client.available()) return { value: fallback, source: "deterministic", confidence: deterministic.confidence, note: "sidecar unavailable; used regex routing", label };
  const prompt = [
    "Classify this coding-agent request into EXACTLY this JSON:",
    '{"taskKind": "one of: explanation_only|tiny_edit|bug_fix|test_failure|feature_addition|refactor|tooling|docs|migration|benchmark|unknown", "editIntent": true|false, "confidence": 0.0-1.0}',
    "editIntent is true if the user wants code changed, false if they only want an explanation/answer.",
    "",
    `Request: ${(message ?? "").slice(0, 600)}`
  ].join("\n");
  const res = await client.complete({ system: SIDECAR_SYSTEM, prompt, maxOutputTokens: 80, timeoutMs: opts.timeoutMs, label });
  if (!res.ok) return { value: fallback, source: "deterministic", confidence: deterministic.confidence, note: `sidecar failed (${res.error}); used regex routing`, label };
  const obj = extractJsonObject(res.text);
  const raw = clampStr(obj?.taskKind, 40) as TaskKind | undefined;
  const taskKind = raw && KNOWN_TASK_KINDS.has(raw) ? raw : undefined;
  if (!taskKind) return { value: fallback, source: "deterministic", confidence: deterministic.confidence, note: "sidecar routing off-shape; used regex routing", label };
  return {
    value: { taskKind, editIntent: clampBool(obj?.editIntent, fallback.editIntent), confidence: clampNum(obj?.confidence, 0, 1, 0.6) },
    source: "sidecar",
    confidence: 0.65,
    note: "sidecar refined a low-confidence route",
    label
  };
}

/** A compact, worker-ready set of context bullets. */
export interface CompressedCapsule {
  facts: string[];
}

/**
 * Compress a pile of raw repo facts/snippets into a few worker-ready bullets relevant to the goal.
 * Pure offload (the 35B never spends its tokens on this). Falls back to a deterministic head-slice
 * of the raw facts, so a worker packet always has context even with the sidecar off/wrong.
 */
export async function compressCapsuleSidecar(
  client: SidecarClient,
  rawFacts: string[],
  goal: string,
  opts: { maxFacts?: number; timeoutMs?: number } = {}
): Promise<SidecarJobOutcome<CompressedCapsule>> {
  const label = "compress_capsule";
  const maxFacts = opts.maxFacts ?? 6;
  const deterministic: CompressedCapsule = { facts: rawFacts.filter(Boolean).slice(0, maxFacts).map((f) => f.slice(0, 200)) };
  if (!client.available() || rawFacts.length <= maxFacts) {
    return { value: deterministic, source: "deterministic", confidence: 0.4, note: client.available() ? "few facts; no compression needed" : "sidecar unavailable; used raw facts", label };
  }
  const prompt = [
    `Goal: ${(goal ?? "").slice(0, 200)}`,
    `Compress these repo facts into at most ${maxFacts} short bullets that a coding worker needs for the goal. Keep exact names/paths. Output JSON:`,
    `{"facts": ["short bullet", "short bullet"]}`,
    "",
    rawFacts.slice(0, 40).map((f) => `- ${f}`).join("\n").slice(0, 4000)
  ].join("\n");
  const res = await client.complete({ system: SIDECAR_SYSTEM, prompt, maxOutputTokens: 400, timeoutMs: opts.timeoutMs, label });
  if (!res.ok) return { value: deterministic, source: "deterministic", confidence: 0.4, note: `sidecar failed (${res.error}); used raw facts`, label };
  const facts = clampStrList(extractJsonObject(res.text)?.facts, maxFacts, 200);
  if (!facts.length) return { value: deterministic, source: "deterministic", confidence: 0.4, note: "sidecar output unusable; used raw facts", label };
  return { value: { facts }, source: "sidecar", confidence: 0.6, note: "sidecar compressed the capsule facts", label };
}

/** A worker-ready context bundle prepared AHEAD by the clerk: compressed facts, a prioritized file
 *  order (a reordering of the caller's candidates - never new access), and short orientation notes. */
export interface ContextPrep {
  facts: string[];
  files: string[];
  orientation: string[];
}

/**
 * Prepare a commitlet's worker context ahead of time: compress the raw repo facts, prioritize which
 * of the candidate files matter most for the goal, and jot a couple of orientation notes ("where to
 * look"). This is the sidecar's flagship PARALLEL job - a CPU clerk runs it while the GPU model
 * writes the current file, so the next worker's context is ready with no wait ("no brakes"). It
 * supersedes compressCapsuleSidecar for the live loop.
 *
 * Doctrine-safe: the deterministic floor is exactly the pre-sidecar inputs (head-sliced facts,
 * candidate order as given, no orientation), and the clerk may only reorder/annotate - it can never
 * invent a file outside the caller's candidate set (the commitlet's own allowedFiles), so it widens
 * nothing and code still decides truth.
 */
export async function prepareContextSidecar(
  client: SidecarClient,
  input: { goal: string; rawFacts: string[]; candidateFiles: string[]; symbols?: string[]; contract?: string[]; siblings?: string[] },
  opts: { maxFacts?: number; maxFiles?: number; timeoutMs?: number } = {}
): Promise<SidecarJobOutcome<ContextPrep>> {
  const label = "prepare_context";
  const maxFacts = opts.maxFacts ?? 6;
  const maxFiles = opts.maxFiles ?? 5;
  const rawFacts = input.rawFacts ?? [];
  const candidates = (input.candidateFiles ?? []).filter(Boolean);
  const contract = (input.contract ?? []).filter(Boolean);
  const siblings = (input.siblings ?? []).filter(Boolean);
  const deterministic: ContextPrep = {
    facts: rawFacts.filter(Boolean).slice(0, maxFacts).map((fact) => fact.slice(0, 200)),
    files: candidates.slice(0, maxFiles),
    // Even with no clerk, a NEW file gets its acceptance CONTRACT as orientation - already-decided
    // terms (not planning), so the worker starts with the card instead of nothing.
    orientation: contract.slice(0, 3).map((line) => line.slice(0, 200))
  };
  // Fire the clerk when there is ANYTHING to organize: repo facts to compress, multiple files to
  // order, OR a contract/siblings to turn into a build card. That last case is the from-scratch /
  // create-heavy commitlet (new file, no repo facts) that used to leave the sidecar IDLE. Only skip
  // when there is genuinely nothing to do.
  const hasContractWork = contract.length > 0 || siblings.length > 0;
  if (!client.available() || (rawFacts.length <= maxFacts && candidates.length <= 1 && !hasContractWork)) {
    return { value: deterministic, source: "deterministic", confidence: 0.4, note: client.available() ? "context already minimal; no prep needed" : "sidecar unavailable; used deterministic context", label };
  }
  const prompt = [
    `Goal: ${(input.goal ?? "").slice(0, 200)}`,
    "Prepare a BUILD CARD for a coding worker for this goal. ORGANIZE the already-decided info below;",
    "do NOT invent requirements or plan new work. From ONLY what is given:",
    "1) order the candidate files most-relevant-first (EXACT paths; do not invent files),",
    `2) compress any facts into at most ${maxFacts} short bullets (keep exact names/paths),`,
    '3) write at most 4 orientation notes: what this file must export/satisfy (from the contract),',
    "   how it fits the sibling files, and the concrete pattern to match.",
    "Output JSON only:",
    '{"files": ["path"], "facts": ["bullet"], "orientation": ["note"]}',
    "",
    contract.length ? `Contract (already decided - restate concisely, add nothing):\n${contract.map((line) => `- ${line}`).join("\n")}` : "",
    siblings.length ? `Other files in this build (for consistency): ${siblings.slice(0, 10).join(", ")}` : "",
    `Candidate files:\n${candidates.map((file) => `- ${file}`).join("\n") || "- (new file being created)"}`,
    input.symbols?.length ? `Symbols: ${input.symbols.slice(0, 20).join(", ")}` : "",
    rawFacts.length ? `\nFacts:\n${rawFacts.slice(0, 40).map((fact) => `- ${fact}`).join("\n")}`.slice(0, 3500) : ""
  ].filter(Boolean).join("\n");
  const res = await client.complete({ system: SIDECAR_SYSTEM, prompt, maxOutputTokens: 500, timeoutMs: opts.timeoutMs, label });
  if (!res.ok) return { value: deterministic, source: "deterministic", confidence: 0.4, note: `sidecar failed (${res.error}); used deterministic context`, label };
  const obj = extractJsonObject(res.text);
  const facts = clampStrList(obj?.facts, maxFacts, 200);
  const orientation = clampStrList(obj?.orientation, 4, 200);
  // Keep only real candidates: the clerk may reorder/prune, never widen file access.
  const candidateSet = new Set(candidates);
  const files = clampStrList(obj?.files, maxFiles, 200).filter((file) => candidateSet.has(file));
  if (!facts.length && !orientation.length && !files.length) {
    return { value: deterministic, source: "deterministic", confidence: 0.4, note: "sidecar output unusable; used deterministic context", label };
  }
  return {
    value: {
      facts: facts.length ? facts : deterministic.facts,
      files: files.length ? files : deterministic.files,
      orientation: orientation.length ? orientation : deterministic.orientation
    },
    source: "sidecar",
    confidence: 0.6,
    note: `sidecar prepared context (${files.length} files, ${facts.length} facts, ${orientation.length} notes)`,
    label
  };
}

/** A "second pair of eyes" read of a diff: semantic concerns automated gates miss. Advisory only. */
export interface DiffReview {
  concerns: string[];
}

/**
 * Background reviewer: after a commitlet PASSES the deterministic gates (diff guard, health, tests,
 * typecheck), the sidecar reads the diff for the class of bugs those gates can't see - an inverted
 * condition, an off-by-one, a missing null/error path, a wrong variable, left-in debug/TODO. Purely
 * ADVISORY: it never blocks or satisfies a gate (code still decides truth); it surfaces concerns to
 * the user at final review. Deterministic floor = no concerns (a real review needs a model).
 */
export async function reviewDiffSidecar(
  client: SidecarClient,
  diffText: string,
  goal: string,
  opts: { timeoutMs?: number } = {}
): Promise<SidecarJobOutcome<DiffReview>> {
  const label = "review_diff";
  const empty: DiffReview = { concerns: [] };
  if (!client.available() || !(diffText ?? "").trim()) {
    return { value: empty, source: "deterministic", confidence: 0.3, note: "no review (sidecar off or empty diff)", label };
  }
  const prompt = [
    `Goal: ${(goal ?? "").slice(0, 200)}`,
    "You are a careful second reviewer. List up to 3 SPECIFIC concerns about this diff that passing tests might miss:",
    "inverted condition, off-by-one, missing null/error handling, wrong variable used, left-in debug/TODO, mismatched signature.",
    "Be concrete and cite the code. If the diff looks correct, return an empty list. Output JSON only:",
    '{"concerns": ["short specific concern with the symbol/line", "..."]}',
    "",
    (diffText ?? "").slice(0, 4000)
  ].join("\n");
  const res = await client.complete({ system: SIDECAR_SYSTEM, prompt, maxOutputTokens: 320, timeoutMs: opts.timeoutMs, label });
  if (!res.ok) return { value: empty, source: "deterministic", confidence: 0.3, note: `sidecar failed (${res.error})`, label };
  const concerns = clampStrList(extractJsonObject(res.text)?.concerns, 3, 220);
  return {
    value: { concerns },
    source: concerns.length ? "sidecar" : "deterministic",
    confidence: 0.5,
    note: concerns.length ? `sidecar flagged ${concerns.length} concern(s)` : "sidecar reviewed: no concerns",
    label
  };
}
