// Acceptance contract: the literal terms of the task, extracted deterministically.
//
// Small models drift toward "a nearby task": the goal says output.json and they write
// results.json; the goal says /api/health and they validate /. This module freezes the exact
// artifacts, paths, commands, endpoints, and names the task text mentions BEFORE any
// implementation, so every worker capsule and every finish-gate check can compare against the
// literal contract instead of the model's paraphrase. Extraction is pure regex - no LLM call,
// no network - because a deterministic 90% beats a clever 99% that sometimes rewrites the task.

import { join } from "node:path";
import { readRunFile, writeRunFile } from "./runDir.js";

export interface AcceptanceContract {
  goal: string;
  /** Exact file paths the task text names. */
  files: string[];
  /** Files named near an output/creation verb - the artifacts an evaluator likely reads. */
  outputPaths: string[];
  /** Exact commands or scripts the task text names. */
  commands: string[];
  /** Exact URL paths / API endpoints. */
  endpoints: string[];
  ports: number[];
  /** Exact function/class/symbol names. */
  symbols: string[];
  /** Literal format facts (columns, keys, ordering). */
  outputFormat: string[];
  /** Forbidden behavior stated in the task. */
  forbidden: string[];
  /** Environment restrictions (versions, offline, no installs). */
  environment: string[];
  /** Performance/latency thresholds. */
  performance: string[];
  /** Deterministic guesses at what a hidden evaluator will touch. */
  evaluatorHints: string[];
  /** Final validation checklist derived from all of the above. */
  checklist: string[];
}

// The trailing lookahead must tolerate sentence punctuation: task texts constantly end
// sentences with a filename ("write to output.json."), and rejecting a dot outright would
// silently drop the single most important artifact of the contract.
const FILE_RE =
  /(?<![\w@/])((?:[\w.-]+[\\/])*[\w-][\w.-]*\.(?:json|jsonl|csv|tsv|txt|md|py|ts|tsx|js|jsx|mjs|cjs|yaml|yml|toml|ini|cfg|xml|html|css|sh|ps1|bat|go|rs|java|rb|c|cc|cpp|h|hpp|sql|log|db|sqlite|lock|env|conf))(?!\w|\.\w)/g;

const OUTPUT_VERB_RE = /\b(writes?|written|wrote|sav(?:e|es|ed|ing)|outputs?|produc(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|creat(?:e|es|ed|ing)|emit(?:s|ted)?|exports?|dumps?|stores?)\b/i;

const COMMAND_RUNNER_RE =
  /^(npm|npx|pnpm|yarn|bun|node|deno|python3?|py|pytest|pip3?|uv|poetry|make|cargo|go|rustc|dotnet|mvn|gradle|bash|sh|zsh|ruby|bundle|rake|php|composer|docker|curl|\.[\\/])/;

const ENDPOINT_RE = /(?:\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+|\b(?:endpoint|route|url|path|serve[sd]? at|listen(?:s|ing)? (?:at|on))s?\s*:?\s*)[`"']?(\/[A-Za-z0-9_\-./:{}<>]*)/gi;

const SYMBOL_DECL_RE = /\b(?:function|class|method|def|interface|struct|trait|type)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/g;

function sentences(text: string): string[] {
  return (text ?? "").split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function dedupe(items: string[], max: number): string[] {
  return [...new Set(items.map((i) => i.trim()).filter(Boolean))].slice(0, max);
}

function backtickSpans(text: string): string[] {
  const spans: string[] = [];
  const re = /`([^`\n]{1,160})`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text ?? "")) !== null) spans.push(match[1].trim());
  return spans;
}

function extractFiles(text: string): string[] {
  const hits: string[] = [];
  let match: RegExpExecArray | null;
  FILE_RE.lastIndex = 0;
  while ((match = FILE_RE.exec(text ?? "")) !== null) hits.push(match[1].replace(/\\/g, "/"));
  return dedupe(hits, 12);
}

function extractOutputPaths(text: string, files: string[]): string[] {
  const out: string[] = [];
  for (const sentence of sentences(text)) {
    if (!OUTPUT_VERB_RE.test(sentence)) continue;
    for (const file of files) {
      if (sentence.includes(file) || sentence.replace(/\\/g, "/").includes(file)) out.push(file);
    }
  }
  return dedupe(out, 8);
}

function extractCommands(text: string): string[] {
  const commands: string[] = [];
  for (const span of backtickSpans(text)) {
    // A command span has a runner prefix; a bare identifier or path is not a command.
    if (COMMAND_RUNNER_RE.test(span) && (span.includes(" ") || /^(make|pytest)$/.test(span))) commands.push(span);
  }
  // "make <target>" must not swallow plain English ("make the app faster").
  const bare =
    /\b((?:npm|npx|pnpm|yarn)\s+(?:run\s+)?[\w:.-]+|pytest\s+[\w\/.:-]+|python3?\s+[\w\/.-]+\.py(?:\s+[\w./=-]+)*|make\s+(?!the\b|a\b|an\b|it\b|sure\b|this\b|that\b|them\b|these\b|those\b|me\b|us\b|your\b|our\b|every\b|all\b)[\w.-]+|cargo\s+(?:test|build|run|check)\b[^\n.,;]*|go\s+(?:test|build|run|vet)\b[^\n.,;]*)/g;
  let match: RegExpExecArray | null;
  while ((match = bare.exec(text ?? "")) !== null) commands.push(match[1].trim());
  return dedupe(commands, 8);
}

