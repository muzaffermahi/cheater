import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { RepoOrientation } from "../blueprint/types.js";
import { detectProjectCommands } from "../reliability/projectCommands.js";

export interface RepoConstraintGraph {
  files: string[];
  symbols: string[];
  exports: string[];
  signatures: string[];
  imports: Array<{ file: string; importPath: string }>;
  commandRegistrations: string[];
  toolRegistrations: string[];
  configKeys: string[];
  tests: string[];
  testMappings: Array<{ file: string; testFile: string }>;
  relatedFiles: Array<{ file: string; relatedFile: string; reason: string }>;
  verificationCommands: Array<{ file: string; command: string; reason: string }>;
}

const PLANNER_SCAN_DIRS = ["src", "lib", "app", "commands", "tools", "test", "tests", "__tests__"];
const PLANNER_SCAN_EXTENSIONS = /\.(ts|tsx|js|jsx|py)$/i;
const PLANNER_MAX_FILES = 80;
const PLANNER_MAX_PER_DIR = 40;
const PLANNER_DIR_ENTRY_LIMIT = 200;

export function buildRepoConstraintGraph(repoRoot: string, files: string[]): RepoConstraintGraph {
  const usableFiles = files.filter((file) => !file.endsWith("/") && !file.startsWith("("));
  const graph: RepoConstraintGraph = {
    files,
    symbols: [],
    exports: [],
    signatures: [],
    imports: [],
    commandRegistrations: [],
    toolRegistrations: [],
    configKeys: [],
    tests: [],
    testMappings: [],
    relatedFiles: [],
    verificationCommands: []
  };
  const cachedCommands = detectProjectCommands(repoRoot);
  for (const rel of usableFiles) {
    const path = join(repoRoot, rel);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const isPython = /\.py$/i.test(rel);
    // symbols/exports must include Python's "def"/module-level assignment so
    // selectFilesByGoalFromGraph (which reads only symbols+exports) can target Python files by
    // function name; previously only signatures (one line below) caught "def", making a
    // Python function invisible to goal-driven file selection even though its own signature
    // line was extracted right after it.
    for (const match of text.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|def|class|interface|type|const)\s+([A-Za-z_]\w*)/g)) graph.symbols.push(`${rel}:${match[1]}`);
    for (const match of text.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|interface|type|const)\s+([A-Za-z_]\w*)/g)) graph.exports.push(`${rel}:${match[1]}`);
    if (isPython) {
      // Python has no `export` keyword: a module-level def/class not prefixed with `_` is
      // its public surface by convention.
      for (const match of text.matchAll(/^(?:def|class)\s+([A-Za-z]\w*)/gm)) graph.exports.push(`${rel}:${match[1]}`);
    }
    for (const match of text.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|def)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g)) graph.signatures.push(`${rel}:${match[1]}(${compactSignature(match[2])})`);
    for (const match of text.matchAll(/\b(?:export\s+)?class\s+([A-Za-z_]\w*)/g)) graph.signatures.push(`${rel}:class ${match[1]}`);
    for (const match of text.matchAll(/\bimport\s+.*?\s+from\s+["']([^"']+)["']/g)) graph.imports.push({ file: rel, importPath: match[1] });
    if (isPython) {
      for (const match of text.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) graph.imports.push({ file: rel, importPath: match[1] });
      for (const match of text.matchAll(/^\s*import\s+([\w.]+)/gm)) graph.imports.push({ file: rel, importPath: match[1] });
    }
    if (/registerCommand\(/.test(text)) graph.commandRegistrations.push(rel);
    if (/registerTool\(/.test(text)) graph.toolRegistrations.push(rel);
    for (const match of text.matchAll(/\b([a-zA-Z]\w+)\??:\s*(?:boolean|string|number)/g)) graph.configKeys.push(`${rel}:${match[1]}`);
    if (/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(rel)) graph.tests.push(rel);
    graph.verificationCommands.push(...verificationHints(rel, text, cachedCommands));
  }
  graph.testMappings.push(...mapTestsToFiles(usableFiles));
  graph.testMappings.push(...discoverCoLocatedTests(repoRoot, usableFiles));
  graph.relatedFiles.push(...relatedFiles(usableFiles));
  return graph;
}

