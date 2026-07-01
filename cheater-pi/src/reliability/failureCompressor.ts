// Deterministic failure compressor: turn raw pytest / jest / vitest / tsc / node output into
// a tight structured card the model can act on. Raw test logs are the single worst context
// killer for a small local model; a ~10-line card with expected/got, the top stack file, and
// one imperative next-action line is what a weak instruction-follower localizes from.
//
// Ported from the legacy Python cheater/failure_compressor.py, extended to JS/TS toolchains.

export interface FailureEntry {
  test: string;
  errorType: string;
  message: string;
  expected: string;
  got: string;
  topStackFiles: string[];
}

export interface FailureSummary {
  command: string;
  passed: boolean;
  exitCode: number;
  errorType: string;
  summary: string;
  isSyntaxError: boolean;
  isImportError: boolean;
  isTestFailure: boolean;
  failures: FailureEntry[];
  nextAction: string;
  tail: string;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return (text ?? "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function clip(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text ?? "";
  return `${text.slice(0, Math.max(0, maxChars - 15))}\n... [truncated]`;
}

function tail(text: string, maxLines = 60, maxChars = 1200): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  return clip(lines.slice(-maxLines).join("\n"), maxChars);
}

function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (item && !seen.has(item)) { seen.add(item); out.push(item); }
  }
  return out;
}

