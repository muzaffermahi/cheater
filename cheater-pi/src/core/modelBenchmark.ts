// Small, honest local-model benchmark used by the native diagnostics surface.
// It measures request latency and returned completion throughput only; it never claims that a
// synthetic prompt predicts coding quality.

import type { KittenLLM } from "./llm.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

export interface ModelBenchmarkSample {
  model: string;
  ok: boolean;
  elapsedMs: number;
  completionTokens: number;
  tokensPerSecond: number;
  error?: string;
}

export interface ModelBenchmarkResult {
  model: string;
  requestedSamples: number;
  samples: ModelBenchmarkSample[];
  successfulSamples: number;
  medianLatencyMs: number | null;
  medianTokensPerSecond: number | null;
  note: string;
}

export interface ModelBenchmarkBattery {
  createdAt: string;
  rows: Array<ModelBenchmarkResult & { role: "main" | "sidecar" }>;
  note: string;
}

/**
 * Small, deterministic coding-quality battery.  This deliberately evaluates pure functions in a
 * VM instead of letting benchmark output touch the user's workspace or execute shell commands.
 * It is a useful signal for choosing between local tiers, not a claim of general SWE-bench quality.
 */
export interface CodingBenchmarkTask {
  id: string;
  title: string;
  prompt: string;
  cases: Array<{ input: unknown[]; expected: unknown }>;
}

export interface CodingBenchmarkTaskResult {
  taskId: string;
  title: string;
  ok: boolean;
  passed: number;
  total: number;
  elapsedMs: number;
  error?: string;
}

export interface CodingBenchmarkResult {
  role: "main" | "sidecar";
  model: string;
  requestedTasks: number;
  completedTasks: number;
  passedTasks: number;
  totalCases: number;
  passedCases: number;
  score: number;
  rows: CodingBenchmarkTaskResult[];
  note: string;
}

export interface CodingBenchmarkBattery {
  createdAt: string;
  rows: CodingBenchmarkResult[];
  note: string;
}

/** Held-out multi-file tasks. These prompts are intentionally separate from the coding smoke tasks
 * above so a model cannot pass by memorising the probe wording. Candidates stay in memory and are
 * evaluated through a tiny CommonJS loader inside VM contexts; no workspace or shell is touched. */
export interface ProjectBenchmarkTask {
  id: string;
  title: string;
  prompt: string;
  requiredFiles: string[];
  entry: string;
  exportName: string;
  cases: Array<{ input: unknown[]; expected: unknown }>;
}

export interface ProjectBenchmarkTaskResult {
  taskId: string;
  title: string;
  ok: boolean;
  passed: number;
  total: number;
  elapsedMs: number;
  error?: string;
}

export interface ProjectBenchmarkResult {
  role: "main" | "sidecar";
  model: string;
  requestedTasks: number;
  completedTasks: number;
  passedTasks: number;
  totalCases: number;
  passedCases: number;
  score: number;
  rows: ProjectBenchmarkTaskResult[];
  note: string;
}

export interface ProjectBenchmarkBattery {
  createdAt: string;
  rows: ProjectBenchmarkResult[];
  note: string;
}

export interface ModelBakeoffRecommendation {
  role: "main" | "sidecar";
  model: string;
  qualityScore: number;
  codingScore: number;
  projectScore: number;
  medianTaskMs: number | null;
  reason: string;
}

/** A bounded, in-app bakeoff that combines isolated coding and held-out project signals.
 * It is intentionally explicit about being a selection aid, never a universal benchmark. */
export interface ModelBakeoff {
  createdAt: string;
  coding: CodingBenchmarkBattery;
  project: ProjectBenchmarkBattery;
  recommendations: ModelBakeoffRecommendation[];
  note: string;
}

export interface ModelBenchmarkProgress {
  phase: "coding" | "project";
  status: "started" | "completed";
  role: "main" | "sidecar";
  model: string;
  taskId: string;
  taskIndex: number;
  taskTotal: number;
  modelIndex: number;
  modelTotal: number;
  ok?: boolean;
  passed?: number;
  total?: number;
  elapsedMs?: number;
  error?: string;
}

type ModelBenchmarkProgressHandler = (progress: ModelBenchmarkProgress) => void;

