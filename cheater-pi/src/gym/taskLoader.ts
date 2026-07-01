import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GymTask } from "./types.js";

const REQUIRED_FIELDS: Array<keyof GymTask> = [
  "id", "title", "language", "category", "difficulty", "goal",
  "focusedTestCommand", "expectedTouchedFiles", "forbiddenTouchedFiles",
  "successCriteria", "tags", "runMode", "source"
];

const VALID_LANGUAGES = new Set(["python", "javascript", "typescript"]);
const VALID_CATEGORIES = new Set([
  "import_error", "syntax_error", "off_by_one", "wrong_exception", "fixture_scope",
  "async_misuse", "path_handling", "json_serialization", "cli_parsing", "config_parsing",
  "duplicate_filter", "ranking_sorting", "cache_invalidation", "regex_edge",
  "datetime_parsing", "type_conversion", "package_export", "test_state_leak",
  "wrong_export", "promise_not_awaited", "path_normalization", "json_parsing",
  "tsc_failure", "other"
]);
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const VALID_RUN_MODES = new Set(["fixture", "generated"]);

export interface LoadTasksOptions {
  rootDir: string;
  includeGenerated?: boolean;
}

export interface LoadTasksResult {
  tasks: GymTask[];
  errors: Array<{ taskId: string; reason: string }>;
}

export function loadGymTasks(options: LoadTasksOptions): LoadTasksResult {
  const tasksDir = join(options.rootDir, ".cheater", "gym", "tasks");
  if (!existsSync(tasksDir)) return { tasks: [], errors: [] };
  const tasks: GymTask[] = [];
  const errors: Array<{ taskId: string; reason: string }> = [];
  const entries = readdirSync(tasksDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(tasksDir, entry.name);
    const taskFile = join(taskDir, "task.json");
    if (!existsSync(taskFile)) {
      errors.push({ taskId: entry.name, reason: "task.json not found" });
      continue;
    }
    const task = parseGymTaskFile(taskFile);
    if ("error" in task) {
      errors.push({ taskId: entry.name, reason: task.error });
      continue;
    }
    if (task.runMode === "generated" && !options.includeGenerated) {
      continue;
    }
    const readmeFile = join(taskDir, "README.md");
    if (existsSync(readmeFile)) {
      try {
        const readme = readFileSync(readmeFile, "utf8");
        if (readme.length < 32_000) task.notes = readme;
      } catch {
        // ignore
      }
    }
    tasks.push(task);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks, errors };
}

export function parseGymTaskFile(path: string): GymTask | { error: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { error: `cannot read ${path}: ${(err as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `invalid JSON: ${(err as Error).message}` };
  }
  return validateGymTask(raw, path);
}

export function validateGymTask(raw: unknown, path: string): GymTask | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "task.json must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) {
      return { error: `missing field: ${field} (${path})` };
    }
  }
  if (typeof obj.id !== "string" || !/^[a-z0-9_-]+$/.test(obj.id)) {
    return { error: "id must be a lowercase slug" };
  }
  if (typeof obj.title !== "string" || obj.title.length < 3) {
    return { error: "title must be a non-empty string" };
  }
  if (!VALID_LANGUAGES.has(obj.language as string)) {
    return { error: `language must be python|javascript|typescript` };
  }
  if (!VALID_CATEGORIES.has(obj.category as string)) {
    return { error: `unknown category: ${obj.category}` };
  }
  if (!VALID_DIFFICULTIES.has(obj.difficulty as string)) {
    return { error: `difficulty must be easy|medium|hard` };
  }
  if (typeof obj.goal !== "string" || obj.goal.length < 5) {
    return { error: "goal must describe the task" };
  }
  if (typeof obj.focusedTestCommand !== "string" || obj.focusedTestCommand.length === 0) {
    return { error: "focusedTestCommand must be a non-empty string" };
  }
  if (!Array.isArray(obj.expectedTouchedFiles) || obj.expectedTouchedFiles.some((f) => typeof f !== "string")) {
    return { error: "expectedTouchedFiles must be a list of strings" };
  }
  if (!Array.isArray(obj.forbiddenTouchedFiles) || obj.forbiddenTouchedFiles.some((f) => typeof f !== "string")) {
    return { error: "forbiddenTouchedFiles must be a list of strings" };
  }
  if (!VALID_RUN_MODES.has(obj.runMode as string)) {
    return { error: `runMode must be fixture|generated` };
  }
  if (!obj.successCriteria || typeof obj.successCriteria !== "object") {
    return { error: "successCriteria is required" };
  }
  const sc = obj.successCriteria as Record<string, unknown>;
  for (const k of ["focusedTestsPass", "fullTestsPass", "noTestEdits", "noDependencyEdits"]) {
    if (typeof sc[k] !== "boolean") {
      return { error: `successCriteria.${k} must be boolean` };
    }
  }
  if (obj.runMode === "fixture") {
    const fixturePath = typeof obj.fixturePath === "string" ? obj.fixturePath : "repo";
    if (typeof obj.fixturePath !== "string") obj.fixturePath = "repo";
    if (!obj.fixturePath) return { error: "fixturePath is required for fixture tasks" };
    void fixturePath;
  }
  if (obj.runMode === "generated") {
    if (!obj.generated || typeof obj.generated !== "object") {
      return { error: "generated block is required for generated tasks" };
    }
    const gen = obj.generated as Record<string, unknown>;
    if (!gen.files || typeof gen.files !== "object") {
      return { error: "generated.files is required" };
    }
  }
  return obj as unknown as GymTask;
}

export function filterTasks(tasks: GymTask[], filter: { category?: string; language?: string; ids?: string[]; limit?: number }): GymTask[] {
  let out = tasks.slice();
  if (filter.category) out = out.filter((task) => task.category === filter.category);
  if (filter.language) out = out.filter((task) => task.language === filter.language);
  if (filter.ids && filter.ids.length > 0) out = out.filter((task) => filter.ids!.includes(task.id));
  if (typeof filter.limit === "number" && filter.limit > 0) out = out.slice(0, filter.limit);
  return out;
}

export function taskSummary(task: GymTask): string {
  return [
    `${task.id}  ${task.title}`,
    `  language: ${task.language}    category: ${task.category}    difficulty: ${task.difficulty}`,
    `  goal: ${task.goal}`,
    `  focused: ${task.focusedTestCommand}`,
    `  expected: ${task.expectedTouchedFiles.join(", ") || "(none)"}`,
    `  forbidden: ${task.forbiddenTouchedFiles.join(", ") || "(none)"}`
  ].join("\n");
}

export function readFixtureRepoSize(taskDir: string, fixturePath: string): number {
  const base = join(taskDir, fixturePath);
  if (!existsSync(base)) return 0;
  return statSync(base).size;
}
