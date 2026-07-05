import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ProjectCommands {
  testCommand: string | null;
  focusedTestCommand: string | null;
  typecheckCommand: string | null;
  lintCommand: string | null;
  buildCommand: string | null;
  devCommand: string | null;
  scoreCommand: string | null;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "pip" | "uv" | "cargo" | "go" | "none";
  framework: string | null;
  evidence: string[];
}

const EMPTY: ProjectCommands = {
  testCommand: null,
  focusedTestCommand: null,
  typecheckCommand: null,
  lintCommand: null,
  buildCommand: null,
  devCommand: null,
  scoreCommand: null,
  packageManager: "none",
  framework: null,
  evidence: []
};

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseTomlLike(text: string): { sections: Record<string, Record<string, string[]>>; raw: string } {
  const sections: Record<string, Record<string, string[]>> = {};
  let current = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      sections[current] = sections[current] ?? {};
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex < 0) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    (sections[current] = sections[current] ?? {})[key] = (sections[current][key] ?? []).concat([value]);
  }
  return { sections, raw: text };
}

export function detectProjectCommands(cwd: string): ProjectCommands {
  const root = resolve(cwd);
  const evidence: string[] = [];
  const result: ProjectCommands = { ...EMPTY, evidence };

  const hasPnpmLock = existsSync(join(root, "pnpm-lock.yaml"));
  const hasYarnLock = existsSync(join(root, "yarn.lock"));
  const hasBunLock = existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"));
  const hasPackageLock = existsSync(join(root, "package-lock.json"));
  const packageJsonPath = join(root, "package.json");
  const pkg = existsSync(packageJsonPath) ? readJson(packageJsonPath) : null;

  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const pm = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : hasBunLock ? "bun" : "npm";
    result.packageManager = pm as ProjectCommands["packageManager"];
    evidence.push(`package.json scripts: ${Object.keys(scripts).join(", ") || "(none)"}`);
    const run = (name: string) => `${pm} run ${name}`;
    // Direct binary invocation for a framework with no matching script. `npx` resolves
    // node_modules/.bin on every package manager; pnpm/bun have leaner equivalents.
    const bin = (name: string) => pm === "pnpm" ? `pnpm exec ${name}` : pm === "bun" ? `bun x ${name}` : `npx ${name}`;
    const hasTestScript = Boolean(scripts.test) && !/no test specified|^echo/.test(scripts.test);
    const testScript = scripts.test;
    if (testScript && !/no test specified|^echo/.test(testScript)) {
      result.testCommand = `${pm} ${pm === "npm" ? "test" : "test"}`;
      evidence.push(`test script: ${testScript}`);
    }
    if (scripts["test:unit"]) result.focusedTestCommand = run("test:unit");
    else if (scripts["test:focused"]) result.focusedTestCommand = run("test:focused");
    else if (scripts["test:watch"]) result.focusedTestCommand = run("test:watch");
    if (scripts.typecheck) result.typecheckCommand = run("typecheck");
    if (scripts.tsc) result.typecheckCommand ??= run("tsc");
    if (scripts.lint) result.lintCommand = run("lint");
    if (scripts.build) result.buildCommand = run("build");
    if (scripts.dev) result.devCommand = run("dev");
    else if (scripts.start) result.devCommand = run("start");
    else if (scripts.serve) result.devCommand = run("serve");
    else if (scripts.preview) result.devCommand = run("preview");
    if (scripts.score) result.scoreCommand = run("score");
    else if (scripts["test:score"]) result.scoreCommand = run("test:score");

    const devDeps = Object.keys((pkg.devDependencies ?? {}) as Record<string, string>);
    const allDeps = [...Object.keys((pkg.dependencies ?? {}) as Record<string, string>), ...devDeps];
    if (allDeps.includes("vitest")) {
      result.framework = "vitest";
      result.testCommand = hasTestScript ? `${pm} test` : bin("vitest run");
      result.focusedTestCommand = scripts["test:unit"] ? run("test:unit") : bin("vitest run");
      evidence.push("vitest detected in dependencies");
    } else if (allDeps.includes("jest")) {
      result.framework = "jest";
      result.testCommand = hasTestScript ? `${pm} test` : bin("jest");
      result.focusedTestCommand = scripts["test:unit"] ? run("test:unit") : bin("jest");
      evidence.push("jest detected in dependencies");
    } else if (allDeps.includes("@playwright/test")) {
      result.framework = "playwright";
      result.testCommand = hasTestScript ? `${pm} test` : bin("playwright test");
      result.focusedTestCommand = bin("playwright test");
      evidence.push("playwright detected in dependencies");
    } else if (allDeps.includes("mocha")) {
      result.framework = "mocha";
      result.testCommand = hasTestScript ? `${pm} test` : bin("mocha");
      evidence.push("mocha detected in dependencies");
    } else if (allDeps.includes("cypress")) {
      result.framework = "cypress";
      result.testCommand ??= hasTestScript ? `${pm} test` : bin("cypress run");
      evidence.push("cypress detected in dependencies");
    } else if (allDeps.includes("pytest") || devDeps.includes("pytest")) {
      result.framework = "pytest";
      result.testCommand ??= "pytest -q";
      evidence.push("pytest detected in package.json devDependencies");
    }

    if (allDeps.includes("next")) {
      result.devCommand ??= scripts.dev ? run("dev") : bin("next dev");
      result.buildCommand ??= scripts.build ? run("build") : bin("next build");
      evidence.push("next.js detected");
    } else if (allDeps.includes("vite")) {
      result.devCommand ??= scripts.dev ? run("dev") : bin("vite");
      evidence.push("vite detected");
    }
  }

  const pyprojectPath = join(root, "pyproject.toml");
  const setupCfgPath = join(root, "setup.cfg");
  const pytestIniPath = join(root, "pytest.ini");
  const toxIniPath = join(root, "tox.ini");
  const hasPyproject = existsSync(pyprojectPath);
  const hasPytestIni = existsSync(pytestIniPath);

  if (hasPyproject) {
    const text = readText(pyprojectPath) ?? "";
    const { sections } = parseTomlLike(text);
    evidence.push("pyproject.toml found");
    if (result.packageManager === "none") result.packageManager = existsSync(join(root, "uv.lock")) ? "uv" : "pip";
    const pytestOpts = sections["tool.pytest.ini_options"];
    if (pytestOpts || hasPytestIni) {
      result.framework ??= "pytest";
      result.testCommand ??= "pytest -q";
      evidence.push("pytest config in pyproject.toml/pytest.ini");
    }
    if (sections["tool.poetry"]) {
      result.packageManager = "pip";
      result.testCommand ??= "poetry run pytest -q";
      evidence.push("poetry detected");
    }
    if (sections["tool.uv"]) {
      result.packageManager = "uv";
      result.testCommand ??= "uv run pytest -q";
      evidence.push("uv detected");
    }
    const optionalDeps = (sections["project"]?.["dependencies"] ?? []).join(" ");
    const optionalDev = (sections["tool.uv"]?.["dev-dependencies"] ?? []).join(" ");
    const allPyDeps = `${optionalDeps} ${optionalDev}`;
    if (/pytest/.test(allPyDeps)) {
      result.framework ??= "pytest";
      result.testCommand ??= "pytest -q";
      evidence.push("pytest in pyproject dependencies");
    }
    if (/ruff/.test(allPyDeps)) {
      result.lintCommand ??= "ruff check .";
      evidence.push("ruff detected");
    }
    if (/mypy/.test(allPyDeps)) {
      result.typecheckCommand ??= "mypy .";
      evidence.push("mypy detected");
    }
  }

  if (hasPytestIni && !result.testCommand) {
    result.framework ??= "pytest";
    result.testCommand = "pytest -q";
    evidence.push("pytest.ini found");
  }
  if (existsSync(toxIniPath) && !result.testCommand) {
    result.testCommand = "tox -e py";
    evidence.push("tox.ini found");
  }
  if (existsSync(setupCfgPath) && !result.testCommand) {
    const text = readText(setupCfgPath) ?? "";
    if (/tool:pytest/i.test(text) || /\[pytest\]/i.test(text)) {
      result.testCommand = "pytest -q";
      evidence.push("pytest config in setup.cfg");
    }
  }
  if (existsSync(join(root, "manage.py")) && !result.testCommand) {
    result.testCommand = "python manage.py test";
    result.devCommand ??= "python manage.py runserver";
    result.framework ??= "django";
    result.packageManager = result.packageManager === "none" ? "pip" : result.packageManager;
    evidence.push("django manage.py found");
  }

  const cargoPath = join(root, "Cargo.toml");
  if (existsSync(cargoPath)) {
    const text = readText(cargoPath) ?? "";
    evidence.push("Cargo.toml found");
    result.packageManager = "cargo";
    result.framework ??= "cargo";
    result.testCommand ??= "cargo test";
    result.buildCommand ??= "cargo build";
    result.lintCommand ??= "cargo clippy";
    result.devCommand ??= "cargo run";
    if (/\[dev-dependencies\]/s.test(text) && /criterion/.test(text)) {
      result.scoreCommand ??= "cargo bench";
    }
  }

  const goModPath = join(root, "go.mod");
  if (existsSync(goModPath)) {
    evidence.push("go.mod found");
    result.packageManager = "go";
    result.framework ??= "go";
    result.testCommand ??= "go test ./...";
    result.buildCommand ??= "go build ./...";
    result.devCommand ??= "go run .";
  }

  if (existsSync(join(root, "Makefile")) && !result.testCommand) {
    const makeText = readText(join(root, "Makefile")) ?? "";
    if (/^test:/m.test(makeText)) {
      result.testCommand ??= "make test";
      evidence.push("Makefile test target found");
    }
    if (/^lint:/m.test(makeText)) result.lintCommand ??= "make lint";
    if (/^build:/m.test(makeText)) result.buildCommand ??= "make build";
  }

  if (!result.testCommand) {
    evidence.push("no project-specific test command detected");
  }
  return result;
}

