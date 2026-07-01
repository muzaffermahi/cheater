import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OracleReport, ProjectFacts } from "./types.js";

export interface OracleOptions {
  cwd: string;
  orientation: ProjectFacts | null;
  focusedCommand?: string;
  broadCommand?: string;
  runBroadTests?: "never" | "ask" | "always";
  runAllChecks?: boolean;
  userConfirmedBroad?: boolean;
  timeoutMs?: number;
}

interface StepResult {
  ok: boolean | null;
  skipped?: boolean;
  skippedReason?: string;
  failure?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runStep(command: string, cwd: string, timeoutMs: number): StepResult {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true
  });
  return {
    ok: (result.status ?? 1) === 0,
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
    exitCode: typeof result.status === "number" ? result.status : 1
  };
}

function commandExists(command: string, cwd: string, timeoutMs: number): boolean {
  const executable = command.trim().split(/\s+/)[0];
  if (!executable) return false;
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [executable] : ["-v", executable], {
    cwd,
    shell: process.platform !== "win32",
    encoding: "utf8",
    timeout: Math.min(timeoutMs, 10000),
    windowsHide: true
  });
  return (result.status ?? 1) === 0;
}

function walkFiles(cwd: string, extensions: string[], limit = 200): string[] {
  const out: string[] = [];
  const skip = new Set([".git", "node_modules", "dist", "build", "coverage", ".venv", "venv", "__pycache__"]);
  const visit = (dir: string) => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit || skip.has(entry)) continue;
      const path = join(dir, entry);
      try {
        const stat = existsSync(path) ? statSync(path) : undefined;
        if (!stat) continue;
        if (stat.isDirectory()) visit(path);
        else if (extensions.some((ext) => entry.endsWith(ext))) out.push(path);
      } catch {
        // ignore unreadable entries
      }
    }
  };
  visit(cwd);
  return out;
}

function validateHtmlFiles(cwd: string): StepResult {
  const files = walkFiles(cwd, [".html", ".htm"]);
  if (files.length === 0) {
    return { ok: null, skipped: true, skippedReason: "no html files", stdout: "", stderr: "", exitCode: 0 };
  }
  const failures: string[] = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const file of files) {
    const rel = file.slice(cwd.length + 1);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      failures.push(`${rel}: unreadable`);
      continue;
    }
    const stack: string[] = [];
    const tags = text.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9:-]*)(?:\s[^<>]*)?>/g);
    for (const match of tags) {
      const raw = match[0];
      const name = match[1].toLowerCase();
      if (raw.startsWith("<!") || raw.startsWith("<?") || voidTags.has(name) || raw.endsWith("/>")) continue;
      if (raw.startsWith("</")) {
        const last = stack.pop();
        if (last !== name) {
          failures.push(`${rel}: closing </${name}> did not match <${last ?? "none"}>`);
          break;
        }
      } else {
        stack.push(name);
      }
    }
    if (stack.length > 0) failures.push(`${rel}: unclosed <${stack[stack.length - 1]}>`);
  }
  return { ok: failures.length === 0, stdout: `html files checked: ${files.length}`, stderr: failures.join("\n"), exitCode: failures.length === 0 ? 0 : 1 };
}

function pickLintCommand(orientation: ProjectFacts | null): string | undefined {
  if (!orientation) return undefined;
  if (orientation.lintCommands.length > 0) return orientation.lintCommands[0];
  if (orientation.languages.includes("javascript") || orientation.languages.includes("typescript")) {
    return "npx eslint --quiet .";
  }
  if (orientation.languages.includes("python")) {
    return "python -m ruff check .";
  }
  return undefined;
}

function pickTypecheckCommand(orientation: ProjectFacts | null): string | undefined {
  if (!orientation) return undefined;
  if (orientation.typecheckCommands.length > 0) return orientation.typecheckCommands[0];
  if (orientation.languages.includes("typescript")) {
    return "npx tsc --noEmit";
  }
  return undefined;
}

function pickBroadCommand(orientation: ProjectFacts | null): string | undefined {
  if (!orientation) return undefined;
  if (orientation.testCommands.length > 0) {
    return orientation.testCommands[0];
  }
  return undefined;
}

function summarize(failures: string[], checked: number): string {
  if (failures.length === 0) return `all ${checked} checked oracle(s) passed (or were skipped)`;
  return `failures: ${failures.join("; ")}`;
}

function addCheck(report: OracleReport, name: string, result: StepResult, command?: string): void {
  report.checks.push({
    name,
    command,
    ok: result.ok,
    skipped: result.skipped,
    failure: result.ok === false ? (result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 300) : result.skippedReason
  });
}

function uniqueCommands(commands: Array<string | undefined>): string[] {
  return [...new Set(commands.map((cmd) => (cmd ?? "").trim()).filter(Boolean))];
}

