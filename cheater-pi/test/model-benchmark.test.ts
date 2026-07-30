import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KittenLLM, ChatParams, ChatResult } from "../src/core/llm.js";
import { benchmarkCodingBattery, benchmarkModelBakeoff, benchmarkProjectBattery, CODING_BENCHMARK_TASKS, HELD_OUT_PROJECT_TASKS, latestModelBakeoffSummary, listModelBakeoffs, saveModelBakeoff } from "../src/core/modelBenchmark.js";

function response(content: string): ChatResult {
  return { content, reasoning: "", toolCalls: [], finishReason: "stop", usage: { prompt: 10, completion: 20, reasoning: 0, total: 30 }, ok: true, elapsedMs: 1 };
}

const candidates: Record<string, string> = {
  slugify: `module.exports = function(value) { return String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }`,
  "merge-intervals": `module.exports = function(intervals) { const sorted = intervals.map(x => [x[0], x[1]]).sort((a,b) => a[0]-b[0]); const out = []; for (const item of sorted) { const last = out[out.length-1]; if (last && item[0] <= last[1] + 1) last[1] = Math.max(last[1], item[1]); else out.push(item); } return out; }`,
  "parse-env": `module.exports = function(text) { const out = {}; for (const line of String(text).split(/\\r?\\n/)) { if (!line.trim() || line.trimStart().startsWith("#")) continue; const i = line.indexOf("="); if (i < 0) continue; out[line.slice(0,i).trim()] = line.slice(i+1); } return out; }`,
};

const projectCandidates: Record<string, string> = {
  merge: JSON.stringify({ files: [
    { path: "src/index.js", content: `module.exports = { mergeConfig: require("./mergeConfig") };` },
    { path: "src/mergeConfig.js", content: `function plain(value) { return value && typeof value === "object" && !Array.isArray(value); }\nfunction mergeConfig(base, override) { const out = plain(base) ? {} : base; if (!plain(base)) return override; for (const key of Object.keys(base)) out[key] = plain(base[key]) ? mergeConfig(base[key], {}) : base[key]; for (const key of Object.keys(override || {})) out[key] = plain(override[key]) && plain(out[key]) ? mergeConfig(out[key], override[key]) : override[key]; return out; }\nmodule.exports = mergeConfig;` },
  ] }),
  retry: JSON.stringify({ files: [
    { path: "src/index.js", content: `module.exports = { planRetries: require("./retry") };` },
    { path: "src/retry.js", content: `module.exports = function planRetries(options) { const input = options || {}; const attempts = Number.isFinite(input.attempts) ? Math.max(0, Math.floor(input.attempts)) : 0; const base = Number.isFinite(input.baseMs) ? Math.max(0, Math.floor(input.baseMs)) : 0; const max = Number.isFinite(input.maxMs) ? Math.max(base, Math.floor(input.maxMs)) : base; const out = []; for (let i = 0; i < attempts; i += 1) out.push(Math.min(max, base * (2 ** i))); return out; };` },
  ] }),
};

function fakeLlm(): KittenLLM {
  const fake = {
    models: { baseUrl: "http://fixture", main: "main-35b", sidecar: "sidecar-2b" },
    chat: async (params: ChatParams) => {
      const prompt = params.messages.at(-1)?.content ?? "";
      const task = CODING_BENCHMARK_TASKS.find((item) => prompt.includes(item.id === "slugify" ? "slugify" : item.id === "merge-intervals" ? "mergeIntervals" : "parseEnv"));
      return response(JSON.stringify({ code: task ? candidates[task.id] : "module.exports = () => null" }));
    },
    sidecar: async (params: ChatParams) => {
      const prompt = params.messages.at(-1)?.content ?? "";
      const task = CODING_BENCHMARK_TASKS.find((item) => prompt.includes(item.id === "slugify" ? "slugify" : item.id === "merge-intervals" ? "mergeIntervals" : "parseEnv"));
      return response(JSON.stringify({ code: task ? candidates[task.id] : "module.exports = () => null" }));
    },
  } as unknown as KittenLLM;
  return fake;
}

test("coding benchmark evaluates both model tiers in an isolated VM", async () => {
  const battery = await benchmarkCodingBattery(fakeLlm(), { models: [{ role: "main", model: "main-35b" }, { role: "sidecar", model: "sidecar-2b" }] });
  assert.equal(battery.rows.length, 2);
  assert.equal(battery.rows[0].passedCases, 9);
  assert.equal(battery.rows[0].score, 1);
  assert.equal(battery.rows[1].passedTasks, 3);
  assert.match(battery.note, /isolated evaluation/);
});

test("coding benchmark reports per-task progress for a slow local model", async () => {
  const progress: Array<{ status: string; phase: string; taskId: string }> = [];
  await benchmarkCodingBattery(fakeLlm(), {
    models: [{ role: "main", model: "main-35b" }],
    taskIds: ["slugify"],
    onProgress: (event) => progress.push({ status: event.status, phase: event.phase, taskId: event.taskId }),
  });
  assert.deepEqual(progress, [
    { status: "started", phase: "coding", taskId: "slugify" },
    { status: "completed", phase: "coding", taskId: "slugify" },
  ]);
});

test("coding benchmark caps the task set and never allows unsafe generated code", async () => {
  const unsafe = {
    models: { baseUrl: "http://fixture", main: "main-35b" },
    chat: async () => response(JSON.stringify({ code: "module.exports = () => require('fs')" })),
    sidecar: async () => response(JSON.stringify({ code: "module.exports = () => require('fs')" })),
  } as unknown as KittenLLM;
  const battery = await benchmarkCodingBattery(unsafe, { models: [{ role: "main", model: "main-35b" }], taskIds: ["slugify", "merge-intervals", "parse-env", "unknown"] });
  assert.equal(battery.rows[0].requestedTasks, 3);
  assert.equal(battery.rows[0].passedCases, 0);
  assert.match(battery.rows[0].rows[0].error ?? "", /unsafe/);
});