export function queryConstraintFacts(graph: RepoConstraintGraph, file: string): string[] {
  return [
    graph.commandRegistrations.includes(file) ? `${file} registers commands` : "",
    graph.toolRegistrations.includes(file) ? `${file} registers tools` : "",
    ...graph.testMappings.filter((item) => item.file === file).map((item) => `${item.testFile} likely tests ${file}`).slice(0, 5),
    ...graph.relatedFiles.filter((item) => item.file === file).map((item) => `${item.relatedFile} is related: ${item.reason}`).slice(0, 5),
    ...graph.verificationCommands.filter((item) => item.file === file).map((item) => `${item.command} verifies ${item.reason}`).slice(0, 5),
    ...graph.exports.filter((item) => item.startsWith(`${file}:`)).map((item) => `${item} is exported`).slice(0, 5),
    ...graph.signatures.filter((item) => item.startsWith(`${file}:`)).map((item) => `${item} signature`).slice(0, 5),
    ...graph.imports.filter((item) => item.file === file).map((item) => `${file} imports ${item.importPath}`).slice(0, 5),
    ...graph.symbols.filter((item) => item.startsWith(`${file}:`)).slice(0, 5)
  ].filter(Boolean);
}

function mapTestsToFiles(files: string[]): Array<{ file: string; testFile: string }> {
  const tests = files.filter(isTestFile);
  const nonTests = files.filter((file) => !isTestFile(file));
  const mappings: Array<{ file: string; testFile: string }> = [];
  for (const file of nonTests) {
    const stem = stemName(file);
    for (const testFile of tests) {
      if (stem && stemName(testFile).includes(stem)) mappings.push({ file, testFile });
    }
  }
  return uniqueBy(mappings, (item) => `${item.file}:${item.testFile}`);
}

function discoverCoLocatedTests(repoRoot: string, files: string[]): Array<{ file: string; testFile: string }> {
  const mappings: Array<{ file: string; testFile: string }> = [];
  for (const file of files) {
    if (isTestFile(file)) continue;
    if (!/\.(ts|tsx|js|jsx|py)$/i.test(file)) continue;
    const stem = stemName(file);
    if (!stem) continue;
    for (const candidate of coLocatedTestCandidates(file, stem)) {
      if (existsSync(join(repoRoot, candidate))) {
        mappings.push({ file, testFile: candidate.replace(/\\/g, "/") });
      }
    }
  }
  return uniqueBy(mappings, (item) => `${item.file}:${item.testFile}`).slice(0, 60);
}

function coLocatedTestCandidates(file: string, stem: string): string[] {
  const isPython = /\.py$/i.test(file);
  const dir = dirname(file);
  const base = basename(file).replace(/\.[^.]+$/, "");
  if (isPython) {
    return [
      join(dir, `test_${base}.py`),
      join(dir, `${base}_test.py`),
      join("tests", `test_${base}.py`),
      join("test", `test_${base}.py`),
      join("tests", `${base}_test.py`)
    ];
  }
  const ext = /\.(tsx|jsx)$/i.test(file) ? file.slice(file.lastIndexOf(".")) : ".ts";
  return [
    join(dir, `${base}.test${ext}`),
    join(dir, `${base}.spec${ext}`),
    join("test", `${base}.test${ext}`),
    join("tests", `${base}.test${ext}`),
    join("__tests__", `${base}.test${ext}`),
    join("src", "__tests__", `${base}.test${ext}`)
  ];
}

function relatedFiles(files: string[]): Array<{ file: string; relatedFile: string; reason: string }> {
  const relations: Array<{ file: string; relatedFile: string; reason: string }> = [];
  for (const file of files) {
    for (const other of files) {
      if (file === other) continue;
      if (dirname(file) === dirname(other)) relations.push({ file, relatedFile: other, reason: "same directory" });
      else if (stemName(file) && stemName(file) === stemName(other)) relations.push({ file, relatedFile: other, reason: "matching basename" });
    }
  }
  return uniqueBy(relations, (item) => `${item.file}:${item.relatedFile}:${item.reason}`).slice(0, 40);
}