// Manifests whose mtime changing means detection must re-run.
const MANIFESTS = [
  "package.json", "pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg",
  "Cargo.toml", "go.mod", "Makefile", "manage.py", "uv.lock",
  "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "package-lock.json"
];

function manifestSignature(root: string): string {
  const parts: string[] = [];
  for (const name of MANIFESTS) {
    try {
      const st = statSync(join(root, name));
      parts.push(`${name}:${Math.trunc(Number(st.mtimeMs))}`);
    } catch {
      // absent manifest contributes nothing
    }
  }
  return parts.join("|");
}

const memo = new Map<string, { sig: string; cmds: ProjectCommands }>();

interface CommandCacheFile {
  sig: string;
  cmds: ProjectCommands;
  at: number;
}

/**
 * Single project-command registry every verification consumer should read. Detection is
 * cached in-process and to `.cheater/commands.json`, keyed by a signature of manifest
 * mtimes so it re-runs only when a manifest actually changes. This replaces ad-hoc
 * `detectProjectCommands` calls and the old hardcoded `npm test` defaults.
 */
/**
 * A test file the model just wrote (test_foo.py) with NO pytest config/manifest is invisible to
 * manifest-based detection - so verification skips every test stage and "passes" on ZERO real checks,
 * leaving the model with no oracle to know when it is done (it then thrashes / never terminates). If a
 * bare pytest file exists and no test command was otherwise detected, run pytest on it so the model's
 * own test actually gates completion. Computed at read-time (not cached) because writing a test file
 * does not change the manifest signature the cache is keyed on.
 */
