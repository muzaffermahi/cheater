#!/usr/bin/env node
/**
 * Reproducible Kitten-vs-OpenCode runner.
 *
 * The harness deliberately treats a zero OpenCode score as invalid when its smoke task did not
 * complete. This prevents an endpoint/configuration failure from being reported as model quality.
 * Commands are supplied explicitly so both agents can be pointed at the same model and workspace.
 */
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const value = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(name);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const { FIXTURES, materializeFixture } = await import(pathToFileURL(join(scriptDir, "fixtureCatalog.mjs")).href);
const defaultManifestCandidates = [
  resolve(process.cwd(), "data/benchmarks/kitten-opencode-30.v1.jsonl"),
  resolve(process.cwd(), "../data/benchmarks/kitten-opencode-30.v1.jsonl"),
];
const tasksPath = resolve(value("--tasks", defaultManifestCandidates.find((candidate) => existsSync(candidate)) ?? defaultManifestCandidates[0]));
const outputPath = value("--out", "");
const timeoutMs = Number(value("--timeout-ms", "180000"));
const expectedTaskCount = Number(value("--expected-tasks", "30"));
const root = resolve(value("--root", process.cwd()));
const workRoot = resolve(value("--work-root", join(process.env.TEMP ?? process.cwd(), "kitten-opencode-bench")));
const defaultCommands = {
  kitten: { executable: process.execPath, args: [join(scriptDir, "bench-kitten.mjs")], display: `${process.execPath} ${join(scriptDir, "bench-kitten.mjs")}` },
  opencode: { executable: process.execPath, args: [join(scriptDir, "bench-opencode.mjs")], display: `${process.execPath} ${join(scriptDir, "bench-opencode.mjs")}` },
};
const commands = {
  kitten: value("--kitten-command", defaultCommands.kitten),
  opencode: value("--opencode-command", defaultCommands.opencode),
};

function fail(message) { console.error(`compare-agents: ${message}`); process.exitCode = 2; }
function loadTasks(text) {
  const rows = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`invalid JSON on task line ${index + 1}`); }
  });
  if (!Number.isInteger(expectedTaskCount) || expectedTaskCount < 1) throw new Error("--expected-tasks must be a positive integer");
  if (rows.length !== expectedTaskCount) throw new Error(`expected exactly ${expectedTaskCount} tasks, found ${rows.length}`);
  const ids = new Set();
  for (const task of rows) {
    if (!task.id || !task.prompt) throw new Error("each task needs id and prompt");
    const fixtureId = task.fixture ?? task.id;
    if (!FIXTURES[fixtureId]) throw new Error(`missing fixture for task ${task.id}: ${fixtureId}`);
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  if (!rows.some((task) => task.smoke)) throw new Error("manifest must mark at least one smoke task");
  return rows;
}

function run(command, task, cwd, extraEnv = {}) {
  return new Promise((resolveRun) => {
    if (!command) return resolveRun({ status: "not-configured", code: null, ms: 0, output: "" });
    const started = Date.now();
    const env = { ...process.env, ...extraEnv, KITTEN_BENCH_TASK_ID: task.id, KITTEN_BENCH_PROMPT: task.prompt, KITTEN_BENCH_CWD: cwd };
    const child = typeof command === "object"
      ? spawn(command.executable, command.args, { cwd, windowsHide: true, env })
      : spawn(command, [], { cwd, shell: true, windowsHide: true, env });
    let output = "";
    const append = (chunk) => { output += String(chunk); if (output.length > 32_000) output = output.slice(-32_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolveRun({ status: "error", code: null, ms: Date.now() - started, output: `${output}\n${error.message}` }); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolveRun({ status: timedOut ? "timeout" : (code === 0 ? "passed" : "failed"), code, signal, ms: Date.now() - started, output }); });
  });
}

async function runOracle(cwd, task) {
  // The agent may inspect a check, but it must not be able to make the oracle pass by editing it.
  // Restore the committed oracle immediately before execution so the score is independent of any
  // test-file mutation made during the coding run.
  const fixtureFiles = FIXTURES[task.fixture ?? task.id]?.files ?? {};
  const oracleName = ["verify.mjs", "verify.py", "verify.ts"].find((name) => typeof fixtureFiles[name] === "string");
  if (!oracleName) throw new Error(`fixture ${task.id} has no immutable oracle`);
  await writeFile(join(cwd, oracleName), fixtureFiles[oracleName], "utf8");
  const oracleCommand = oracleName.endsWith(".py")
    ? [process.env.PYTHON || "python", [oracleName]]
    : oracleName.endsWith(".ts")
      ? [process.execPath, ["--experimental-strip-types", oracleName]]
      : [process.execPath, [oracleName]];
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(oracleCommand[0], oracleCommand[1], { cwd, windowsHide: true });
    let output = "";
    const append = (chunk) => { output += String(chunk); if (output.length > 16_000) output = output.slice(-16_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.on("error", (error) => resolveRun({ status: "error", code: null, ms: Date.now() - started, output: `${output}\n${error.message}` }));
    child.on("exit", (code) => resolveRun({ status: code === 0 ? "passed" : "failed", code, ms: Date.now() - started, output }));
  });
}