const PY_FILE_LINE = /File ["']([^"']+)["'], line (\d+)/g;
const JS_STACK_FILE = /\(?((?:[A-Za-z]:)?[\w./\\-]+\.(?:[jt]sx?|mjs|cjs)):(\d+)(?::\d+)?\)?/g;
const TSC_LINE = /^([\w./\\-]+\.tsx?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/m;
const GENERIC_ERR = /\b(\w+(?:Error|Exception|Warning))\b/;

function stackFiles(output: string, re: RegExp): string[] {
  const files: string[] = [];
  for (const m of output.matchAll(re)) files.push(m[1].replace(/\\/g, "/"));
  return uniq(files);
}

/** Parse raw command output into a structured failure summary. Never throws. */
export function compressCommandResult(command: string, stdout: string, stderr: string, exitCode: number): FailureSummary {
  const out = stripAnsi(`${stdout ?? ""}\n${stderr ?? ""}`);
  const summary: FailureSummary = {
    command, passed: exitCode === 0, exitCode, errorType: "", summary: "",
    isSyntaxError: false, isImportError: false, isTestFailure: false,
    failures: [], nextAction: "", tail: tail(out)
  };
  if (summary.passed) {
    summary.summary = "command exited 0";
    summary.nextAction = "No action needed; command passed.";
    return summary;
  }

  // 1) TypeScript compiler errors
  const tsc = out.match(TSC_LINE);
  if (tsc) {
    summary.isSyntaxError = /TS1\d{3}/.test(tsc[3]);
    summary.errorType = tsc[3];
    summary.summary = `${tsc[3]} at ${tsc[1]}:${tsc[2]}: ${tsc[4]}`.slice(0, 240);
    const files = uniq([...out.matchAll(/^([\w./\\-]+\.tsx?)\(\d+,\d+\):\s*error/gm)].map((m) => m[1].replace(/\\/g, "/")));
    summary.failures.push({ test: "(tsc)", errorType: tsc[3], message: tsc[4].slice(0, 240), expected: "", got: "", topStackFiles: files.slice(0, 5) });
    summary.nextAction = `Fix the type error at ${tsc[1]}:${tsc[2]} (${tsc[3]}).`;
    return summary;
  }

  // 2) Python syntax error
  const syntax = out.match(/File ["']([^"']+)["'], line (\d+)[\s\S]{0,200}?(SyntaxError|IndentationError|TabError)/);
  if (syntax) {
    summary.isSyntaxError = true;
    summary.errorType = syntax[3];
    summary.summary = `Python ${syntax[3]} at ${syntax[1]}:L${syntax[2]}`;
    summary.failures.push({ test: "(syntax)", errorType: syntax[3], message: summary.summary, expected: "", got: "", topStackFiles: [syntax[1].replace(/\\/g, "/")] });
    summary.nextAction = `Fix the ${syntax[3]} at ${syntax[1]}:${syntax[2]}.`;
    return summary;
  }

  // 3) Import / module resolution errors
  const modNotFound = out.match(/(?:ModuleNotFoundError: No module named ['"]([^'"]+)['"]|Cannot find module ['"]([^'"]+)['"])/);
  if (modNotFound || /ImportError|ERR_MODULE_NOT_FOUND/.test(out)) {
    summary.isImportError = true;
    const mod = modNotFound?.[1] ?? modNotFound?.[2] ?? "";
    summary.errorType = modNotFound ? "ModuleNotFound" : "ImportError";
    summary.summary = mod ? `Missing module: ${mod}` : "import failed";
    const files = uniq([...stackFiles(out, PY_FILE_LINE), ...stackFiles(out, JS_STACK_FILE)]);
    summary.failures.push({ test: "(import)", errorType: summary.errorType, message: summary.summary, expected: "", got: "", topStackFiles: files.slice(0, 5) });
    summary.nextAction = mod ? `Resolve the missing import "${mod}" (fix the path or install/pin the dependency).` : "Fix the failing import.";
    return summary;
  }

  // 4) pytest failures - match both the short-summary form ("FAILED path::test - msg")
  // and the per-test form ("path::test FAILED").
  const pytestFailed = uniq([
    ...[...out.matchAll(/^FAILED\s+([\w./:\\-]+?)(?:\s*-\s*|\s*$)/gm)].map((m) => m[1]),
    ...[...out.matchAll(/^([\w./\\-]+\.py(?:::[\w\[\]-]+)*)\s+FAILED\b/gm)].map((m) => m[1])
  ]);
  if (pytestFailed.length || (/\bFAILED\b/.test(out) && /\d+ failed/.test(out))) {
    summary.isTestFailure = true;
    const shortSummary = out.match(/=+\s*((?:\d+\s+)?(?:passed|failed|error|skipped)[^\n=]*?)\s*=+/);
    summary.summary = shortSummary ? shortSummary[1].trim() : `${pytestFailed.length} test(s) failed`;
    for (const testName of pytestFailed.slice(0, 6)) {
      const entry: FailureEntry = { test: testName, errorType: "", message: "", expected: "", got: "", topStackFiles: [] };
      const body = pytestFailureBody(out, testName);
      entry.topStackFiles = stackFiles(body, PY_FILE_LINE).slice(0, 5);
      if (!entry.topStackFiles.length && testName.includes("::")) entry.topStackFiles = [testName.split("::")[0]];
      entry.errorType = body.match(GENERIC_ERR)?.[1] ?? "";
      entry.message = (body.match(/AssertionError:?\s*(.*)/i)?.[1]
        ?? body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("E "))?.replace(/^E\s+/, "")
        ?? "").slice(0, 240);
      [entry.expected, entry.got] = extractExpectedGot(body);
      summary.failures.push(entry);
    }
    // Never leave a test failure with an empty failures list (the fallback path when the
    // "N failed" line fired but no test id was parseable).
    if (!summary.failures.length) {
      const [expected, got] = extractExpectedGot(out);
      summary.failures.push({ test: "(test)", errorType: out.match(GENERIC_ERR)?.[1] ?? "", message: (out.match(/AssertionError:?\s*(.*)/i)?.[1] ?? "").slice(0, 240), expected, got, topStackFiles: stackFiles(out, PY_FILE_LINE).slice(0, 5) });
    }
    const first = summary.failures[0];
    summary.nextAction = first?.topStackFiles[0]
      ? `Localize the failure in ${first.topStackFiles[0]} and fix the smallest cause of "${first.message || first.test}".`
      : "Localize and fix the failing test's root cause without editing the test.";
    return summary;
  }

  // 5) jest / vitest failures
  if (/(●|✕|FAIL )\s/.test(out) || /Expected:/.test(out)) {
    summary.isTestFailure = true;
    const names = uniq([...out.matchAll(/^\s*(?:●|✕)\s+(.+?)\s*$/gm)].map((m) => m[1].trim())).slice(0, 6);
    const expected = out.match(/Expected:?\s*(.+)/)?.[1]?.trim().slice(0, 200) ?? "";
    const got = out.match(/Received:?\s*(.+)/)?.[1]?.trim().slice(0, 200) ?? "";
    const files = stackFiles(out, JS_STACK_FILE).filter((f) => !f.includes("node_modules"));
    summary.summary = names.length ? `${names.length} test(s) failed` : "jest/vitest failure";
    for (const name of (names.length ? names : ["(test)"])) {
      summary.failures.push({ test: name, errorType: "AssertionError", message: (expected || got) ? `expected ${expected} / received ${got}` : "", expected, got, topStackFiles: files.slice(0, 5) });
    }
    summary.nextAction = files[0]
      ? `Fix ${files[0]} so it produces ${expected || "the expected value"} instead of ${got || "the received value"}.`
      : "Fix the code under test to match the expected value.";
    return summary;
  }

  // 6) Generic runtime error
  const err = out.match(GENERIC_ERR);
  if (err) {
    summary.errorType = err[1];
    const msg = out.match(new RegExp(`${err[1]}:\\s*(.+)`))?.[1]?.trim().slice(0, 200);
    summary.summary = msg ? `${err[1]}: ${msg}` : `${err[1]} raised`;
    summary.failures.push({ test: "(runtime)", errorType: err[1], message: summary.summary, expected: "", got: "", topStackFiles: uniq([...stackFiles(out, PY_FILE_LINE), ...stackFiles(out, JS_STACK_FILE)]).slice(0, 5) });
    summary.nextAction = `Reproduce and fix the ${err[1]} at the top stack frame.`;
    return summary;
  }

  summary.summary = `command exited ${exitCode}`;
  summary.nextAction = "Inspect the tail output below and fix the reported failure.";
  return summary;
}