function verificationHints(file: string, text: string, cmds: ReturnType<typeof detectProjectCommands>): Array<{ file: string; command: string; reason: string }> {
  const hints: Array<{ file: string; command: string; reason: string }> = [];
  const testCmd = cmds.testCommand ?? "npm test";
  const buildCmd = cmds.buildCommand ?? "npm run build";
  if (isTestFile(file)) hints.push({ file, command: testCmd, reason: "test file changed" });
  if (/registerCommand\(/.test(text)) hints.push({ file, command: `${testCmd} -- --test-name-pattern=command`, reason: "command registry behavior" });
  if (/registerTool\(/.test(text)) hints.push({ file, command: `${testCmd} -- --test-name-pattern=tool`, reason: "tool schema/registry behavior" });
  if (/\bexport\s+interface\s+CheaterConfig\b|\bDEFAULT_CONFIG\b|\bDEFAULT_.*CONFIG\b/.test(text)) hints.push({ file, command: `${testCmd} -- --test-name-pattern=config`, reason: "config/startup defaults" });
  if (/\.(ts|tsx)$/.test(file)) hints.push({ file, command: buildCmd, reason: "TypeScript signature/import coherence" });
  if (/\.(py)$/.test(file)) hints.push({ file, command: cmds.testCommand ?? "pytest -q", reason: "Python behavior/import coherence" });
  return uniqueBy(hints, (item) => `${item.file}:${item.command}:${item.reason}`);
}

function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(file);
}

function stemName(file: string): string {
  return basename(file).replace(/\.(test|spec)\.[jt]sx?$/i, "").replace(/\.[^.]+$/, "").toLowerCase();
}

function compactSignature(params: string): string {
  return params.replace(/\s+/g, " ").trim().slice(0, 120);
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function collectPlannerFiles(repoRoot: string, orientation: RepoOrientation): string[] {
  const files = new Set<string>();
  for (const path of [...orientation.importantPaths, ...orientation.entrypoints]) {
    const normalized = normalizeRel(path);
    if (!normalized) continue;
    const abs = join(repoRoot, normalized);
    if (existsSync(abs) && statSync(abs).isFile() && PLANNER_SCAN_EXTENSIONS.test(normalized)) files.add(normalized);
  }
  for (const dir of PLANNER_SCAN_DIRS) {
    shallowCollect(repoRoot, dir, files);
    if (files.size >= PLANNER_MAX_FILES) break;
  }
  return [...files].slice(0, PLANNER_MAX_FILES);
}

function shallowCollect(repoRoot: string, relDir: string, into: Set<string>): void {
  const absDir = join(repoRoot, relDir);
  if (!existsSync(absDir)) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  if (entries.length > PLANNER_DIR_ENTRY_LIMIT) {
    for (const entry of entries.slice(0, PLANNER_MAX_PER_DIR)) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build") continue;
      const childRel = normalizeRel(join(relDir, entry));
      if (PLANNER_SCAN_EXTENSIONS.test(childRel) && into.size < PLANNER_MAX_FILES) into.add(childRel);
    }
    return;
  }
  let collected = 0;
  const walk = (dirAbs: string, dirRel: string): void => {
    if (collected >= PLANNER_MAX_PER_DIR) return;
    let dirEntries: string[] = [];
    try {
      dirEntries = readdirSync(dirAbs);
    } catch {
      return;
    }
    if (dirEntries.length > PLANNER_DIR_ENTRY_LIMIT) return;
    for (const entry of dirEntries) {
      if (collected >= PLANNER_MAX_PER_DIR) return;
      if (entry === "node_modules" || entry === "dist" || entry === "build" || entry.startsWith(".")) continue;
      const childAbs = join(dirAbs, entry);
      const childRel = normalizeRel(join(dirRel, entry));
      let st;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(childAbs, childRel);
      } else if (st.isFile() && PLANNER_SCAN_EXTENSIONS.test(childRel) && into.size < PLANNER_MAX_FILES) {
        into.add(childRel);
        collected++;
      }
    }
  };
  walk(absDir, relDir);
}

export function buildPlannerGraph(repoRoot: string, orientation: RepoOrientation): RepoConstraintGraph {
  const files = collectPlannerFiles(repoRoot, orientation);
  return buildRepoConstraintGraph(repoRoot, files);
}

const EMPTY_ORIENTATION_FIELDS = { languages: [], frameworks: [], testCommands: [], typecheckCommands: [], entrypoints: [], importantPaths: [] };

/**
 * Pick one real, existing file to edit for a goal by scanning the repo's own source (up to
 * PLANNER_MAX_FILES files under common source dirs) and matching goal terms against actual
 * symbols/exports/registrations. Returns null when nothing matches - an honest "inspect
 * first" is better than a wrong guess. This replaces literal-filename guessing
 * ("src/commands.ts", "src/config.ts") that only happened to work for Cheater's own repo and
 * produced nothing for every other project.
 */