function augmentWithBareTests(cmds: ProjectCommands, root: string): ProjectCommands {
  if (cmds.testCommand || cmds.focusedTestCommand) return cmds;
  let hasPyTest = false;
  try {
    hasPyTest = readdirSync(root).some((f) => /^test_.+\.py$/i.test(f) || /.+_test\.py$/i.test(f));
  } catch {
    // unreadable dir - leave commands unchanged
  }
  if (!hasPyTest) return cmds;
  const cmd = "python -m pytest -q";
  return { ...cmds, testCommand: cmd, focusedTestCommand: cmd, evidence: [...cmds.evidence, "bare pytest file discovered (no manifest)"] };
}

export function loadProjectCommands(cwd: string): ProjectCommands {
  const root = resolve(cwd);
  const sig = manifestSignature(root);
  const cached = memo.get(root);
  if (cached && cached.sig === sig) return augmentWithBareTests(cached.cmds, root);

  const cacheFile = join(root, ".cheater", "commands.json");
  try {
    const disk = JSON.parse(readFileSync(cacheFile, "utf8")) as CommandCacheFile;
    if (disk && disk.sig === sig && disk.cmds) {
      memo.set(root, { sig, cmds: disk.cmds });
      return augmentWithBareTests(disk.cmds, root);
    }
  } catch {
    // no usable disk cache
  }

  const cmds = detectProjectCommands(root);
  memo.set(root, { sig, cmds });
  try {
    mkdirSync(join(root, ".cheater"), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ sig, cmds, at: Date.now() } satisfies CommandCacheFile, null, 2), "utf8");
  } catch {
    // best-effort persistence
  }
  return augmentWithBareTests(cmds, root);
}

/** Best available default verification command for a repo, or null if none was detected. */
export function defaultVerificationCommand(cwd: string): string | null {
  const cmds = loadProjectCommands(cwd);
  return cmds.focusedTestCommand ?? cmds.testCommand ?? null;
}

export function focusTestCommand(cwd: string, hint?: string): string {
  const cmds = loadProjectCommands(cwd);
  const base = cmds.focusedTestCommand ?? cmds.testCommand ?? inferFallbackTest(cwd);
  if (hint) return `${base} # focus: ${hint}`;
  return base;
}

export function inferFallbackTest(cwd: string): string {
  const root = resolve(cwd);
  if (existsSync(join(root, "package.json"))) return "npm test";
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) return "pytest -q";
  if (existsSync(join(root, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(root, "go.mod"))) return "go test ./...";
  return "npm test";
}