function pytestFailureBody(out: string, testName: string): string {
  const short = testName.includes("::") ? testName.split("::").pop()! : testName;
  const esc = short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = out.match(new RegExp(`^_{3,}\\s+${esc}\\s+_*\\s*$`, "m")) ?? out.match(new RegExp(`^FAILED\\s+${esc}.*$`, "m"));
  if (!start || start.index === undefined) return out;
  const from = start.index + start[0].length;
  const rest = out.slice(from);
  const nextSep = rest.match(/^(?:_{3,}|=+\s+\d)/m);
  return nextSep && nextSep.index !== undefined ? rest.slice(0, nextSep.index) : rest;
}

function extractExpectedGot(block: string): [string, string] {
  const assertEq = block.match(/assert\s+(.+?)\s*==\s*(.+?)$/m);
  if (assertEq) return [assertEq[2].trim().slice(0, 200), assertEq[1].trim().slice(0, 200)];
  const expected = block.match(/Expected:?\s*(.+)/)?.[1]?.trim().slice(0, 200) ?? "";
  const got = block.match(/(?:Received|Actual|got):?\s*(.+)/i)?.[1]?.trim().slice(0, 200) ?? "";
  return [expected, got];
}

/** Render a compact card for the model, always ending with one imperative next-action line. */
export function renderFailureCard(summary: FailureSummary, maxChars = 900): string {
  const out: string[] = ["=== FAILURE SUMMARY ==="];
  out.push(`command: ${summary.command}`);
  out.push(`exit: ${summary.exitCode} | ${summary.summary}`);
  const flags = [summary.isSyntaxError && "SYNTAX", summary.isImportError && "IMPORT", summary.isTestFailure && "TEST"].filter(Boolean);
  if (flags.length) out.push(`flags: ${flags.join(" ")}`);
  for (const [i, f] of summary.failures.slice(0, 4).entries()) {
    out.push(`[${i + 1}] ${f.test}${f.errorType ? ` (${f.errorType})` : ""}`);
    if (f.message) out.push(`    ${f.message}`);
    if (f.expected || f.got) out.push(`    expected: ${f.expected} | got: ${f.got}`);
    if (f.topStackFiles.length) out.push(`    files: ${f.topStackFiles.slice(0, 3).join(", ")}`);
  }
  out.push(`NEXT: ${summary.nextAction}`);
  return clip(out.join("\n"), maxChars);
}

/** Convenience: raw output -> compact model-facing card in one call. */
export function compressFailureOutput(command: string, stdout: string, stderr: string, exitCode: number, maxChars = 900): string {
  return renderFailureCard(compressCommandResult(command, stdout, stderr, exitCode), maxChars);
}
