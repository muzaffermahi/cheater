// Post-edit import gate: deterministically catch hallucinated imports at edit time.
//
// The single most common small-model coding failure is inventing things to import: a
// relative module that does not exist, a named symbol the target file never exports, or an
// npm package that is not installed. Discovering that three tool calls later via a failed
// test burns a whole verify/repair cycle; this gate reports it in-band on the edit's own
// tool result (like the syntax gate), so the model fixes the import while the edit is still
// the freshest thing in context.
//
// Deliberately conservative: it only flags what it can prove locally (missing repo files,
// names verifiably absent from a resolved repo module, packages absent from node_modules).
// Python third-party packages are never flagged (environments are too messy to prove a
// negative); only repo-internal python imports are checked.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface ImportGateResult {
  ok: boolean;
  issues: string[];
}

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "dns", "events", "fs", "http", "http2", "https", "inspector", "module",
  "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline",
  "repl", "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm",
  "worker_threads", "zlib", "test"
]);

const PY_STDLIB = new Set([
  "abc", "argparse", "asyncio", "base64", "bisect", "collections", "contextlib", "copy",
  "csv", "dataclasses", "datetime", "decimal", "difflib", "email", "enum", "errno",
  "fnmatch", "fractions", "functools", "getpass", "glob", "hashlib", "heapq", "html",
  "http", "importlib", "inspect", "io", "itertools", "json", "logging", "math",
  "multiprocessing", "numbers", "operator", "os", "pathlib", "pickle", "platform",
  "queue", "random", "re", "secrets", "shutil", "signal", "socket", "sqlite3", "stat",
  "statistics", "string", "struct", "subprocess", "sys", "tempfile", "textwrap",
  "threading", "time", "traceback", "types", "typing", "unicodedata", "unittest",
  "urllib", "uuid", "warnings", "weakref", "xml", "zoneinfo"
]);

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function isJsFile(path: string): boolean {
  return /\.(m|c)?[jt]sx?$/.test(path);
}

function isPyFile(path: string): boolean {
  return path.endsWith(".py");
}

