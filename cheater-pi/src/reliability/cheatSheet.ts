// The Cheat Layer: harness-owned evidence injection.
//
// The model never decides when to search, how to search, what to trust, or where the result
// goes. The harness observes a failure, classifies it, runs a bounded retrieval cascade over
// every evidence source it owns, compresses the result into at most three tiny evidence
// cards, and injects the rendered sheet exactly where the failure is being handed to a model
// (repair packets, auto-verify failure notices). Zero model-facing tools are involved.
//
// Trust ordering is explicit and conservative:
//   1. verified experience store  - fixes proven by a local fail->pass transition (high)
//   2. installed-API oracle       - the ACTUAL signatures/exports of the locally installed
//                                   package the failure names (high: environment fact)
//   3. compacted bug corpus       - someone else's verified bugs, analogies only (medium)
//   4. local project docs         - the repo's own README/docs lines (low)
//   5. official docs / web scout  - only when the user enabled online search (low)
//
// Every card is a HYPOTHESIS about the fix. The verifier (focused verification, finish
// gate) remains the only source of truth; the sheet says so in its own footer.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { indexRoot, resolveBugMemoryPath, searchBugMemories, type BugMemorySearchHit } from "../bug-memory.js";
import { blueprintConfig } from "../blueprint/config.js";
import { scoutOfficialDocs } from "../blueprint/docsScout.js";
import { probeInstalledApi, type ApiOracleResult } from "./apiOracle.js";
import { extractErrorType, failureTokens, recallExperienceCard } from "./experience.js";
import type { CheaterConfig } from "../types.js";

export type CheatTrigger =
  | "import_error"
  | "missing_dependency"
  | "library_api_error"
  | "syntax_error"
  | "assertion_failure"
  | "runtime_error"
  | "unknown";

export type EvidenceSource = "experience" | "api_oracle" | "bug_corpus" | "local_docs" | "official_docs";

export interface EvidenceCard {
  source: EvidenceSource;
  confidence: "high" | "medium" | "low";
  title: string;
  /** The hypothesized cause - never asserted as fact. */
  cause: string;
  /** The suggested fix pattern, compact. */
  fix: string;
  /** Exact verification command when the evidence carries one. */
  verify?: string;
}

export interface CheatSheet {
  trigger: CheatTrigger;
  packageHint?: string;
  symbolHint?: string;
  cards: EvidenceCard[];
}

export interface TriggerClassification {
  trigger: CheatTrigger;
  packageHint?: string;
  symbolHint?: string;
}

const MAX_CARDS = 3;
const CARD_FIELD_CHARS = 220;
const SHEET_MAX_CHARS = 1300;
// Corpus searches only run when the on-disk index already exists or the corpus is small
// enough to index instantly; a first-time index build over a 100MB+ corpus inside a grading
// step would stall the whole turn.
const MAX_UNINDEXED_CORPUS_BYTES = 16 * 1024 * 1024;

/**
 * Deterministic failure-kind classifier. Also extracts the package and symbol the failure
 * names, which drive both retrieval queries and the relevance gate (evidence that mentions
 * neither the package, the symbol, nor the error type is discarded as noise).
 */
