import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/gym/runner.js";
import { scoreRun } from "../src/gym/scorer.js";
import { buildReport, writeReport, writeMarkdownReport, readLatestReport, buildLearningSuggestions, writeLearningSuggestions } from "../src/gym/report.js";
import { runGymCli } from "../src/gym/cli.js";
import { ZOO_TASKS } from "../src/gym/zoo.js";
import type { RunHookOutcome } from "../src/gym/runner.js";

const PASS: RunHookOutcome = {
  focusedTestsPassed: true, fullTestsPassed: true, reproduced: true, noOpDetected: false,
  memoryUsed: true, evidenceUsed: true, missionStepsCompleted: 5
};

test("end-to-end: run a task, score it, write a report, read it back", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-e2e-"));
  const task = ZOO_TASKS.find((t) => t.id === "py_off_by_one_001")!;
  const run = await runTask({
    rootDir: cwd, task, mode: "cheater",
    outcomeOverride: { ...PASS, commandsRun: ["pytest -q", "git diff"] },
    hooks: { runAgent: async () => PASS, snapshotBaseline: async () => {} }
  });
  const score = scoreRun({ task, result: run.result });
  assert.ok(score.score >= 60, `expected pass, got ${score.score}`);
  const report = buildReport({
    id: `e2e-${Date.now()}`, startedAt: run.result.startedAt, finishedAt: run.result.finishedAt,
    suite: "e2e", vanillaAvailable: false,
    results: [{ ...run.result, task, score }]
  });
  const file = writeReport(cwd, report);
  writeMarkdownReport(cwd, report);
  assert.ok(existsSync(file));
  const text = readFileSync(file.replace(/\.json$/, ".md"), "utf8");
  assert.match(text, /# Cheater Gym report/);
  const latest = readLatestReport(cwd);
  assert.ok(latest);
  rmSync(cwd, { recursive: true, force: true });
});

test("end-to-end: build learning suggestions and write them", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-e2e-learn-"));
  const task = ZOO_TASKS[0];
  const run = await runTask({
    rootDir: cwd, task, mode: "cheater",
    outcomeOverride: { ...PASS, focusedTestsPassed: false, fullTestsPassed: false, noOpDetected: false },
    hooks: { runAgent: async () => PASS, snapshotBaseline: async () => {} }
  });
  const score = scoreRun({ task, result: run.result });
  // A failing run yields an anti-pattern learning suggestion (the write path we exercise here).
  const suggestions = buildLearningSuggestions([{ ...run.result, task, score }]);
  assert.ok(suggestions.length > 0);
  const file = writeLearningSuggestions(cwd, suggestions);
  assert.ok(existsSync(file));
  rmSync(cwd, { recursive: true, force: true });
});

test("cheater gym run <id> from CLI works for any task", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gym-cli-e2e-"));
  const lines: string[] = [];
  const code = runGymCli(["run", "py_off_by_one_001"], { cwd, stdout: (t: string) => lines.push(t) });
  assert.equal(code, 0);
  assert.ok(lines.some((l: string) => l.includes("workspace:")));
  rmSync(cwd, { recursive: true, force: true });
});