async function workspaceFor(agent, task) {
  await mkdir(workRoot, { recursive: true });
  return mkdtemp(join(workRoot, `${agent}-${task.id}-`));
}

async function runTask(agent, command, task) {
  const cwd = await workspaceFor(agent, task);
  await materializeFixture(task.fixture ?? task.id, cwd);
  const execution = await run(command, task, cwd, {
    KITTEN_BENCH_FIXTURE: task.fixture ?? task.id,
    OPENCODE_BENCH_MODEL: process.env.OPENCODE_BENCH_MODEL ?? "maas/qwen3.6-35b-a3b",
  });
  const oracle = execution.status === "passed" ? await runOracle(cwd, task) : { status: "not-run", code: null, ms: 0, output: execution.output };
  const status = execution.status !== "passed" ? execution.status : oracle.status === "passed" ? "passed" : "oracle_failed";
  if (!has("--keep")) await rm(cwd, { recursive: true, force: true });
  return { status, execution, oracle, cwd: has("--keep") ? cwd : undefined };
}

async function main() {
  if (!existsSync(tasksPath)) throw new Error(`task manifest not found: ${tasksPath}`);
  const tasks = loadTasks(await readFile(tasksPath, "utf8"));
  if (has("--validate")) { console.log(JSON.stringify({ ok: true, tasks: tasks.length, fixtures: Object.keys(FIXTURES).length, smokeTasks: tasks.filter((t) => t.smoke).map((t) => t.id) }, null, 2)); return; }
  const requestedOnly = value("--only", "").split(",").map((id) => id.trim()).filter(Boolean);
  const runTasks = requestedOnly.length ? tasks.filter((task) => requestedOnly.includes(task.id)) : has("--smoke-only") ? [tasks.find((task) => task.smoke)] : tasks;
  if (!runTasks.length) throw new Error("--only did not match any task ids");
  const kittenModel = process.env.KITTEN_MAIN_MODEL || "(default)";
  const opencodeModel = process.env.OPENCODE_BENCH_MODEL || "maas/qwen3.6-35b-a3b";
  const opencodeBaseModel = opencodeModel.includes("/") ? opencodeModel.slice(opencodeModel.lastIndexOf("/") + 1) : opencodeModel;
  const modelMatch = kittenModel === "(default)" || kittenModel === opencodeBaseModel;
  const results = {
    manifest: tasksPath, root, workRoot, startedAt: new Date().toISOString(),
    config: { kittenModel, opencodeModel, kittenBaseUrl: process.env.KITTEN_BASE_URL || "(default)", modelMatch },
    agents: {},
  };
  for (const [agent, command] of Object.entries(commands)) {
    const smoke = tasks.find((t) => t.smoke);
    const smokeCwd = await workspaceFor(`${agent}-smoke`, smoke);
    await materializeFixture(smoke.fixture ?? smoke.id, smokeCwd);
    const smokeResult = await run(command, smoke, smokeCwd, { OPENCODE_BENCH_MODEL: process.env.OPENCODE_BENCH_MODEL ?? "maas/qwen3.6-35b-a3b" });
    const smokeOracle = smokeResult.status === "passed" ? await runOracle(smokeCwd, smoke) : { status: "not-run", code: null, ms: 0, output: smokeResult.output };
    if (!has("--keep")) await rm(smokeCwd, { recursive: true, force: true });
    const configured = smokeResult.status !== "not-configured" && modelMatch;
    const smokeOk = smokeResult.status === "passed";
    const rows = [];
    for (const task of runTasks) {
      const result = (!configured || !smokeOk)
        ? { status: "invalid_config", execution: smokeResult, oracle: smokeOracle, output: `smoke task ${smoke.id} did not pass (${smokeResult.status})` }
        : task.id === smoke.id
          ? { status: smokeOracle.status === "passed" ? "passed" : "oracle_failed", execution: smokeResult, oracle: smokeOracle, cwd: has("--keep") ? smokeCwd : undefined }
          : await runTask(agent, command, task);
      rows.push({ id: task.id, ...result });
    }
    const passed = rows.filter((row) => row.status === "passed").length;
    results.agents[agent] = { command, smoke: { execution: smokeResult, oracle: smokeOracle }, score: passed, total: runTasks.length, valid: configured && smokeOk, results: rows };
  }
  results.finishedAt = new Date().toISOString();
  if (outputPath) await writeFile(resolve(outputPath), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({
    manifest: tasksPath,
    ...Object.fromEntries(Object.entries(results.agents).map(([name, data]) => [name, { score: data.score, total: data.total, valid: data.valid, smoke: data.smoke.status }]))
  }, null, 2));
  if (results.agents.opencode?.score === 0 && !results.agents.opencode.valid) {
    console.error("OpenCode 0/30 is classified invalid_config because its smoke task failed; fix endpoint/model/config before comparing quality.");
    process.exitCode = 3;
  }
}

main().catch((error) => fail(error.message));