test("coding benchmark contains an infinite generated function call", async () => {
  const looping = {
    models: { baseUrl: "http://fixture", main: "main-35b" },
    chat: async () => response(JSON.stringify({ code: "module.exports = () => { while (true) {} }" })),
    sidecar: async () => response(JSON.stringify({ code: "module.exports = () => { while (true) {} }" })),
  } as unknown as KittenLLM;
  const started = Date.now();
  const battery = await benchmarkCodingBattery(looping, { models: [{ role: "main", model: "main-35b" }], taskIds: ["slugify"] });
  assert.equal(battery.rows[0].passedCases, 0);
  assert.ok(Date.now() - started < 5000);
});

function fakeProjectLlm(): KittenLLM {
  const fake = {
    models: { baseUrl: "http://fixture", main: "main-35b", sidecar: "sidecar-2b" },
    chat: async (params: ChatParams) => response(params.messages.at(-1)?.content.includes("planRetries") ? projectCandidates.retry : projectCandidates.merge),
    sidecar: async (params: ChatParams) => response(params.messages.at(-1)?.content.includes("planRetries") ? projectCandidates.retry : projectCandidates.merge),
  } as unknown as KittenLLM;
  return fake;
}

test("held-out project benchmark loads multiple files in VM and evaluates hidden cases", async () => {
  const battery = await benchmarkProjectBattery(fakeProjectLlm(), { models: [{ role: "main", model: "main-35b" }, { role: "sidecar", model: "sidecar-2b" }] });
  assert.equal(battery.rows.length, 2);
  assert.equal(battery.rows[0].passedCases, 6);
  assert.equal(battery.rows[1].score, 1);
  assert.equal(battery.rows[0].rows.length, HELD_OUT_PROJECT_TASKS.length);
  assert.match(battery.note, /never touch the workspace/);
});

test("held-out project benchmark rejects traversal and unsafe generated files", async () => {
  const unsafe = {
    models: { baseUrl: "http://fixture", main: "main-35b" },
    chat: async () => response(JSON.stringify({ files: [{ path: "../escape.js", content: "module.exports = {};" }] })),
    sidecar: async () => response(JSON.stringify({ files: [{ path: "src/index.js", content: "module.exports = require('fs');" }, { path: "src/mergeConfig.js", content: "module.exports = {};" }] })),
  } as unknown as KittenLLM;
  const battery = await benchmarkProjectBattery(unsafe, { models: [{ role: "main", model: "main-35b" }, { role: "sidecar", model: "sidecar-2b" }], taskIds: ["config-merge-project"] });
  assert.equal(battery.rows[0].passedCases, 0);
  assert.match(battery.rows[0].rows[0].error ?? "", /unsafe|missing/);
  assert.equal(battery.rows[1].passedCases, 0);
});

test("held-out project benchmark contains an infinite generated module call", async () => {
  const looping = {
    models: { baseUrl: "http://fixture", main: "main-35b" },
    chat: async () => response(JSON.stringify({ files: [
      { path: "src/index.js", content: "module.exports = { mergeConfig: require('./mergeConfig') };" },
      { path: "src/mergeConfig.js", content: "module.exports = function() { while (true) {} };" },
    ] })),
    sidecar: async () => response(JSON.stringify({ files: [] })),
  } as unknown as KittenLLM;
  const started = Date.now();
  const battery = await benchmarkProjectBattery(looping, { models: [{ role: "main", model: "main-35b" }], taskIds: ["config-merge-project"] });
  assert.equal(battery.rows[0].passedCases, 0);
  assert.ok(Date.now() - started < 5000);
});

test("full model bakeoff combines coding and held-out project signals transparently", async () => {
  const bakeoff = await benchmarkModelBakeoff(fakeProjectLlm(), { models: [{ role: "main", model: "main-35b" }, { role: "sidecar", model: "sidecar-2b" }], timeoutMs: 5_000 });
  assert.equal(bakeoff.recommendations.length, 2);
  assert.ok(bakeoff.recommendations.every((row) => row.qualityScore >= 0 && row.qualityScore <= 1));
  assert.ok(bakeoff.recommendations[0].role);
  assert.match(bakeoff.note, /not a claim/);
});

test("full model bakeoff can compare more than the currently configured pair", async () => {
  const models = [
    { role: "main" as const, model: "main-35b" },
    { role: "main" as const, model: "main-70b" },
    { role: "sidecar" as const, model: "sidecar-2b" },
    { role: "sidecar" as const, model: "sidecar-9b" },
  ];
  const bakeoff = await benchmarkModelBakeoff(fakeProjectLlm(), { models, maxModels: 4, timeoutMs: 5_000 });
  assert.equal(bakeoff.recommendations.length, 4);
  assert.equal(new Set(bakeoff.recommendations.map((row) => row.model)).size, 4);
});

test("persisted bakeoff history is bounded and restart-readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "kitten-bakeoff-history-"));
  try {
    const bakeoff = await benchmarkModelBakeoff(fakeProjectLlm(), { models: [{ role: "main", model: "main-35b" }], timeoutMs: 5_000 });
    const path = saveModelBakeoff(root, bakeoff);
    const history = listModelBakeoffs(root, 1);
    assert.equal(history.length, 1);
    assert.equal(history[0].path, path);
    assert.ok(history[0].sizeBytes > 0);
    const latest = latestModelBakeoffSummary(root);
    assert.equal(latest?.path, path);
    assert.ok(latest?.recommendations.some((row) => row.model === "main-35b"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