export interface ModelBakeoffHistoryEntry {
  path: string;
  modifiedAt: string;
  sizeBytes: number;
}

export interface LatestModelBakeoffSummary {
  path: string;
  modifiedAt: string;
  recommendations: Array<Pick<ModelBakeoffRecommendation, "role" | "model" | "qualityScore" | "codingScore" | "projectScore">>;
}

export const CODING_BENCHMARK_TASKS: CodingBenchmarkTask[] = [
  {
    id: "slugify",
    title: "Stable URL slug",
    prompt: "Implement slugify. Return CommonJS code with exactly `module.exports = function(value) { ... }` (do not put the function name inside the parameter list). Lowercase, trim, replace each run of non ASCII letters/digits with one hyphen, and trim hyphens. Do not use require, imports, process, eval, or the filesystem.",
    cases: [
      { input: [" Hello, World! "], expected: "hello-world" },
      { input: ["Already--clean"], expected: "already-clean" },
      { input: ["  A + B / C  "], expected: "a-b-c" },
    ],
  },
  {
    id: "merge-intervals",
    title: "Merge overlapping intervals",
    prompt: "Return CommonJS code whose module.exports is a function mergeIntervals(intervals). Return a new array sorted by start; merge overlapping or integer-adjacent [start,end] pairs (merge when next.start <= current.end + 1) without mutating the input.",
    cases: [
      { input: [[[1, 3], [2, 6], [8, 10], [9, 12]]], expected: [[1, 6], [8, 12]] },
      { input: [[[5, 7], [1, 1], [2, 4]]], expected: [[1, 7]] },
      { input: [[]], expected: [] },
    ],
  },
  {
    id: "parse-env",
    title: "Parse simple env text",
    prompt: "Return CommonJS code whose module.exports is a function parseEnv(text). Iterate once over text.split(/\\r?\\n/); never use a while loop whose condition reads the unchanged whole text. Parse KEY=VALUE lines, ignore blank lines and lines beginning with #, split only on the first =, trim the key, and preserve the value after the first =. Return a plain object.",
    cases: [
      { input: ["A=1\nB=hello=world\n# ignored\n"], expected: { A: "1", B: "hello=world" } },
      { input: ["  NAME = kitten  \n\n"], expected: { NAME: " kitten  " } },
      { input: [""], expected: {} },
    ],
  },
];

export const HELD_OUT_PROJECT_TASKS: ProjectBenchmarkTask[] = [
  {
    id: "config-merge-project",
    title: "Multi-file configuration merge",
    prompt: "Implement this small CommonJS project. Return only JSON {\"files\":[{\"path\":\"...\",\"content\":\"...\"}]} with exactly src/index.js and src/mergeConfig.js. index.js must require('./mergeConfig') and export it as { mergeConfig }. mergeConfig(base, override) recursively merges plain objects, replaces arrays and scalar values, and never mutates either input. Do not use Node builtins, process, eval, Function, or filesystem access.",
    requiredFiles: ["src/index.js", "src/mergeConfig.js"],
    entry: "src/index.js",
    exportName: "mergeConfig",
    cases: [
      { input: [{ theme: { color: "blue", size: 2 }, enabled: true }, { theme: { size: 3 }, count: 1 }], expected: { theme: { color: "blue", size: 3 }, enabled: true, count: 1 } },
      { input: [{ list: [1, 2], nested: { keep: 1 } }, { list: [9], nested: { add: 2 } }], expected: { list: [9], nested: { keep: 1, add: 2 } } },
      { input: [{ a: { b: { c: 1 } } }, { a: { b: { d: 2 } } }], expected: { a: { b: { c: 1, d: 2 } } } },
    ],
  },
  {
    id: "retry-policy-project",
    title: "Bounded retry policy",
    prompt: "Implement this small CommonJS project. Return only JSON {\"files\":[{\"path\":\"...\",\"content\":\"...\"}]} with exactly src/index.js and src/retry.js. index.js must require('./retry') and export it as { planRetries }. planRetries({ attempts, baseMs, maxMs }) returns an array of delay milliseconds: zero or negative attempts returns [], delays grow exponentially from baseMs, are capped at maxMs, and all outputs are finite non-negative integers. Treat missing/invalid numbers safely. Do not use randomness, Node builtins, process, eval, Function, or filesystem access.",
    requiredFiles: ["src/index.js", "src/retry.js"],
    entry: "src/index.js",
    exportName: "planRetries",
    cases: [
      { input: [{ attempts: 4, baseMs: 100, maxMs: 1000 }], expected: [100, 200, 400, 800] },
      { input: [{ attempts: 6, baseMs: 300, maxMs: 700 }], expected: [300, 600, 700, 700, 700, 700] },
      { input: [{ attempts: 0, baseMs: 100, maxMs: 1000 }], expected: [] },
    ],
  },
];

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    return item;
  });
}