export function classifyCheatTrigger(failureText: string): TriggerClassification {
  const text = failureText ?? "";

  const missingModule = text.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/)
    ?? text.match(/Cannot find module ['"]([^'"]+)['"]/)
    ?? text.match(/Missing module:\s*([\w@./-]+)/);
  if (missingModule) return { trigger: "import_error", packageHint: missingModule[1] };

  const cannotImport = text.match(/ImportError: cannot import name ['"]([^'"]+)['"] from ['"]([^'"]+)['"]/);
  if (cannotImport) return { trigger: "import_error", symbolHint: cannotImport[1], packageHint: cannotImport[2] };
  if (/ImportError|ERR_MODULE_NOT_FOUND|\bIMPORT\b/.test(text)) return { trigger: "import_error" };

  const noAttribute = text.match(/['"]?([\w.]+)['"]? object has no attribute ['"]([\w.]+)['"]/)
    ?? text.match(/AttributeError:.*?['"]([\w.]+)['"]/);
  if (noAttribute) return { trigger: "library_api_error", packageHint: noAttribute[1], symbolHint: noAttribute[2] };
  const notAFunction = text.match(/([\w.$]+)\.(\w+) is not a function/);
  if (notAFunction) return { trigger: "library_api_error", packageHint: notAFunction[1], symbolHint: notAFunction[2] };
  const noExportedMember = text.match(/has no exported member ['"]?(\w+)['"]?/);
  if (noExportedMember) return { trigger: "library_api_error", symbolHint: noExportedMember[1] };
  const keywordArg = text.match(/unexpected keyword argument ['"](\w+)['"]/);
  if (keywordArg) return { trigger: "library_api_error", symbolHint: keywordArg[1] };
  if (/TS2(3|5)\d\d\b/.test(text)) return { trigger: "library_api_error" };

  if (/SyntaxError|IndentationError|TabError|TS1\d{3}\b|\bSYNTAX\b/.test(text)) return { trigger: "syntax_error" };
  if (/AssertionError|expected .* (got|received)|\d+ (test|tests)? ?failed|\bFAILED\b|\bTEST\b/i.test(text)) return { trigger: "assertion_failure" };
  if (/\b\w+(Error|Exception)\b/.test(text)) return { trigger: "runtime_error" };
  return { trigger: "unknown" };
}

function clip(text: string, maxChars = CARD_FIELD_CHARS): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 3)}...`;
}

/** Corpus path when a search is affordable right now, else null (never stall a grade on an index build). */
export function usableBugCorpus(cwd: string, memoryPath?: string): string | null {
  const path = resolveBugMemoryPath(cwd, memoryPath);
  if (!path) return null;
  if (existsSync(indexRoot(cwd, path))) return path;
  try {
    return statSync(path).size <= MAX_UNINDEXED_CORPUS_BYTES ? path : null;
  } catch {
    return null;
  }
}

/**
 * Relevance gate for corpus hits: a lexical search over a huge corpus always returns
 * SOMETHING, so a hit only becomes evidence when it demonstrably concerns the same package,
 * symbol, or error type - or shares several significant failure tokens.
 */
export function corpusHitRelevant(hit: BugMemorySearchHit, classification: TriggerClassification, errorType: string, tokens: string[]): boolean {
  const hay = [hit.bugType, hit.symptom, hit.rootCause, hit.testSignal, ...(hit.searchKeywords ?? [])].join(" ").toLowerCase();
  if (classification.packageHint && hay.includes(classification.packageHint.toLowerCase())) return true;
  if (classification.symbolHint && hay.includes(classification.symbolHint.toLowerCase())) return true;
  // A shared error type is only evidence when the type itself is discriminating;
  // assertionerror/test_failure describe half of all bugs and would match anything.
  const genericTypes = new Set(["unknown", "test_failure", "assertionerror", "error"]);
  if (errorType && !genericTypes.has(errorType) && hay.includes(errorType.toLowerCase())) return true;
  const overlap = tokens.filter((token) => token.length >= 5 && hay.includes(token)).length;
  return overlap >= 3;
}

/** Scan the target repo's own docs (README + docs/*.md) for lines mentioning the failing package/symbol. */
export function localDocEvidence(cwd: string, terms: string[]): EvidenceCard | null {
  const wanted = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
  if (!wanted.length) return null;
  const candidates: string[] = ["README.md"];
  try {
    const docsDir = join(cwd, "docs");
    if (existsSync(docsDir)) {
      for (const name of readdirSync(docsDir).filter((n) => n.endsWith(".md")).slice(0, 6)) {
        candidates.push(join("docs", name));
      }
    }
  } catch { /* no docs dir */ }
  for (const rel of candidates) {
    const path = join(cwd, rel);
    if (!existsSync(path)) continue;
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    const line = text.split(/\r?\n/).find((item) => {
      const lower = item.toLowerCase();
      return wanted.some((term) => lower.includes(term)) && item.trim().length > 10;
    });
    if (!line) continue;
    return {
      source: "local_docs",
      confidence: "low",
      title: `project doc mention (${rel})`,
      cause: "the project's own docs mention the failing name; conventions there may explain the expected usage",
      fix: clip(line.trim()),
      verify: undefined
    };
  }
  return null;
}

/**
 * Map an installed-API probe to an evidence card. The extracted signatures/exports are
 * environment FACTS (hence high confidence); the fix suggestion built from them stays a
 * hypothesis like every other card. Returns null when the probe proved nothing useful.
 */
export function oracleEvidence(oracle: ApiOracleResult): EvidenceCard | null {
  const pkgLabel = `${oracle.packageName}${oracle.version ? `@${oracle.version}` : ""}`;
  if (!oracle.installed) {
    return {
      source: "api_oracle",
      confidence: "high",
      title: `${oracle.packageName} is not installed in this environment`,
      cause: `the failure references ${oracle.packageName}, which is neither installed nor declared here`,
      fix: "do not invent this dependency: fix the name/path to an installed package, or stop and ask the user before adding a dependency"
    };
  }
  if (oracle.symbol && oracle.symbolFound && oracle.declarations.length) {
    return {
      source: "api_oracle",
      confidence: "high",
      title: `installed API: ${pkgLabel} defines ${oracle.symbol}`,
      cause: `the failure involves ${oracle.symbol}; the installed version's actual declaration is below - match it exactly`,
      fix: clip(oracle.declarations.join(" | "), 300)
    };
  }
  if (oracle.symbol && !oracle.symbolFound && oracle.availableExports.length) {
    return {
      source: "api_oracle",
      confidence: "high",
      title: `installed API: ${pkgLabel} has no ${oracle.symbol}`,
      cause: `the installed version does not define ${oracle.symbol}; the name is wrong for THIS version`,
      fix: clip(`use one of the real exports instead: ${oracle.availableExports.join(", ")}`, 300)
    };
  }
  if (!oracle.symbol && oracle.availableExports.length) {
    return {
      source: "api_oracle",
      confidence: "high",
      title: `installed API surface: ${pkgLabel}`,
      cause: "the failure names this package; its installed exports are listed below",
      fix: clip(`exports: ${oracle.availableExports.join(", ")}`, 300)
    };
  }
  return null;
}

export interface CheatSheetOptions {
  /** Override corpus location (tests). */
  memoryPath?: string;
}

/**
 * The retrieval cascade. Returns null when there is nothing trustworthy to say - an
 * unclassifiable failure with no verified experience match produces NO sheet, because noisy
 * evidence is worse for a small model than none.
 */
export async function buildCheatSheet(cwd: string, failureText: string, config: CheaterConfig = {}, opts: CheatSheetOptions = {}): Promise<CheatSheet | null> {
  if (config.cheatSheetEnabled === false) return null;
  const text = (failureText ?? "").trim();
  if (!text) return null;

  const classification = classifyCheatTrigger(text);
  const errorType = extractErrorType(text);
  const tokens = failureTokens(text);
  const cards: EvidenceCard[] = [];

  // 1. Verified local experience - a fix proven by a fail->pass transition in this repo.
  if (config.experienceStoreEnabled !== false) {
    const hit = recallExperienceCard(cwd, text);
    if (hit) {
      cards.push({
        source: "experience",
        confidence: "high",
        title: hit.card.goal ? `verified fix for: ${clip(hit.card.goal, 80)}` : "verified prior fix in this repo",
        cause: clip(`previously failed the same way: ${hit.card.failureText}`),
        fix: clip(`${hit.card.fixSummary}${hit.card.files.length ? ` (files: ${hit.card.files.slice(0, 3).join(", ")})` : ""}`, 300),
        verify: undefined
      });
    }
  }

  // An unknown failure kind with no verified experience: stay silent rather than guess.
  if (classification.trigger === "unknown" && !cards.length) return null;

  // 2. Installed-API oracle: what the failure's package ACTUALLY exposes in this
  // environment. An environment fact beats any analogy or doc, so it outranks them.
  if (
    cards.length < MAX_CARDS
    && (classification.trigger === "library_api_error" || classification.trigger === "import_error")
    && classification.packageHint
  ) {
    try {
      const oracle = probeInstalledApi(cwd, classification.packageHint, classification.symbolHint, text);
      const card = oracle ? oracleEvidence(oracle) : null;
      if (card) cards.push(card);
    } catch { /* the oracle never blocks the cascade */ }
  }

  // 3. Compacted bug corpus - analogies from other repos' verified bugs.
  if (cards.length < MAX_CARDS && classification.trigger !== "unknown") {
    const corpus = usableBugCorpus(cwd, opts.memoryPath);
    if (corpus) {
      try {
        const query = [errorType, classification.packageHint, classification.symbolHint, ...tokens.slice(0, 10)].filter(Boolean).join(" ");
        const result = await searchBugMemories({ cwd, query, topK: 3, memoryPath: corpus });
        for (const hit of result.hits) {
          if (cards.length >= MAX_CARDS) break;
          if (!corpusHitRelevant(hit, classification, errorType, tokens)) continue;
          cards.push({
            source: "bug_corpus",
            confidence: "medium",
            title: clip(`similar ${hit.bugType || "bug"} seen in ${hit.repo || "another repo"}`, 90),
            cause: clip(hit.rootCause || hit.symptom),
            fix: clip(hit.fixPattern, 300),
            verify: hit.testSignal ? clip(hit.testSignal, 120) : undefined
          });
        }
      } catch { /* corpus unavailable: cascade continues */ }
    }
  }

  // 4. The target repo's own docs, keyed by the failing package/symbol name.
  if (cards.length < MAX_CARDS && (classification.packageHint || classification.symbolHint)) {
    const docCard = localDocEvidence(cwd, [classification.packageHint ?? "", classification.symbolHint ?? ""].filter(Boolean));
    if (docCard) cards.push(docCard);
  }

  // 5. Official docs / web - only when the user explicitly enabled online search.
  if (cards.length < MAX_CARDS && classification.packageHint && config.blueprintOfficialDocsSearchEnabled === true) {
    try {
      const facts = await scoutOfficialDocs({
        cwd,
        query: `${classification.packageHint} ${classification.symbolHint ?? ""} ${errorType}`.trim(),
        packageOrLibrary: classification.packageHint,
        config: blueprintConfig(config)
      });
      const fact = facts.find((f) => f.sourceDomain !== "local");
      if (fact) {
        cards.push({
          source: "official_docs",
          confidence: "low",
          title: clip(`official docs: ${fact.sourceTitle}`, 90),
          cause: clip(`documentation for ${classification.packageHint} may describe the correct usage`),
          fix: clip(fact.claim, 300),
          verify: undefined
        });
      }
    } catch { /* network evidence is strictly optional */ }
  }

  if (!cards.length) return null;
  return {
    trigger: classification.trigger,
    packageHint: classification.packageHint,
    symbolHint: classification.symbolHint,
    cards: cards.slice(0, MAX_CARDS)
  };
}

/** Render the sheet for in-band injection: tiny, hypothesis-framed, verifier-deferential. */
export function renderCheatSheet(sheet: CheatSheet, verificationCommand?: string): string {
  const lines: string[] = [
    "=== CHEATER CHEAT SHEET (evidence = hypotheses, not truth) ===",
    `trigger: ${sheet.trigger}${sheet.packageHint ? ` (package: ${sheet.packageHint})` : ""}${sheet.symbolHint ? ` (symbol: ${sheet.symbolHint})` : ""}`
  ];
  sheet.cards.forEach((card, index) => {
    lines.push(`[${index + 1}] ${card.source}/${card.confidence}: ${card.title}`);
    lines.push(`    cause: ${card.cause}`);
    lines.push(`    fix: ${card.fix}`);
    if (card.verify) lines.push(`    verify: ${card.verify}`);
  });
  if (verificationCommand) lines.push(`verify with: ${verificationCommand}`);
  lines.push("Apply the best-matching hypothesis ONLY if it matches the local code; the verifier decides, not this sheet.");
  const rendered = lines.join("\n");
  return rendered.length <= SHEET_MAX_CHARS ? rendered : `${rendered.slice(0, SHEET_MAX_CHARS - 15)}\n... [clipped]`;
}
