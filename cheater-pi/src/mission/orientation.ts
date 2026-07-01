import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectFacts } from "./types.js";

const CACHE_FILENAME = "orientation.json";

const PYPROJECT_TEST_HINTS: Array<[RegExp, string]> = [
  [/pytest/i, "pytest -q"],
  [/unittest/i, "python -m unittest"],
  [/tox/i, "tox -e py"]
];

const PACKAGE_TEST_SCRIPTS: Array<[RegExp, string]> = [
  [/^test:unit$/i, "npm run test:unit"],
  [/^test$/i, "npm test"]
];

const DO_NOT_TOUCH = [
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt"
];

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "CONVENTIONS.md"];

export function orientationPath(cwd: string): string {
  const candidates = [join(cwd, ".cheater", CACHE_FILENAME), join(cwd, ".pi", "cheater", CACHE_FILENAME)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(cwd, ".cheater", CACHE_FILENAME);
}

export function scanOrientation(cwd: string): ProjectFacts {
  const now = new Date().toISOString();
  const facts: ProjectFacts = {
    repoRoot: cwd,
    languages: [],
    frameworks: [],
    packageManagers: [],
    testCommands: [],
    lintCommands: [],
    typecheckCommands: [],
    importantPaths: [],
    doNotTouch: [...DO_NOT_TOUCH],
    entrypoints: [],
    commonFailurePatterns: [],
    lastUpdated: now,
    confidence: {}
  };

  const has = (rel: string) => existsSync(join(cwd, rel));
  const tryRead = (rel: string): string | undefined => {
    const path = join(cwd, rel);
    if (!existsSync(path)) return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };

  if (has("package.json")) {
    facts.languages.push("javascript");
    facts.packageManagers.push(has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm");
    facts.importantPaths.push("package.json");
    facts.confidence["packageManager"] = 0.9;
    const pkg = safeJson(tryRead("package.json"));
    if (pkg) {
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      for (const [regex, cmd] of PACKAGE_TEST_SCRIPTS) {
        if (Object.keys(scripts).some((key) => regex.test(key))) {
          facts.testCommands.push(cmd);
          facts.confidence["testCommand"] = 0.85;
        }
      }
      if (scripts.lint) facts.lintCommands.push("npm run lint");
      if (scripts.typecheck) facts.typecheckCommands.push("npm run typecheck");
      if (scripts.build) facts.typecheckCommands.push("npm run build");
      detectFrameworks(pkg, facts);
    }
  }

  if (has("tsconfig.json")) {
    facts.languages.push("typescript");
    facts.importantPaths.push("tsconfig.json");
    if (!facts.typecheckCommands.includes("npx tsc --noEmit")) {
      facts.typecheckCommands.push("npx tsc --noEmit");
    }
    facts.confidence["typecheck"] = 0.7;
  }

  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    facts.languages.push("python");
    if (has("requirements.txt")) facts.packageManagers.push("pip");
    if (has("pyproject.toml")) {
      const content = tryRead("pyproject.toml") ?? "";
      if (/poetry/i.test(content)) facts.packageManagers.push("poetry");
      if (/uv\b/i.test(content)) facts.packageManagers.push("uv");
      for (const [pattern, cmd] of PYPROJECT_TEST_HINTS) {
        if (pattern.test(content)) {
          if (!facts.testCommands.includes(cmd)) facts.testCommands.push(cmd);
        }
      }
    }
    facts.importantPaths.push(has("pyproject.toml") ? "pyproject.toml" : has("requirements.txt") ? "requirements.txt" : "setup.py");
    facts.confidence["testCommand"] = facts.testCommands.length > 0 ? 0.85 : 0.5;
  }

  if (has("pytest.ini") || has("tests/") || has("test/")) {
    if (!facts.testCommands.includes("pytest -q")) facts.testCommands.push("pytest -q");
    facts.importantPaths.push(has("tests/") ? "tests/" : "test/");
  }

  for (const instruction of INSTRUCTION_FILES) {
    if (has(instruction)) facts.importantPaths.push(instruction);
  }

  if (has("vite.config.ts") || has("vite.config.js")) {
    facts.frameworks.push("vite");
  }
  if (has("next.config.js") || has("next.config.mjs") || has("next.config.ts")) {
    facts.frameworks.push("next");
  }

  for (const entry of ["src/", "app/", "lib/", "templates/", "static/", "public/", "index.html", "index.ts", "index.js", "main.py"]) {
    if (has(entry)) facts.entrypoints.push(entry);
  }

  for (const path of [
    "templates/base.html",
    "templates/index.html",
    "static/style.css",
    "static/css/style.css",
    "src/App.tsx",
    "src/App.jsx",
    "src/App.vue",
    "src/main.tsx",
    "src/main.jsx"
  ]) {
    if (has(path)) facts.importantPaths.push(path);
  }

  facts.languages = [...new Set(facts.languages)];
  facts.packageManagers = [...new Set(facts.packageManagers)];
  facts.testCommands = [...new Set(facts.testCommands)];
  facts.lintCommands = [...new Set(facts.lintCommands)];
  facts.typecheckCommands = [...new Set(facts.typecheckCommands)];
  facts.frameworks = [...new Set(facts.frameworks)];
  facts.entrypoints = [...new Set(facts.entrypoints)];
  facts.importantPaths = [...new Set(facts.importantPaths)];

  return facts;
}

function safeJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function detectFrameworks(pkg: Record<string, unknown>, facts: ProjectFacts): void {
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined ?? {}), ...(pkg.devDependencies as Record<string, string> | undefined ?? {}) };
  const seen = new Set<string>();
  for (const dep of Object.keys(deps)) {
    if (seen.has(dep)) continue;
    if (dep === "react" || dep.startsWith("@types/react")) {
      facts.frameworks.push("react");
      seen.add(dep);
    } else if (dep === "vue") {
      facts.frameworks.push("vue");
      seen.add(dep);
    } else if (dep === "svelte") {
      facts.frameworks.push("svelte");
      seen.add(dep);
    } else if (dep === "express") {
      facts.frameworks.push("express");
      seen.add(dep);
    } else if (dep === "fastify") {
      facts.frameworks.push("fastify");
      seen.add(dep);
    }
  }
}

export function loadOrientation(cwd: string): ProjectFacts | undefined {
  const path = orientationPath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text) as ProjectFacts;
  } catch {
    return undefined;
  }
}

export function saveOrientation(cwd: string, facts: ProjectFacts): string {
  const target = join(cwd, ".cheater", CACHE_FILENAME);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(facts, null, 2), "utf8");
  return target;
}

export function orientationAgeDays(facts: ProjectFacts): number {
  const last = Date.parse(facts.lastUpdated);
  if (Number.isNaN(last)) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - last) / 86400000);
}

export function orientationIsFresh(facts: ProjectFacts, maxAgeDays = 7): boolean {
  return orientationAgeDays(facts) <= maxAgeDays;
}

export function detectKeyFileTouched(cwd: string, file: string): boolean {
  if (DO_NOT_TOUCH.includes(file)) return true;
  const rel = file.split(/[\\/]/).pop() ?? file;
  if (rel === "package-lock.json" || rel === "pnpm-lock.yaml" || rel === "yarn.lock") return true;
  if (rel === "requirements.txt" || rel === "pyproject.toml") return true;
  if (/(^|[\\/])tests?([\\/]|$)/.test(file)) return true;
  return false;
}

export function pickFocusedTestCommand(facts: ProjectFacts): string | undefined {
  return facts.testCommands[0];
}

export function statFileSafe(path: string): { size: number; mtimeMs: number } | undefined {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}