export function runOracleStack(options: OracleOptions): OracleReport {
  const timeoutMs = options.timeoutMs ?? 120000;
  const failures: string[] = [];
  const syntaxOk: boolean | null = null;
  const report: OracleReport = {
    syntaxOk,
    lintOk: null,
    typecheckOk: null,
    focusedTestsOk: null,
    broadTestsOk: null,
    checks: [],
    failures,
    summary: ""
  };

  const runAllChecks = options.runAllChecks ?? true;
  const syntaxChecks: StepResult[] = [];
  if (options.orientation?.languages.includes("python")) {
    syntaxChecks.push(runStep("python -m compileall -q .", options.cwd, timeoutMs));
    addCheck(report, "python-compileall", syntaxChecks[syntaxChecks.length - 1], "python -m compileall -q .");
  }
  if (options.orientation?.languages.some((lang) => lang === "javascript" || lang === "typescript")) {
    const jsFiles = walkFiles(options.cwd, [".js", ".mjs", ".cjs"], 80);
    if (jsFiles.length > 0 && commandExists("node", options.cwd, timeoutMs)) {
      const failuresForJs: string[] = [];
      for (const file of jsFiles) {
        const step = runStep(`node --check "${file}"`, options.cwd, timeoutMs);
        if (!step.ok) failuresForJs.push(`${file}:${step.exitCode}`);
      }
      const jsStep = { ok: failuresForJs.length === 0, stdout: `node --check files: ${jsFiles.length}`, stderr: failuresForJs.join("\n"), exitCode: failuresForJs.length === 0 ? 0 : 1 };
      syntaxChecks.push(jsStep);
      addCheck(report, "javascript-syntax", jsStep, "node --check <js files>");
    }
  }
  const htmlStep = validateHtmlFiles(options.cwd);
  if (htmlStep.ok !== null || options.orientation?.languages.includes("html") || options.orientation?.entrypoints.some((item) => item.endsWith(".html"))) {
    syntaxChecks.push(htmlStep);
    addCheck(report, "html-static-validation", htmlStep);
  }
  const realSyntax = syntaxChecks.filter((step) => step.ok !== null);
  if (realSyntax.length > 0) {
    report.syntaxOk = realSyntax.every((step) => step.ok === true);
    if (!report.syntaxOk) failures.push("syntax:1");
  }

  const focused = options.focusedCommand;
  if (focused) {
    const step = runStep(focused, options.cwd, timeoutMs);
    report.focusedTestsOk = step.ok;
    addCheck(report, "focused", step, focused);
    if (!step.ok) failures.push(`focused:${step.exitCode}`);
  } else {
    report.focusedTestsOk = null;
  }

  const typecheckCommands = runAllChecks ? options.orientation?.typecheckCommands ?? [] : [pickTypecheckCommand(options.orientation)];
  const typecheckResults: StepResult[] = [];
  for (const typecheck of uniqueCommands(typecheckCommands)) {
    const step = runStep(typecheck, options.cwd, timeoutMs);
    typecheckResults.push(step);
    addCheck(report, "typecheck", step, typecheck);
    if (!step.ok) failures.push(`typecheck:${step.exitCode}`);
  }
  if (typecheckResults.length > 0) {
    report.typecheckOk = typecheckResults.every((step) => step.ok === true);
  }

  const lintCommands = runAllChecks ? options.orientation?.lintCommands ?? [] : [pickLintCommand(options.orientation)];
  const lintResults: StepResult[] = [];
  for (const lint of uniqueCommands(lintCommands)) {
    const step = runStep(lint, options.cwd, timeoutMs);
    lintResults.push(step);
    addCheck(report, "lint", step, lint);
    if (!step.ok) failures.push(`lint:${step.exitCode}`);
  }
  if (lintResults.length > 0) {
    report.lintOk = lintResults.every((step) => step.ok === true);
  }

  const broad = options.broadCommand ?? pickBroadCommand(options.orientation);
  const runBroad = options.runBroadTests ?? "ask";
  const broadCommands = runAllChecks ? uniqueCommands([...(options.orientation?.testCommands ?? []), options.broadCommand]) : uniqueCommands([broad]);
  if (broadCommands.length === 0) {
    report.broadTestsOk = null;
  } else if (runBroad === "never") {
    report.broadTestsOk = null;
  } else if (runBroad === "ask" && !options.userConfirmedBroad) {
    report.broadTestsOk = null;
  } else {
    const broadResults: StepResult[] = [];
    for (const command of broadCommands) {
      if (command === focused) continue;
      const step = runStep(command, options.cwd, timeoutMs);
      broadResults.push(step);
      addCheck(report, "broad", step, command);
      if (!step.ok) failures.push(`broad:${step.exitCode}`);
    }
    report.broadTestsOk = broadResults.length > 0 ? broadResults.every((step) => step.ok === true) : null;
  }

  report.summary = summarize(failures, report.checks.length);
  return report;
}