/** Resolve a relative JS/TS import spec against the importing file. Returns the resolved repo file or null. */
function resolveJsRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates: string[] = [base];
  // TS ESM convention: "./x.js" in source resolves to "./x.ts"/"./x.tsx" at compile time.
  if (/\.(m|c)?js$/.test(base)) {
    candidates.push(base.replace(/\.(m|c)?js$/, ".ts"), base.replace(/\.(m|c)?js$/, ".tsx"));
  }
  for (const ext of JS_EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of JS_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** True when the exported name is verifiably present in the target module's source. */
function jsModuleExports(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${escaped}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b`),
    new RegExp(`export\\s+default\\s+(?:function|class)?\\s*${escaped}\\b`),
    new RegExp(`(?:module\\.)?exports\\.${escaped}\\s*=`),
    new RegExp(`module\\.exports\\s*=\\s*\\{[^}]*\\b${escaped}\\b`),
    /export\s+\*\s+from/ // re-export barrel: cannot prove absence, so treat as present
  ].some((re) => re.test(content));
}

/** Package name from a bare spec: "react/jsx-runtime" -> "react", "@scope/pkg/sub" -> "@scope/pkg". */
function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Walk up from the importing file to the repo root looking for node_modules/<pkg>. */
function packageInstalled(cwd: string, fromFile: string, pkg: string): boolean {
  let dir = dirname(fromFile);
  const root = resolve(cwd);
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "node_modules", pkg))) return true;
    if (resolve(dir) === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Declared dependencies count even before an install has run.
  try {
    const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (pkgJson[key]?.[pkg] !== undefined) return true;
    }
  } catch {
    // no root package.json - a bare import in a non-node repo is suspicious enough to flag
  }
  return false;
}

interface JsImport {
  spec: string;
  names: string[];
}

function parseJsImports(content: string): JsImport[] {
  const imports: JsImport[] = [];
  // import defaultName, { a, b as c } from "spec"  |  import "spec"  |  export ... from "spec"
  const importRe = /(?:^|\n)\s*(?:import|export)\s+(?:([\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*|[\w$*\s,]+\s+from\s*|)["']([^"'\n]+)["']/g;
  for (const m of content.matchAll(importRe)) {
    const names = (m[2] ?? "")
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
      .filter((name) => name && name !== "type" && !name.startsWith("type "));
    imports.push({ spec: m[3], names });
  }
  for (const m of content.matchAll(/require\(\s*["']([^"'\n]+)["']\s*\)/g)) {
    imports.push({ spec: m[1], names: [] });
  }
  return imports;
}

function checkJsImports(cwd: string, filePath: string, content: string): string[] {
  const issues: string[] = [];
  for (const imp of parseJsImports(content)) {
    const spec = imp.spec;
    if (spec.startsWith(".")) {
      const resolved = resolveJsRelative(filePath, spec);
      if (!resolved) {
        issues.push(`import "${spec}" does not resolve to any file. -> Fix the path or create the module before using it.`);
        continue;
      }
      if (imp.names.length) {
        let target = "";
        try { target = readFileSync(resolved, "utf8"); } catch { continue; }
        for (const name of imp.names) {
          if (!jsModuleExports(target, name)) {
            issues.push(`"${name}" is not exported by ${spec}. -> Check the target file for the real export name.`);
          }
        }
      }
    } else if (!spec.startsWith("node:")) {
      const pkg = packageName(spec);
      if (!NODE_BUILTINS.has(pkg) && !packageInstalled(cwd, filePath, pkg)) {
        issues.push(`package "${pkg}" is not installed and not declared in package.json. -> Use an installed package or ask the user before adding a dependency.`);
      }
    }
  }
  return issues;
}

/** Resolve a python module path relative to a base dir: "a.b" -> a/b.py or a/b/__init__.py. */
function resolvePyModule(baseDir: string, dotted: string): boolean {
  const rel = dotted.split(".").join(sep);
  return existsSync(join(baseDir, `${rel}.py`)) || existsSync(join(baseDir, rel, "__init__.py"));
}

function pyModuleDefines(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`^\\s*(?:def|class)\\s+${escaped}\\b`, "m"),
    new RegExp(`^${escaped}\\s*[:=]`, "m"),
    new RegExp(`__all__[^\\n]*["']${escaped}["']`)
  ].some((re) => re.test(content));
}

/**
 * Check one dotted absolute import path ("src.mathutils") against the repo root and the
 * conventional src/ layout. Only reports when the top-level segment is provably repo-owned
 * (a real file or directory here) - third-party packages cannot be proven absent this way,
 * so they are silently skipped rather than false-flagged.
 */
function checkAbsoluteModule(root: string, module: string, issues: string[]): void {
  const top = module.split(".")[0];
  // A top-level segment counts as repo-internal if it is a real single-file module OR an
  // existing directory - Python 3 namespace packages (a directory with no __init__.py) are
  // valid, so requiring __init__.py here would miss the common "src/" layout entirely.
  const isRepoInternalTop = (base: string) => existsSync(join(base, `${top}.py`)) || existsSync(join(base, top));
  const repoInternal = isRepoInternalTop(root) || isRepoInternalTop(join(root, "src"));
  if (!repoInternal || PY_STDLIB.has(top)) return;
  const bases = [root, join(root, "src")];
  if (!bases.some((base) => resolvePyModule(base, module))) {
    issues.push(`import path "${module}" does not resolve inside this repo. -> Fix the module path.`);
  }
}

function checkPyImports(cwd: string, filePath: string, content: string): string[] {
  const issues: string[] = [];
  const fileDir = dirname(filePath);
  const root = resolve(cwd);

  for (const m of content.matchAll(/^\s*from\s+(\.+)?([\w.]*)\s+import\s+([^\n(]+)/gm)) {
    const dots = m[1] ?? "";
    const module = m[2] ?? "";
    const names = m[3].split(",").map((part) => part.trim().split(/\s+as\s+/)[0].trim()).filter((n) => n && n !== "*");
    if (dots) {
      // Relative import: walk up (dots.length - 1) package levels from the file's dir.
      let base = fileDir;
      for (let i = 1; i < dots.length; i += 1) base = dirname(base);
      if (module && !resolvePyModule(base, module)) {
        issues.push(`from ${dots}${module} import ... does not resolve inside the package. -> Fix the relative path.`);
        continue;
      }
      if (module && names.length) {
        const modFile = existsSync(join(base, `${module.split(".").join(sep)}.py`))
          ? join(base, `${module.split(".").join(sep)}.py`)
          : join(base, module.split(".").join(sep), "__init__.py");
        try {
          const target = readFileSync(modFile, "utf8");
          for (const name of names) {
            if (!pyModuleDefines(target, name)) {
              issues.push(`"${name}" is not defined in ${dots}${module}. -> Check the module for the real name.`);
            }
          }
        } catch { /* unreadable: stay silent */ }
      }
    } else if (module) {
      checkAbsoluteModule(root, module, issues);
    }
  }

  // Bare "import a.b, c" statements (as opposed to "from a.b import c") were previously
  // never checked at all.
  for (const m of content.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) {
    for (const module of m[1].split(",").map((part) => part.trim()).filter(Boolean)) {
      checkAbsoluteModule(root, module, issues);
    }
  }
  return issues;
}

/**
 * Check the imports of a just-edited file. Returns ok=true (no issues) for file types it
 * does not understand. Bounded to 4 issues so the in-band notice stays small.
 */
export function checkImports(cwd: string, relPath: string): ImportGateResult {
  const abs = resolve(cwd, relPath);
  if (!existsSync(abs)) return { ok: true, issues: [] };
  let content = "";
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return { ok: true, issues: [] };
  }
  let issues: string[] = [];
  if (isJsFile(relPath)) issues = checkJsImports(cwd, abs, content);
  else if (isPyFile(relPath)) issues = checkPyImports(cwd, abs, content);
  return { ok: issues.length === 0, issues: issues.slice(0, 4) };
}
