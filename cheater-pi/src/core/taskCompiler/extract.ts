// Task Compiler — Stage 1: literal extraction.
//
// Extract ONLY what the user actually said. This stage is deliberately incapable of inventing an
// implementation detail: it has no repository access, no model call on the critical path, and no
// defaults. Everything it returns is traceable to a span of the user's own text.
//
// It reuses the existing deterministic acceptance-contract extractor (src/runstate/contract.ts) rather
// than growing a second regex corpus beside it — that module already knows how to tell an output file
// from an input file, a command from a bare identifier, and a real symbol declaration from prose.

import { extractAcceptanceContract, type AcceptanceContract } from "../../runstate/contract.js";
import { normalizePathForPrompt } from "../promptEpoch.js";

export interface LiteralExtraction {
  /** The user's request, whitespace-normalized but otherwise untouched. */
  rawRequest: string;
  /** A single-line objective derived from the request — normalization only, never reinterpretation. */
  statedOutcome: string;
  /** Literal artifacts the text names. */
  contract: AcceptanceContract;
  /** Technologies the user explicitly asked for (never inferred from the repo at this stage). */
  requestedTechnologies: string[];
  /** Sentences carrying an explicit obligation ("must", "should", "needs to"). */
  explicitConstraints: string[];
  /**
   * Items of a bulleted/numbered specification list.
   *
   * People write requirements as a list far more often than as prose containing the word "must" —
   * `- add(self, text) -> int — returns the new id` is an obligation, and reading only the header
   * sentence ("`todo.py` must expose:") threw the actual contract away. Measured on the bakeoff
   * battery: prompts stating 5-8 obligations compiled down to 1-2 requirements.
   */
  specBullets: string[];
  /** Explicit prohibitions ("do not", "never", "without changing"). */
  prohibitions: string[];
  /** Compatibility demands ("keep X working", "backward compatible", "without breaking"). */
  compatibility: string[];
  /** Worked examples / sample I/O the user supplied, including fenced code blocks. */
  examples: string[];
  /** Verification the user explicitly asked for. */
  requestedVerification: string[];
  /** Output-format facts the user stated. */
  requestedOutputFormat: string[];
  /** True when the user asked a question rather than requesting a change. */
  isQuestion: boolean;
}

/** Technologies worth recording: naming one is a hard constraint on the implementation. Matching is
 *  word-boundary exact, so "reacting to input" never becomes a React dependency. */
const TECHNOLOGY_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\breact\b/i, "react"], [/\bvue\b/i, "vue"], [/\bsvelte(?:kit)?\b/i, "svelte"], [/\bangular\b/i, "angular"],
  [/\bnext\.?js\b/i, "next.js"], [/\bnuxt\b/i, "nuxt"], [/\bexpress\b/i, "express"], [/\bfastify\b/i, "fastify"],
  [/\bflask\b/i, "flask"], [/\bdjango\b/i, "django"], [/\bfastapi\b/i, "fastapi"], [/\brails\b/i, "rails"],
  [/\bspring\s?boot\b/i, "spring boot"], [/\btailwind\b/i, "tailwind"], [/\bbootstrap\b/i, "bootstrap"],
  [/\btypescript\b/i, "typescript"], [/\bjavascript\b/i, "javascript"], [/\bpython\b/i, "python"],
  [/\brust\b/i, "rust"], [/\bgolang\b|\bgo\s+(?:module|package|program)\b/i, "go"], [/\bjava\b(?!script)/i, "java"],
  [/\bc#\b|\bcsharp\b|\bdotnet\b|\b\.net\b/i, "dotnet"], [/\bsqlite\b/i, "sqlite"], [/\bpostgres(?:ql)?\b/i, "postgres"],
  [/\bmysql\b/i, "mysql"], [/\bmongo(?:db)?\b/i, "mongodb"], [/\bredis\b/i, "redis"], [/\bdocker\b/i, "docker"],
  [/\bcanvas\b/i, "canvas"], [/\bwebgl\b/i, "webgl"], [/\bhtml\b/i, "html"], [/\bcss\b/i, "css"],
  [/\bpytest\b/i, "pytest"], [/\bvitest\b/i, "vitest"], [/\bjest\b/i, "jest"], [/\bmocha\b/i, "mocha"],
];

const OBLIGATION_RE = /\b(must|should|need(?:s|ed)? to|has to|have to|shall|required to|make sure|ensure)\b/i;
const COMPATIBILITY_RE = /\b(backward[- ]compatible|backwards[- ]compatible|without breaking|keep .{1,40}\bworking\b|remain(?:s)? unchanged|still (?:work|works|pass|passes)|do not break|don'?t break|preserve (?:the )?(?:existing|current)\b)/i;
const VERIFICATION_RE = /\b(test|tests|verify|verified|verification|assert|check that|prove|typecheck|type-check|lint|build passes|exit code)\b/i;
const QUESTION_RE = /^\s*(what|why|how|where|which|who|when|does|do|is|are|can|could|should i|explain|describe|tell me|show me|summari[sz]e)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function dedupe(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
    if (out.length >= max) break;
  }
  return out;
}