export function selectSingleFileForGoal(repoRoot: string, goal: string): string | null {
  try {
    const files = collectPlannerFiles(repoRoot, { repoRoot, ...EMPTY_ORIENTATION_FIELDS });
    if (!files.length) return null;
    const graph = buildRepoConstraintGraph(repoRoot, files);
    const target = selectFilesByGoalFromGraph(goal, graph, { includeTests: false, includeRelated: false }).find((t) => t.role === "touch");
    return target?.path ?? null;
  } catch {
    return null;
  }
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export interface GraphFileTarget {
  path: string;
  reason: string;
  evidence: string[];
  role: "touch" | "inspect";
  symbols?: string[];
}

export interface SymbolCluster {
  file: string;
  symbols: string[];
  reason: string;
}

export function selectFilesByGoalFromGraph(goal: string, graph: RepoConstraintGraph, options?: { includeTests?: boolean; includeRelated?: boolean }): GraphFileTarget[] {
  const lower = goal.toLowerCase();
  const terms = Array.from(new Set(lower.split(/\W+/).filter((t) => t.length > 2)));
  const includeTests = options?.includeTests ?? true;
  const includeRelated = options?.includeRelated ?? true;
  const targets: GraphFileTarget[] = [];
  const seen = new Set<string>();
  const add = (path: string, reason: string, evidence: string, role: "touch" | "inspect", symbols?: string[]) => {
    const rel = normalizeRel(path);
    if (!rel || seen.has(rel) || rel.endsWith("/") || rel.startsWith("(")) return;
    seen.add(rel);
    targets.push({ path: rel, reason, evidence: [evidence], role, symbols });
  };

  if (/\b(command|slash|cli|registercommand)\b/.test(lower)) {
    for (const file of graph.commandRegistrations) add(file, "command registration", "registerCommand call found in file", "touch");
  }
  if (/\b(tool|schema|registertool)\b/.test(lower)) {
    for (const file of graph.toolRegistrations) add(file, "tool registration", "registerTool call found in file", "touch");
  }
  if (/\b(config|setting|defaults?|option)\b/.test(lower)) {
    const configFiles = new Set(graph.configKeys.map((item) => item.split(":")[0]));
    for (const file of configFiles) add(file, "config definition", "typed config key defined in file", "touch");
  }
  for (const entry of graph.symbols) {
    const [file, name] = entry.split(":");
    if (!file || !name) continue;
    if (terms.some((term) => name.toLowerCase().includes(term) || term === name.toLowerCase())) {
      add(file, `defines symbol "${name}" mentioned by goal`, `symbol ${name} matches goal term`, "touch", [name]);
    }
  }
  for (const entry of graph.exports) {
    const [file, name] = entry.split(":");
    if (!file || !name) continue;
    if (terms.includes(name.toLowerCase())) {
      add(file, `exports "${name}"`, `exported symbol matches goal`, "touch", [name]);
    }
  }
  if (includeTests) {
    for (const mapping of graph.testMappings) {
      if (targets.some((target) => target.path === mapping.file) && !seen.has(mapping.testFile)) {
        add(mapping.testFile, `likely test for ${mapping.file}`, `co-located test discovery`, "inspect");
      }
    }
  }
  if (includeRelated) {
    for (const relation of graph.relatedFiles) {
      if (targets.some((target) => target.path === relation.relatedFile) && !seen.has(relation.file)) {
        add(relation.file, `related to target (${relation.reason})`, `related file: ${relation.reason}`, "inspect");
      }
    }
  }
  return targets.slice(0, 8);
}

export function symbolClustersForGoal(goal: string, graph: RepoConstraintGraph): SymbolCluster[] {
  const lower = goal.toLowerCase();
  const terms = Array.from(new Set(lower.split(/\W+/).filter((t) => t.length > 2)));
  const byFile = new Map<string, Set<string>>();
  const addSymbol = (file: string, name: string) => {
    const set = byFile.get(file) ?? new Set<string>();
    set.add(name);
    byFile.set(file, set);
  };
  for (const entry of graph.symbols) {
    const [file, name] = entry.split(":");
    if (!file || !name) continue;
    if (terms.some((term) => name.toLowerCase().includes(term) || term === name.toLowerCase())) addSymbol(file, name);
  }
  for (const entry of graph.exports) {
    const [file, name] = entry.split(":");
    if (!file || !name) continue;
    if (terms.includes(name.toLowerCase())) addSymbol(file, name);
  }
  const clusters: SymbolCluster[] = [];
  for (const [file, symbols] of byFile) {
    clusters.push({ file, symbols: [...symbols].slice(0, 6), reason: `symbols mentioned by goal: ${[...symbols].slice(0, 4).join(", ")}` });
  }
  return clusters.slice(0, 6);
}
