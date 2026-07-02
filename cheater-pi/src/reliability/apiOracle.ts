// Installed-API oracle: ground truth about library APIs from THIS environment.
//
// When a failure names a library symbol ("'Response' object has no attribute 'get_json'",
// "pkg.greet is not a function", "has no exported member 'X'"), the strongest possible
// evidence is not a doc page or a web post - it is what the INSTALLED version of that
// package actually exposes. This module reads it directly: node_modules type declarations
// for JS/TS, a bounded `python -c "import inspect, ..."` probe for Python. Unlike web
// evidence, the extracted signature is a fact about the local environment; only its
// relevance to the fix remains a hypothesis.
//
// Deliberately reactive and bounded: it runs only when the Cheat Layer classified a
// library_api_error / import_error, never as a gate (so an exotic package layout can not
// false-block anything), and each probe is capped in bytes and wall-clock.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ApiOracleResult {
  language: "js" | "python";
  packageName: string;
  version?: string;
  symbol?: string;
  /** The probe ran and the package is importable/resolvable. */
  installed: boolean;
  /** The requested symbol exists (only meaningful when a symbol was requested). */
  symbolFound: boolean;
  /** Actual declaration/signature lines for the symbol (bounded). */
  declarations: string[];
  /** Actual exported names, shown when the symbol is missing or none was requested (bounded). */
  availableExports: string[];
}

const MAX_DECLARATIONS = 4;
const MAX_EXPORTS = 18;
const MAX_DTS_BYTES = 400_000;
const PYTHON_TIMEOUT_MS = 4000;

// Interpolated into a python -c script and into regexes; keep it to identifier-shaped input.
const SAFE_NAME = /^[A-Za-z_@][\w./@-]*$/;
const SAFE_PY_NAME = /^[A-Za-z_][\w.]*$/;

function clipLine(line: string, maxChars = 200): string {
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 3)}...`;
}

/** Walk up from cwd to find node_modules/<pkg>; returns the package dir or null. */
function findNodePackageDir(cwd: string, pkg: string): string | null {
  let dir = resolve(cwd);
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, "node_modules", pkg);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Pick the package's type-declaration entry (types/typings field, exports map, or conventions). */
function resolveTypesFile(pkgDir: string, meta: Record<string, any>): string | null {
  const candidates: string[] = [];
  if (typeof meta.types === "string") candidates.push(meta.types);
  if (typeof meta.typings === "string") candidates.push(meta.typings);
  const rootExport = meta.exports?.["."];
  if (rootExport && typeof rootExport === "object") {
    if (typeof rootExport.types === "string") candidates.push(rootExport.types);
    if (typeof rootExport.import === "object" && typeof rootExport.import.types === "string") candidates.push(rootExport.import.types);
  }
  candidates.push("index.d.ts", "dist/index.d.ts", "lib/index.d.ts", "types/index.d.ts");
  for (const rel of candidates) {
    const abs = join(pkgDir, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** Declaration lines in a .d.ts that define the symbol (function/const/class/interface/type or member). */
export function extractDeclarations(dtsText: string, symbol: string): string[] {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^.*\\b(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${escaped}\\b.*$`, "gm"),
    // interface/class member: "    greet(name: string): string;" or "greet: (name) => ..."
    new RegExp(`^\\s*(?:readonly\\s+)?${escaped}\\s*[?]?\\s*[(:<].*$`, "gm")
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of dtsText.matchAll(pattern)) {
      const line = clipLine(match[0]);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
      if (out.length >= MAX_DECLARATIONS) return out;
    }
  }
  return out;
}

/** Top-level exported names declared in a .d.ts (bounded). */
export function extractExportNames(dtsText: string): string[] {
  const names = new Set<string>();
  for (const match of dtsText.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_]\w*)/g)) {
    names.add(match[1]);
    if (names.size >= MAX_EXPORTS) break;
  }
  if (names.size < MAX_EXPORTS) {
    for (const match of dtsText.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
      for (const part of match[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Za-z_]\w*$/.test(name)) names.add(name);
        if (names.size >= MAX_EXPORTS) break;
      }
    }
  }
  return [...names].slice(0, MAX_EXPORTS);
}