function extractEndpoints(text: string, files: string[]): string[] {
  const endpoints: string[] = [];
  let match: RegExpExecArray | null;
  ENDPOINT_RE.lastIndex = 0;
  while ((match = ENDPOINT_RE.exec(text ?? "")) !== null) {
    const raw = match[1].replace(/[`"'.,)]+$/g, "");
    if (raw.length > 1 || raw === "/") endpoints.push(raw);
  }
  for (const span of backtickSpans(text)) {
    if (/^\/[A-Za-z0-9_\-./:{}<>]*$/.test(span) && !files.includes(span.replace(/^\//, ""))) {
      endpoints.push(span.replace(/[.,)]+$/g, ""));
    }
  }
  // Bare multi-segment URL paths ("answer on /api/health") carry enough shape to extract
  // even without a keyword prefix; single-segment ones still need the keyword context above.
  const bareMultiSegment = /(?:^|\s)(\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_{}-]+)+)(?=[\s.,;!?)]|$)/g;
  let bare: RegExpExecArray | null;
  while ((bare = bareMultiSegment.exec(text ?? "")) !== null) endpoints.push(bare[1]);
  // A path with a file extension is a file, not an endpoint.
  return dedupe(endpoints.filter((e) => !/\.[a-z0-9]{1,5}$/i.test(e) || e.includes("{")), 8);
}

function extractPorts(text: string): number[] {
  const ports = new Set<number>();
  const patterns = [/\bports?\s*[=:]?\s*(\d{2,5})\b/gi, /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text ?? "")) !== null) {
      const port = Number(match[1]);
      if (port >= 20 && port <= 65535) ports.add(port);
    }
  }
  return [...ports].slice(0, 4);
}

function extractSymbols(text: string, files: string[], commands: string[]): string[] {
  const symbols: string[] = [];
  let match: RegExpExecArray | null;
  SYMBOL_DECL_RE.lastIndex = 0;
  while ((match = SYMBOL_DECL_RE.exec(text ?? "")) !== null) symbols.push(match[1]);
  for (const span of backtickSpans(text)) {
    const bare = span.replace(/\(\)$/, "");
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(bare) &&
      bare.length >= 3 &&
      !files.some((f) => f.includes(bare)) &&
      !commands.includes(span) &&
      !COMMAND_RUNNER_RE.test(span)
    ) {
      symbols.push(bare);
    }
  }
  return dedupe(symbols, 8);
}

function extractOutputFormat(text: string): string[] {
  const facts: string[] = [];
  for (const sentence of sentences(text)) {
    if (/\bcolumns?\b/i.test(sentence) || (/\bheaders?\b/i.test(sentence) && /\b(csv|tsv)\b/i.test(text))) {
      facts.push(sentence.slice(0, 160));
    } else if (/\bkeys?\b/i.test(sentence) && /\bjson\b/i.test(sentence)) {
      facts.push(sentence.slice(0, 160));
    } else if (/\bone per line\b|\bsorted\b|\balphabetical\b|\bnewline[- ]delimited\b|\bexact(?:ly)? match\b/i.test(sentence)) {
      facts.push(sentence.slice(0, 160));
    }
  }
  return dedupe(facts, 5);
}

function extractForbidden(text: string): string[] {
  const forbidden: string[] = [];
  const re = /\b(do not|do n't|don'?t|must not|never|avoid|no extra|without (?:modifying|changing|touching))\b/i;
  for (const sentence of sentences(text)) {
    const match = sentence.match(re);
    if (match && match.index !== undefined) {
      // Slice the clause STARTING at the prohibition keyword, not the sentence prefix. A compressed
      // goal joins many requirements into one long comma-list, so the "do not X" is often buried and
      // the prefix (e.g. "Implementation: organize code cleanly...") is the WRONG thing to record as
      // forbidden (observed live: implementation requirements landed in the forbidden field).
      forbidden.push(sentence.slice(match.index, match.index + 140).trim());
    }
  }
  return dedupe(forbidden, 5);
}

function extractEnvironment(text: string): string[] {
  const env: string[] = [];
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/\bpython\s*(3(?:\.\d+)?)\b/i, (m) => `python ${m[1]}`],
    [/\bnode(?:\.?js)?\s*v?(\d+)\b/i, (m) => `node ${m[1]}`],
    [/\b(offline|no network|no internet|air-?gapped)\b/i, () => "no network access"],
    [/\b(do not|don'?t|without)\s+install/i, () => "no new installs"],
    [/\bonly\s+(?:the\s+)?standard library\b|\bstdlib[- ]only\b/i, () => "standard library only"]
  ];
  for (const [re, render] of patterns) {
    const match = (text ?? "").match(re);
    if (match) env.push(render(match));
  }
  return dedupe(env, 5);
}

function extractPerformance(text: string): string[] {
  const perf: string[] = [];
  const re = /\b(?:under|within|less than|at most|no more than|faster than)\s+\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|minutes?|mb|gb)\b[^.\n]{0,60}/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text ?? "")) !== null) perf.push(match[0].trim().slice(0, 120));
  return dedupe(perf, 4);
}

function buildEvaluatorHints(contract: Omit<AcceptanceContract, "evaluatorHints" | "checklist">): string[] {
  const hints: string[] = [];
  if (contract.outputPaths.length) hints.push(`Evaluator likely reads ${contract.outputPaths[0]} directly - re-read that exact file after generating it.`);
  else if (contract.files.length) hints.push(`Evaluator likely inspects ${contract.files[0]} - keep the exact name and path.`);
  if (contract.endpoints.length) hints.push(`Evaluator likely requests ${contract.endpoints[0]} exactly - validating a different path proves nothing.`);
  if (contract.commands.length) hints.push(`Evaluator may run \`${contract.commands[0]}\` - make sure it exits 0.`);
  return hints.slice(0, 3);
}

function buildChecklist(contract: Omit<AcceptanceContract, "checklist">): string[] {
  const checklist: string[] = [];
  for (const path of contract.outputPaths.slice(0, 3)) checklist.push(`Re-open ${path} and confirm its content and format.`);
  for (const endpoint of contract.endpoints.slice(0, 3)) checklist.push(`Request ${endpoint} (that exact path) and check the response.`);
  for (const command of contract.commands.slice(0, 2)) checklist.push(`Run \`${command}\` and confirm exit code 0.`);
  for (const symbol of contract.symbols.slice(0, 2)) checklist.push(`Confirm ${symbol} exists with that exact name.`);
  for (const fact of contract.outputFormat.slice(0, 2)) checklist.push(`Check format requirement: ${fact}`);
  for (const rule of contract.forbidden.slice(0, 2)) checklist.push(`Confirm still true: ${rule}`);
  return checklist.slice(0, 8);
}

/** Extract the literal acceptance contract from a task/goal text. Pure and deterministic. */
export function extractAcceptanceContract(goal: string): AcceptanceContract {
  const text = goal ?? "";
  const files = extractFiles(text);
  const commands = extractCommands(text);
  const partial = {
    goal: text.slice(0, 600),
    files,
    outputPaths: extractOutputPaths(text, files),
    commands,
    endpoints: extractEndpoints(text, files),
    ports: extractPorts(text),
    symbols: extractSymbols(text, files, commands),
    outputFormat: extractOutputFormat(text),
    forbidden: extractForbidden(text),
    environment: extractEnvironment(text),
    performance: extractPerformance(text)
  };
  const evaluatorHints = buildEvaluatorHints(partial);
  const checklist = buildChecklist({ ...partial, evaluatorHints });
  return { ...partial, evaluatorHints, checklist };
}

/** Compact one-block summary for capsules and controller.md. Bounded. */
export function summarizeContract(contract: AcceptanceContract, maxChars = 700): string {
  const lines: string[] = [];
  if (contract.outputPaths.length) lines.push(`outputs: ${contract.outputPaths.join(", ")}`);
  const otherFiles = contract.files.filter((f) => !contract.outputPaths.includes(f));
  if (otherFiles.length) lines.push(`files: ${otherFiles.slice(0, 6).join(", ")}`);
  if (contract.endpoints.length) lines.push(`endpoints: ${contract.endpoints.join(", ")}`);
  if (contract.ports.length) lines.push(`ports: ${contract.ports.join(", ")}`);
  if (contract.commands.length) lines.push(`commands: ${contract.commands.slice(0, 4).join(" | ")}`);
  if (contract.symbols.length) lines.push(`symbols: ${contract.symbols.join(", ")}`);
  if (contract.outputFormat.length) lines.push(`format: ${contract.outputFormat[0]}`);
  if (contract.forbidden.length) lines.push(`forbidden: ${contract.forbidden.slice(0, 2).join(" | ")}`);
  if (contract.environment.length) lines.push(`environment: ${contract.environment.join(", ")}`);
  if (contract.performance.length) lines.push(`performance: ${contract.performance.join(", ")}`);
  if (!lines.length) lines.push("(no literal artifacts named in the task text)");
  const text = lines.join("\n");
  return text.length <= maxChars ? text : text.slice(0, maxChars - 12) + "\n... [clipped]";
}

export function saveContract(runDir: string, contract: AcceptanceContract): string {
  return writeRunFile(runDir, "contract.json", JSON.stringify(contract, null, 2) + "\n");
}

export function loadContract(runDir: string): AcceptanceContract | null {
  const raw = readRunFile(runDir, "contract.json");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AcceptanceContract;
  } catch {
    return null;
  }
}

export function contractPath(runDir: string): string {
  return join(runDir, "contract.json");
}