function parseGeneratedModule(content: string): string {
  const trimmed = content.trim().replace(/^```(?:javascript|js|typescript|ts)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let candidate = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "string") candidate = (parsed as { code: string }).code;
  } catch { /* the prompt allows a fenced/code-only fallback */ }
  return candidate.trim();
}

function parseGeneratedProject(content: string): Array<{ path: string; content: string }> {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const raw = parsed && typeof parsed === "object" ? (parsed as { files?: unknown }).files : undefined;
    if (Array.isArray(raw)) return raw.filter((file): file is { path: string; content: string } => Boolean(file && typeof file === "object" && typeof (file as { path?: unknown }).path === "string" && typeof (file as { content?: unknown }).content === "string")).slice(0, 12);
    if (raw && typeof raw === "object") return Object.entries(raw as Record<string, unknown>).filter(([, value]) => typeof value === "string").map(([path, value]) => ({ path, content: value as string })).slice(0, 12);
  } catch { /* malformed project output is scored as a failed task */ }
  return [];
}

function normalizeProjectPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..") || !/^src\/[A-Za-z0-9._/-]+\.js$/.test(normalized)) return null;
  return normalized;
}

interface VmProjectModule { exports: unknown; context: Record<string, unknown> }

function runGeneratedProject(content: string, task: ProjectBenchmarkTask): { passed: number; error?: string } {
  const generated = parseGeneratedProject(content);
  const files = new Map<string, string>();
  for (const file of generated) {
    const path = normalizeProjectPath(file.path);
    if (!path || file.content.length > 60_000 || files.has(path)) return { passed: 0, error: "unsafe or duplicate project file" };
    if (/\b(?:process|child_process|fs|net|http|https|os|eval|Function|fetch|XMLHttpRequest|globalThis|constructor|prototype)\b|__proto__/.test(file.content)) return { passed: 0, error: "unsafe project source" };
    files.set(path, file.content);
  }
  if (task.requiredFiles.some((path) => !files.has(path))) return { passed: 0, error: "required project file missing" };
  const cache = new Map<string, VmProjectModule>();
  const resolve = (from: string, request: string): string | null => {
    if (!request.startsWith(".")) return null;
    const base = from.slice(0, from.lastIndexOf("/"));
    const path = `${base}/${request}`.replace(/\/\.\//g, "/").replace(/\/\/+/, "/").replace(/^\.\//, "");
    return files.has(path) ? path : files.has(`${path}.js`) ? `${path}.js` : null;
  };
  const load = (path: string, stack: string[] = []): VmProjectModule => {
    const existing = cache.get(path);
    if (existing) return existing;
    if (stack.includes(path) || stack.length > 8) throw new Error("project module cycle or depth limit");
    const module = { exports: {} as unknown };
    const context: Record<string, unknown> = { module, exports: module.exports, JSON, Math, Array, Object, String, Number, Boolean, RegExp, Date, Map, Set };
    const localRequire = (request: string): unknown => {
      const resolved = resolve(path, request);
      if (!resolved) throw new Error("out-of-scope require");
      return load(resolved, [...stack, path]).exports;
    };
    context.require = localRequire;
    const vmModule = new vm.Script(files.get(path)!, { filename: `kitten-heldout-${path}` });
    vmModule.runInNewContext(context, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
    const result = { exports: module.exports, context };
    cache.set(path, result);
    return result;
  };
  try {
    const entry = load(task.entry);
    if (!entry.exports || typeof entry.exports !== "object" || typeof (entry.exports as Record<string, unknown>)[task.exportName] !== "function") return { passed: 0, error: "requested project export missing" };
    const invoke = new vm.Script(`module.exports[${JSON.stringify(task.exportName)}](...__kittenInput)`, { filename: `kitten-heldout-${task.id}-case` });
    let passed = 0;
    for (const testCase of task.cases) {
      try {
        entry.context.__kittenInput = testCase.input;
        const actual = invoke.runInNewContext(entry.context, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
        if (stableJson(actual) === stableJson(testCase.expected)) passed += 1;
      } catch { /* failed cases are counted, not allowed to abort the battery */ }
    }
    return { passed };
  } catch (error) {
    return { passed: 0, error: (error as Error).message.slice(0, 240) };
  }
}

function runGeneratedFunction(content: string, task: CodingBenchmarkTask): { passed: number; error?: string } {
  const code = parseGeneratedModule(content);
  if (!code || /\b(?:require|import|export|process|child_process|eval|Function|fetch|XMLHttpRequest|globalThis|constructor|prototype)\b|__proto__/.test(code)) return { passed: 0, error: "unsafe or empty generated module" };
  const module = { exports: {} as unknown };
  const sandbox = { module, exports: module.exports, JSON, Math, Array, Object, String, Number, Boolean, RegExp, Date, Map, Set };
  try {
    new vm.Script(code, { filename: `kitten-benchmark-${task.id}.js` }).runInNewContext(sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
    if (typeof module.exports !== "function") return { passed: 0, error: "module.exports is not a function" };
    let passed = 0;
    const invoke = new vm.Script("module.exports(...__kittenInput)", { filename: `kitten-benchmark-${task.id}-case.js` });
    for (const testCase of task.cases) {
      try {
        // Invoke inside the context too. Calling a VM-created function from the host lets an
        // accidental infinite loop escape the script timeout and could hang the native app.
        (sandbox as Record<string, unknown>).__kittenInput = testCase.input;
        const actual = invoke.runInNewContext(sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
        if (stableJson(actual) === stableJson(testCase.expected)) passed += 1;
      } catch { /* one bad case should not abort the battery */ }
    }
    return { passed };
  } catch (error) {
    return { passed: 0, error: (error as Error).message.slice(0, 240) };
  }
}

async function generateCodingCandidate(llm: KittenLLM, role: "main" | "sidecar", model: string, task: CodingBenchmarkTask, timeoutMs: number, signal?: AbortSignal): Promise<{ content: string; elapsedMs: number; error?: string }> {
  const started = Date.now();
  const messages = [
    { role: "system" as const, content: "You are a coding benchmark worker. Follow the task exactly. Return only a JSON object {\"code\":\"...\"}; the code must set module.exports to the requested function. No markdown." },
    { role: "user" as const, content: task.prompt },
  ];
  const result = role === "sidecar"
    ? await llm.sidecar({ model, messages, maxTokens: 768, temperature: 0, timeoutMs, signal, jsonSchema: { name: "coding_candidate", schema: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string" } } } } })
    : await llm.chat({ model, messages, maxTokens: 4096, reasoningEffort: "low", temperature: 0, timeoutMs, signal, jsonSchema: { name: "coding_candidate", schema: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string" } } } } });
  return { content: result.content, elapsedMs: Date.now() - started, ...(result.ok ? {} : { error: result.error ?? "model request failed" }) };
}

/** Run a bounded, workspace-isolated coding battery for one or both configured tiers. */
export async function benchmarkCodingBattery(llm: KittenLLM, options: { models: Array<{ model: string; role: "main" | "sidecar" }>; taskIds?: string[]; timeoutMs?: number; signal?: AbortSignal; maxModels?: number; onProgress?: ModelBenchmarkProgressHandler } ): Promise<CodingBenchmarkBattery> {
  const selected = (options.taskIds?.length ? CODING_BENCHMARK_TASKS.filter((task) => options.taskIds!.includes(task.id)) : CODING_BENCHMARK_TASKS).slice(0, 3);
  const rows: CodingBenchmarkResult[] = [];
  const maxModels = Math.max(1, Math.min(8, Math.floor(options.maxModels ?? 2)));
  const configuredModels = options.models.slice(0, maxModels);
  for (const [modelIndex, configured] of configuredModels.entries()) {
    const taskRows: CodingBenchmarkTaskResult[] = [];
    for (const [taskIndex, task] of selected.entries()) {
      if (options.signal?.aborted) break;
      options.onProgress?.({ phase: "coding", status: "started", role: configured.role, model: configured.model, taskId: task.id, taskIndex: taskIndex + 1, taskTotal: selected.length, modelIndex: modelIndex + 1, modelTotal: configuredModels.length });
      const candidate = await generateCodingCandidate(llm, configured.role, configured.model, task, Math.max(5_000, Math.min(60_000, options.timeoutMs ?? 30_000)), options.signal);
      const evaluated = candidate.error ? { passed: 0, error: candidate.error } : runGeneratedFunction(candidate.content, task);
      const taskResult = { taskId: task.id, title: task.title, ok: !evaluated.error && evaluated.passed === task.cases.length, passed: evaluated.passed, total: task.cases.length, elapsedMs: candidate.elapsedMs, ...(evaluated.error ? { error: evaluated.error } : {}) };
      taskRows.push(taskResult);
      options.onProgress?.({ phase: "coding", status: "completed", role: configured.role, model: configured.model, taskId: task.id, taskIndex: taskIndex + 1, taskTotal: selected.length, modelIndex: modelIndex + 1, modelTotal: configuredModels.length, ok: taskResult.ok, passed: taskResult.passed, total: taskResult.total, elapsedMs: taskResult.elapsedMs, ...(taskResult.error ? { error: taskResult.error } : {}) });
    }
    const totalCases = taskRows.reduce((sum, row) => sum + row.total, 0);
    const passedCases = taskRows.reduce((sum, row) => sum + row.passed, 0);
    rows.push({ role: configured.role, model: configured.model, requestedTasks: selected.length, completedTasks: taskRows.length, passedTasks: taskRows.filter((row) => row.ok).length, totalCases, passedCases, score: totalCases ? passedCases / totalCases : 0, rows: taskRows, note: "Bounded pure-function battery in a VM sandbox; it is a model-selection signal, not a general coding benchmark." });
  }
  return { createdAt: new Date().toISOString(), rows, note: "Coding-quality smoke battery: deterministic tasks, isolated evaluation, no workspace or shell access. Use held-out project tasks for serious model comparisons." };
}

export function saveCodingBenchmarkBattery(cwd: string, battery: CodingBenchmarkBattery): string {
  const directory = join(cwd, ".cheater", "model-benchmarks");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `coding-benchmark-${Date.now().toString(36)}.json`);
  writeFileSync(file, `${JSON.stringify(battery, null, 2)}\n`, "utf8");
  return file;
}

async function generateProjectCandidate(llm: KittenLLM, role: "main" | "sidecar", model: string, task: ProjectBenchmarkTask, timeoutMs: number, signal?: AbortSignal, feedback = ""): Promise<{ content: string; elapsedMs: number; error?: string }> {
  const started = Date.now();
  const messages = [
    { role: "system" as const, content: "You are a held-out project coding worker. Return only JSON {\"files\":[{\"path\":\"src/...js\",\"content\":\"...\"}]}. The files array must contain every required file, not a generator or a summary. Example shape: {\"files\":[{\"path\":\"src/index.js\",\"content\":\"module.exports = {};\"},{\"path\":\"src/helper.js\",\"content\":\"module.exports = function() {};\"}]}. Do not use markdown, Node builtins, process, eval, Function, randomness, or filesystem access." },
    { role: "user" as const, content: `${task.prompt}${feedback ? `\n\nThe previous candidate was rejected by the evaluator: ${feedback}. Return a complete corrected replacement for every required file.` : ""}` },
  ];
  const schema = { name: "project_candidate", schema: { type: "object", additionalProperties: false, required: ["files"], properties: { files: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } } } } };
  const result = role === "sidecar"
    ? await llm.sidecar({ model, messages, maxTokens: 1200, temperature: 0, timeoutMs, signal, jsonSchema: schema })
    : await llm.chat({ model, messages, maxTokens: 4096, reasoningEffort: "low", temperature: 0, timeoutMs, signal, jsonSchema: schema });
  return { content: result.content, elapsedMs: Date.now() - started, ...(result.ok ? {} : { error: result.error ?? "model request failed" }) };
}

/** Run held-out multi-file tasks through an in-memory module loader. This is deliberately separate
 * from the coding smoke battery and never writes generated files to the selected project. */
export async function benchmarkProjectBattery(llm: KittenLLM, options: { models: Array<{ model: string; role: "main" | "sidecar" }>; taskIds?: string[]; timeoutMs?: number; signal?: AbortSignal; maxModels?: number; onProgress?: ModelBenchmarkProgressHandler } ): Promise<ProjectBenchmarkBattery> {
  const selected = (options.taskIds?.length ? HELD_OUT_PROJECT_TASKS.filter((task) => options.taskIds!.includes(task.id)) : HELD_OUT_PROJECT_TASKS).slice(0, 2);
  const rows: ProjectBenchmarkResult[] = [];
  const timeoutMs = Math.max(8_000, Math.min(90_000, options.timeoutMs ?? 45_000));
  const maxModels = Math.max(1, Math.min(8, Math.floor(options.maxModels ?? 2)));
  const configuredModels = options.models.slice(0, maxModels);
  for (const [modelIndex, configured] of configuredModels.entries()) {
    const taskRows: ProjectBenchmarkTaskResult[] = [];
    for (const [taskIndex, task] of selected.entries()) {
      if (options.signal?.aborted) break;
      options.onProgress?.({ phase: "project", status: "started", role: configured.role, model: configured.model, taskId: task.id, taskIndex: taskIndex + 1, taskTotal: selected.length, modelIndex: modelIndex + 1, modelTotal: configuredModels.length });
      let candidate = await generateProjectCandidate(llm, configured.role, configured.model, task, timeoutMs, options.signal);
      let evaluated = candidate.error ? { passed: 0, error: candidate.error } : runGeneratedProject(candidate.content, task);
      // One bounded repair pass mirrors the real agent loop, but only for an invalid shape/scope.
      // Never retry a timeout/network failure: doing so amplifies an unavailable endpoint.
      if (evaluated.error && /required project file missing|unsafe|duplicate|requested project export missing/.test(evaluated.error) && !options.signal?.aborted) {
        const repair = await generateProjectCandidate(llm, configured.role, configured.model, task, Math.min(timeoutMs, 20_000), options.signal, evaluated.error);
        candidate = { ...repair, elapsedMs: candidate.elapsedMs + repair.elapsedMs };
        evaluated = repair.error ? { passed: 0, error: repair.error } : runGeneratedProject(repair.content, task);
      }
      const taskResult = { taskId: task.id, title: task.title, ok: !evaluated.error && evaluated.passed === task.cases.length, passed: evaluated.passed, total: task.cases.length, elapsedMs: candidate.elapsedMs, ...(evaluated.error ? { error: evaluated.error } : {}) };
      taskRows.push(taskResult);
      options.onProgress?.({ phase: "project", status: "completed", role: configured.role, model: configured.model, taskId: task.id, taskIndex: taskIndex + 1, taskTotal: selected.length, modelIndex: modelIndex + 1, modelTotal: configuredModels.length, ok: taskResult.ok, passed: taskResult.passed, total: taskResult.total, elapsedMs: taskResult.elapsedMs, ...(taskResult.error ? { error: taskResult.error } : {}) });
    }
    const totalCases = taskRows.reduce((sum, row) => sum + row.total, 0);
    const passedCases = taskRows.reduce((sum, row) => sum + row.passed, 0);
    rows.push({ role: configured.role, model: configured.model, requestedTasks: selected.length, completedTasks: taskRows.length, passedTasks: taskRows.filter((row) => row.ok).length, totalCases, passedCases, score: totalCases ? passedCases / totalCases : 0, rows: taskRows, note: "Held-out multi-file project battery in VM-isolated CommonJS modules; not a claim of broad SWE-bench performance." });
  }
  return { createdAt: new Date().toISOString(), rows, note: "Held-out project signal: prompts and hidden cases are separate from the coding smoke battery. One bounded repair pass is allowed for malformed project shape; generated files never touch the workspace or execute shell/network access." };
}

/** Run both quality batteries for the configured tiers and produce a transparent recommendation. */
export async function benchmarkModelBakeoff(llm: KittenLLM, options: { models: Array<{ model: string; role: "main" | "sidecar" }>; timeoutMs?: number; signal?: AbortSignal; maxModels?: number; onProgress?: ModelBenchmarkProgressHandler }): Promise<ModelBakeoff> {
  const maxModels = Math.max(1, Math.min(8, Math.floor(options.maxModels ?? 2)));
  const models = options.models.slice(0, maxModels);
  const coding = await benchmarkCodingBattery(llm, { models, timeoutMs: options.timeoutMs, signal: options.signal, maxModels, onProgress: options.onProgress });
  if (options.signal?.aborted) throw new Error("model bakeoff cancelled");
  const project = await benchmarkProjectBattery(llm, { models, timeoutMs: options.timeoutMs, signal: options.signal, maxModels, onProgress: options.onProgress });
  if (options.signal?.aborted) throw new Error("model bakeoff cancelled");
  const recommendations: ModelBakeoffRecommendation[] = [];
  for (const configured of models) {
    const codingRow = coding.rows.find((row) => row.role === configured.role && row.model === configured.model);
    const projectRow = project.rows.find((row) => row.role === configured.role && row.model === configured.model);
    const codingScore = codingRow?.score ?? 0;
    const projectScore = projectRow?.score ?? 0;
    const qualityScore = (codingScore + projectScore) / 2;
    const taskTimes = [...(codingRow?.rows ?? []), ...(projectRow?.rows ?? [])].map((row) => row.elapsedMs).filter((ms) => Number.isFinite(ms) && ms >= 0);
    const sorted = taskTimes.sort((a, b) => a - b);
    const medianTaskMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    recommendations.push({ role: configured.role, model: configured.model, qualityScore, codingScore, projectScore, medianTaskMs, reason: qualityScore > 0 ? "highest available isolated quality signal for this configured tier" : "no passing isolated cases; inspect endpoint/model health" });
  }
  recommendations.sort((a, b) => b.qualityScore - a.qualityScore || (a.medianTaskMs ?? Number.MAX_SAFE_INTEGER) - (b.medianTaskMs ?? Number.MAX_SAFE_INTEGER));
  return { createdAt: new Date().toISOString(), coding, project, recommendations, note: "Bounded local bakeoff: pure-function and held-out multi-file VM signals combined for this machine. It is not a claim of general SWE-bench superiority." };
}

export function saveProjectBenchmarkBattery(cwd: string, battery: ProjectBenchmarkBattery): string {
  const directory = join(cwd, ".cheater", "model-benchmarks");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `project-benchmark-${Date.now().toString(36)}.json`);
  writeFileSync(file, `${JSON.stringify(battery, null, 2)}\n`, "utf8");
  return file;
}

export function saveModelBakeoff(cwd: string, bakeoff: ModelBakeoff): string {
  const directory = join(cwd, ".cheater", "model-benchmarks");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `model-bakeoff-${Date.now().toString(36)}.json`);
  writeFileSync(file, `${JSON.stringify(bakeoff, null, 2)}\n`, "utf8");
  return file;
}

/** List the most recent persisted bakeoffs so the native app can restore evidence after restart. */
export function listModelBakeoffs(cwd: string, max = 8): ModelBakeoffHistoryEntry[] {
  const directory = join(cwd, ".cheater", "model-benchmarks");
  if (!existsSync(directory)) return [];
  const limit = Math.max(1, Math.min(32, Math.floor(max)));
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^model-bakeoff-[a-z0-9]+\.json$/i.test(entry.name))
    .map((entry) => {
      const path = join(directory, entry.name);
      const stat = statSync(path);
      return { path, modifiedAt: new Date(stat.mtimeMs).toISOString(), sizeBytes: stat.size };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, limit);
}

/** Read only the bounded recommendation slice of the newest bakeoff for native status surfaces. */
export function latestModelBakeoffSummary(cwd: string): LatestModelBakeoffSummary | null {
  const entry = listModelBakeoffs(cwd, 1)[0];
  if (!entry) return null;
  try {
    const parsed = JSON.parse(readFileSync(entry.path, "utf8")) as { recommendations?: unknown };
    const recommendations = Array.isArray(parsed.recommendations)
      ? parsed.recommendations.map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        const role = row.role === "main" || row.role === "sidecar" ? row.role : null;
        const model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : null;
        if (!role || !model) return null;
        const score = (key: string): number => typeof row[key] === "number" && Number.isFinite(row[key]) ? Math.max(0, Math.min(1, row[key] as number)) : 0;
        return { role, model, qualityScore: score("qualityScore"), codingScore: score("codingScore"), projectScore: score("projectScore") };
      }).filter((item): item is LatestModelBakeoffSummary["recommendations"][number] => item !== null).slice(0, 6)
      : [];
    return { path: entry.path, modifiedAt: entry.modifiedAt, recommendations };
  } catch { return null; }
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Run a bounded, non-streaming probe against one configured model. */
export async function benchmarkModel(llm: KittenLLM, options: { model?: string; samples?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ModelBenchmarkResult> {
  const model = options.model?.trim() || llm.models.main;
  const requestedSamples = Math.max(1, Math.min(5, Math.floor(options.samples ?? 2)));
  const samples: ModelBenchmarkSample[] = [];
  for (let index = 0; index < requestedSamples; index += 1) {
    if (options.signal?.aborted) break;
    const result = await llm.chat({
      model,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      maxTokens: 16,
      temperature: 0,
      disableThinking: true,
      timeoutMs: Math.max(1000, Math.min(60_000, options.timeoutMs ?? 20_000)),
      signal: options.signal,
    });
    const completionTokens = Math.max(0, result.usage.completion);
    samples.push({
      model,
      ok: result.ok,
      elapsedMs: result.elapsedMs,
      completionTokens,
      tokensPerSecond: completionTokens > 0 && result.elapsedMs > 0 ? completionTokens / (result.elapsedMs / 1000) : 0,
      ...(result.error ? { error: result.error } : {}),
    });
  }
  const successful = samples.filter((sample) => sample.ok);
  return {
    model,
    requestedSamples,
    samples,
    successfulSamples: successful.length,
    medianLatencyMs: median(successful.map((sample) => sample.elapsedMs)),
    medianTokensPerSecond: median(successful.map((sample) => sample.tokensPerSecond).filter((value) => value > 0)),
    note: "Synthetic probe only; use it to compare endpoint responsiveness, not coding quality.",
  };
}

/** Measure the configured main and sidecar tiers using the same bounded probe. */
export async function benchmarkModelBattery(llm: KittenLLM, options: { models: Array<{ model: string; role: "main" | "sidecar" }>; samples?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<ModelBenchmarkBattery> {
  const rows: Array<ModelBenchmarkResult & { role: "main" | "sidecar" }> = [];
  for (const configured of options.models.slice(0, 2)) {
    if (options.signal?.aborted) break;
    rows.push({ role: configured.role, ...(await benchmarkModel(llm, { model: configured.model, samples: options.samples, timeoutMs: options.timeoutMs, signal: options.signal })) });
  }
  return {
    createdAt: new Date().toISOString(),
    rows,
    note: "Synthetic responsiveness battery only; compare local conditions across tiers, not coding quality.",
  };
}

export function formatModelBenchmarkBattery(battery: ModelBenchmarkBattery): string {
  return battery.rows.map((row) => `${row.role}: ${row.model} success=${row.successfulSamples}/${row.requestedSamples} median=${row.medianLatencyMs === null ? "n/a" : `${Math.round(row.medianLatencyMs)}ms`} tps=${row.medianTokensPerSecond === null ? "n/a" : row.medianTokensPerSecond.toFixed(1)}`).join("\n");
}

export function saveModelBenchmarkBattery(cwd: string, battery: ModelBenchmarkBattery): string {
  const directory = join(cwd, ".cheater", "model-benchmarks");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `model-benchmark-${Date.now().toString(36)}.json`);
  writeFileSync(file, `${JSON.stringify(battery, null, 2)}\n`, "utf8");
  return file;
}