/** Fenced code blocks and `input → output` lines are worked examples: the user's own ground truth. */
/**
 * Endpoints written with the keyword AFTER the path — "a /health endpoint", "the /login route".
 * The shared contract extractor only recognizes the keyword-first form ("endpoint: /health") and the
 * multi-segment bare form ("/api/health"), so a single-segment route introduced this way was dropped
 * entirely — and a dropped endpoint is a dropped deliverable, which is how a contract quietly loses
 * the one artifact an evaluator will actually request.
 */
const TRAILING_KEYWORD_ENDPOINT_RE = /(\/[A-Za-z0-9_-][A-Za-z0-9_\-./{}]*)\s+(?:endpoint|route|url|api|path)\b/gi;

function extractTrailingKeywordEndpoints(text: string, files: string[]): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TRAILING_KEYWORD_ENDPOINT_RE)) {
    const raw = match[1].replace(/[.,;:)]+$/, "");
    // A path with a file extension is a file, not a route.
    if (/\.[a-z0-9]{1,5}$/i.test(raw) && !raw.includes("{")) continue;
    if (files.some((file) => raw.endsWith(file))) continue;
    found.push(raw);
  }
  return found;
}

function extractExamples(text: string): string[] {
  const examples: string[] = [];
  for (const match of text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)) {
    const body = match[1].trim();
    if (body) examples.push(body.slice(0, 600));
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(?:e\.?g\.?|for example|example)[:,]/i.test(trimmed) || /(?:=>|->|→)\s*\S/.test(trimmed)) {
      examples.push(trimmed.slice(0, 300));
    }
  }
  return dedupe(examples, 8);
}

/** One-line objective. Strips a leading politeness/imperative wrapper but never re-words the ask. */
function statedOutcome(text: string): string {
  const first = sentences(text)[0] ?? text;
  const cleaned = first
    .replace(/^\s*(?:please|hey|hi|ok(?:ay)?|so)[,!\s]+/i, "")
    .replace(/^\s*(?:can|could|would)\s+you\s+(?:please\s+)?/i, "")
    .replace(/^\s*i\s+(?:want|need|would like)\s+(?:you\s+to\s+)?/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || text.replace(/\s+/g, " ").trim()).slice(0, 240);
}

export function extractLiterals(request: string): LiteralExtraction {
  const text = (request ?? "").replace(/\r\n?/g, "\n");
  const contract = extractAcceptanceContract(text);
  const parts = sentences(text);

  const requestedTechnologies: string[] = [];
  for (const [pattern, name] of TECHNOLOGY_PATTERNS) if (pattern.test(text)) requestedTechnologies.push(name);

  const prohibitions = dedupe(contract.forbidden, 12);
  // An obligation sentence that is really a prohibition ("must not touch the parser") already lives in
  // `prohibitions`; recording it twice would double it in the rendered contract.
  const explicitConstraints = dedupe(
    parts.filter((s) => OBLIGATION_RE.test(s) && !prohibitions.some((p) => s.includes(p))),
    12,
  );

  // A LIST is how a specification is usually written. Only treat it as one when there are at least
  // two items (a lone bullet is prose) and the item carries content, and never re-record something
  // already captured as an obligation, prohibition or compatibility demand.
  const bulletLines = text
    .split("\n")
    .map((line) => line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => m[1].trim())
    .filter((line) => line.length >= 12);
  const specBullets = bulletLines.length >= 2
    ? dedupe(
      bulletLines.filter((line) =>
        !prohibitions.some((p) => line.includes(p))
        && !explicitConstraints.some((c) => c.includes(line) || line.includes(c))
        && !COMPATIBILITY_RE.test(line)),
      12,
    )
    : [];

  const endpoints = dedupe([...contract.endpoints, ...extractTrailingKeywordEndpoints(text, contract.files)], 8);

  return {
    rawRequest: text.trim(),
    statedOutcome: statedOutcome(text),
    contract: {
      ...contract,
      files: contract.files.map(normalizePathForPrompt),
      outputPaths: contract.outputPaths.map(normalizePathForPrompt),
      endpoints,
    },
    requestedTechnologies: dedupe(requestedTechnologies, 8),
    explicitConstraints,
    specBullets,
    prohibitions,
    compatibility: dedupe(parts.filter((s) => COMPATIBILITY_RE.test(s)), 6),
    examples: extractExamples(text),
    requestedVerification: dedupe(parts.filter((s) => VERIFICATION_RE.test(s)), 6),
    requestedOutputFormat: dedupe(contract.outputFormat, 5),
    isQuestion: QUESTION_RE.test(text.trim()) || /\?\s*$/.test(text.trim()),
  };
}

/** Does the request already name a concrete artifact to produce or change? */
export function namesConcreteArtifact(literals: LiteralExtraction): boolean {
  const c = literals.contract;
  return Boolean(c.files.length || c.outputPaths.length || c.symbols.length || c.endpoints.length || c.commands.length);
}