function probeNodePackage(cwd: string, pkg: string, symbol?: string): ApiOracleResult | null {
  const pkgDir = findNodePackageDir(cwd, pkg);
  if (!pkgDir) {
    // Provable negative only in a node repo: the package is neither installed nor declared.
    const rootPkg = join(resolve(cwd), "package.json");
    if (!existsSync(rootPkg)) return null;
    try {
      const meta = JSON.parse(readFileSync(rootPkg, "utf8"));
      const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
        .some((key) => meta[key]?.[pkg] !== undefined);
      if (declared) return null; // declared but not installed: an install problem, not an API fact
    } catch {
      return null;
    }
    return { language: "js", packageName: pkg, installed: false, symbolFound: false, declarations: [], availableExports: [] };
  }
  let meta: Record<string, any> = {};
  try {
    meta = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const result: ApiOracleResult = {
    language: "js",
    packageName: pkg,
    version: typeof meta.version === "string" ? meta.version : undefined,
    symbol,
    installed: true,
    symbolFound: false,
    declarations: [],
    availableExports: []
  };
  const dtsPath = resolveTypesFile(pkgDir, meta);
  if (!dtsPath) return result;
  let text = "";
  try {
    text = readFileSync(dtsPath, "utf8").slice(0, MAX_DTS_BYTES);
  } catch {
    return result;
  }
  if (symbol) {
    result.declarations = extractDeclarations(text, symbol);
    result.symbolFound = result.declarations.length > 0;
  }
  if (!result.symbolFound) result.availableExports = extractExportNames(text);
  return result;
}

function probePythonModule(cwd: string, moduleName: string, symbol?: string): ApiOracleResult | null {
  if (!SAFE_PY_NAME.test(moduleName) || (symbol && !SAFE_PY_NAME.test(symbol))) return null;
  const script = [
    "import json, importlib, inspect",
    `out = {"version": None, "installed": False, "found": False, "declarations": [], "available": []}`,
    "try:",
    `    m = importlib.import_module(${JSON.stringify(moduleName)})`,
    `    out["installed"] = True`,
    `    out["version"] = getattr(m, "__version__", None)`,
    `    sym = ${JSON.stringify(symbol ?? "")}`,
    "    if sym and hasattr(m, sym):",
    "        obj = getattr(m, sym)",
    `        out["found"] = True`,
    "        try:",
    `            out["declarations"] = [sym + str(inspect.signature(obj))]`,
    "        except Exception:",
    `            out["declarations"] = [sym + " (callable; signature unavailable)"]`,
    "    else:",
    `        out["available"] = sorted(n for n in dir(m) if not n.startswith("_"))[:${MAX_EXPORTS}]`,
    "except ModuleNotFoundError:",
    "    pass",
    "except Exception:",
    `    out = None`,
    "print(json.dumps(out))"
  ].join("\n");
  for (const python of ["python", "python3"]) {
    let raw = "";
    try {
      const run = spawnSync(python, ["-c", script], { cwd, encoding: "utf8", timeout: PYTHON_TIMEOUT_MS, windowsHide: true });
      if (run.status !== 0 || !run.stdout) continue;
      raw = run.stdout.trim();
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null) return null;
      return {
        language: "python",
        packageName: moduleName,
        version: typeof parsed.version === "string" ? parsed.version : undefined,
        symbol,
        installed: Boolean(parsed.installed),
        symbolFound: Boolean(parsed.found),
        declarations: (parsed.declarations ?? []).slice(0, MAX_DECLARATIONS).map((line: string) => clipLine(String(line))),
        availableExports: (parsed.available ?? []).slice(0, MAX_EXPORTS).map((name: string) => String(name))
      };
    } catch {
      return null;
    }
  }
  return null; // no working python: the oracle stays silent rather than guessing
}

function looksPython(failureText: string): boolean {
  return /Traceback|ModuleNotFoundError|No module named|AttributeError|IndentationError|\.py[:\s"')]|^\s*def\s/m.test(failureText);
}

/**
 * Probe the locally installed API named by a classified failure. Tries node_modules first
 * (cheap, no subprocess); falls back to a bounded python inspect probe when the failure
 * looks Pythonic. Returns null when nothing provable exists - never guesses.
 */
export function probeInstalledApi(cwd: string, packageName: string, symbol: string | undefined, failureText: string): ApiOracleResult | null {
  if (!SAFE_NAME.test(packageName)) return null;
  const node = probeNodePackage(cwd, packageName, symbol);
  if (node && (node.installed || !looksPython(failureText))) return node;
  if (looksPython(failureText)) {
    const py = probePythonModule(cwd, packageName, symbol);
    if (py) return py;
  }
  return node;
}
