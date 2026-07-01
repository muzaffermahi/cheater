import { spawnSync } from "node:child_process";
import type { ReproResult } from "./types.js";

export interface RunReproOptions {
  cwd: string;
  command?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  allowNoCommand?: boolean;
}

export interface RunReproOutput {
  result: ReproResult;
  ran: boolean;
  rawOutput: string;
}

const ENV_FAILURE_PATTERNS: RegExp[] = [
  /\bcommand not found\b/i,
  /\bnot recognized as an internal or external command\b/i,
  /\bno such file or directory\b.*\b(node|npm|pnpm|yarn|pytest|python|python3|tsc)\b/i,
  /\benv: .*no such file or directory\b/i,
  /\bpermission denied\b/i,
  /\bmissing script:?\b/i
];

const PYTEST_PASS = /==+ \d+ passed ==+/i;
const PYTEST_FAIL = /==+ .*(failed|errors?|short test summary info).*==+/i;
const JEST_PASS = /\bTests:\s*\d+ passed/i;
const JEST_FAIL = /\bTests:.*(failed|FAIL)/i;
const TSC_ERROR = /\berror TS\d+:/;

export function runRepro(options: RunReproOptions): RunReproOutput {
  const command = (options.command ?? "").trim();
  if (!command) {
    return {
      ran: false,
      rawOutput: "",
      result: {
        reproduced: false,
        alreadyPassing: false,
        environmentFailure: false,
        command: "",
        exitCode: -1,
        failureKind: "no_command",
        failingTests: [],
        errorType: "no_command",
        topStackFiles: [],
        summary: options.allowNoCommand
          ? "No command provided; awaiting user-supplied repro."
          : "No command provided; ask the user for the smallest command that proves the issue."
      }
    };
  }

  const result = spawnSync(command, {
    cwd: options.cwd,
    shell: true,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120000,
    env: options.env ?? process.env,
    windowsHide: true
  });

  const stdout = (result.stdout ?? "").toString();
  const stderr = (result.stderr ?? "").toString();
  const combined = `${stdout}\n${stderr}`.trim();
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const signal = result.signal ?? "";
  const timedOut = signal === "SIGTERM" && Boolean(result.error) === false && result.status === null;

  const envFailure = ENV_FAILURE_PATTERNS.some((pattern) => pattern.test(combined));
  const parsed = parseReproOutput(combined);
  const passedByExit = exitCode === 0 && !envFailure && !timedOut;
  const alreadyPassing = (parsed.alreadyPassing || passedByExit) && !timedOut;
  const environmentFailure = envFailure || timedOut;
  if (alreadyPassing) parsed.failureKind = "none";

  const summaryParts: string[] = [];
  if (timedOut) summaryParts.push(`timeout after ${options.timeoutMs ?? 120000}ms`);
  if (envFailure) summaryParts.push("environment failure");
  if (parsed.failingTests.length > 0) summaryParts.push(`failing tests: ${parsed.failingTests.length}`);
  if (parsed.errorType) summaryParts.push(`error: ${parsed.errorType}`);
  if (!summaryParts.length) summaryParts.push(exitCode === 0 ? "passed" : `exit ${exitCode}`);

  return {
    ran: true,
    rawOutput: combined,
    result: {
      reproduced: !alreadyPassing && exitCode !== 0 && !environmentFailure,
      alreadyPassing,
      environmentFailure,
      command,
      exitCode,
      failureKind: parsed.failureKind,
      failingTests: parsed.failingTests,
      errorType: parsed.errorType,
      topStackFiles: parsed.topStackFiles,
      summary: summaryParts.join("; ")
    }
  };
}

interface ParsedRepro {
  failureKind: string;
  failingTests: string[];
  errorType: string;
  topStackFiles: string[];
  alreadyPassing: boolean;
}

export function parseReproOutput(text: string): ParsedRepro {
  const result: ParsedRepro = {
    failureKind: "unknown",
    failingTests: [],
    errorType: "",
    topStackFiles: [],
    alreadyPassing: false
  };

  if (!text) return result;

  if (PYTEST_PASS.test(text) && !PYTEST_FAIL.test(text)) {
    result.alreadyPassing = true;
    result.failureKind = "none";
    return result;
  }
  if (JEST_PASS.test(text) && !JEST_FAIL.test(text)) {
    result.alreadyPassing = true;
    result.failureKind = "none";
    return result;
  }

  const importMatch = text.match(/\b(modulenotfounderror|importerror|cannot find module|can't find module|no module named|cannot import|unresolved import|unable to import)\b/i);
  if (importMatch) {
    result.failureKind = "import_error";
    result.errorType = importMatch[1];
    const moduleMatch = text.match(/(?:ModuleNotFoundError|ImportError|Module [^:]+):\s*['"]?([^'"\n]+)['"]?/i);
    if (moduleMatch) result.topStackFiles.push(moduleMatch[1]);
    return result;
  }

  const syntaxMatch = text.match(/\b(syntaxerror|parseerror|invalid syntax|unexpected token)\b/i);
  if (syntaxMatch) {
    result.failureKind = "syntax_error";
    result.errorType = syntaxMatch[1];
    return result;
  }

  if (TSC_ERROR.test(text)) {
    result.failureKind = "type_error";
    const tsMatch = text.match(/\berror TS\d+:[^\n]*/i);
    result.errorType = tsMatch ? tsMatch[0].slice(0, 160) : "typescript error";
    const fileMatch = text.match(/([\w./-]+\.[cm]?[jt]sx?)\(\d+,\d+\):\s*error/);
    if (fileMatch) result.topStackFiles.push(fileMatch[1]);
    return result;
  }

  const typeMatch = text.match(/\btypeerror\b[^\n]*/i);
  if (typeMatch) {
    result.failureKind = "type_error";
    result.errorType = typeMatch[0].slice(0, 160);
  }

  const pytestFails = [...text.matchAll(/^FAILED\s+([^\s]+)\s+-/gm)].map((m) => m[1]);
  const jestFails = [...text.matchAll(/✕\s+(.+?)(?:\n|$)/g)].map((m) => m[1]);
  const mochaFails = [...text.matchAll(/^\s*\d+\) ([^:]+):/gm)].map((m) => m[1]);
  const failing = [...new Set([...pytestFails, ...jestFails, ...mochaFails])].slice(0, 10);
  if (failing.length > 0) {
    result.failureKind = result.failureKind === "unknown" ? "test_assertion_error" : result.failureKind;
    result.failingTests = failing;
  }

  const fileMatches = [...text.matchAll(/(?:File|at) ["']([^"']+\.[a-z]{1,3})["']/g)].map((m) => m[1]);
  const topStack = [...new Set(fileMatches)].slice(0, 5);
  if (topStack.length) result.topStackFiles = topStack;

  return result;
}
