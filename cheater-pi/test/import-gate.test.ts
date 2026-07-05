import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkImports } from "../src/reliability/importGate.js";

// The single most common small-model coding failure is a hallucinated import: a relative
// path that does not exist, a named symbol the target module never exports, or an
// unavailable npm package. Discovering that three tool calls later via a failed test burns a
// whole verify/repair cycle; these tests pin the deterministic, in-band catch at edit time.

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cheater-import-gate-"));
}

test("flags a relative TS import that does not resolve to any file", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "a.ts"), "import { helper } from './missing.js';\n", "utf8");
  const result = checkImports(root, "a.ts");
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /does not resolve to any file/);
});

test("resolves a relative TS import against the .ts source even when the spec says .js (ESM convention)", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "helper.ts"), "export function helper() { return 1; }\n", "utf8");
  writeFileSync(join(root, "a.ts"), "import { helper } from './helper.js';\n", "utf8");
  const result = checkImports(root, "a.ts");
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test("flags a named import that the target module does not export", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "helper.ts"), "export function helper() { return 1; }\n", "utf8");
  writeFileSync(join(root, "a.ts"), "import { doesNotExist } from './helper.js';\n", "utf8");
  const result = checkImports(root, "a.ts");
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /"doesNotExist" is not exported/);
});

test("does not flag a real export, including default and class exports", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "widgets.ts"), "export class Widget {}\nexport default function build() {}\n", "utf8");
  writeFileSync(join(root, "a.ts"), "import build, { Widget } from './widgets.js';\n", "utf8");
  const result = checkImports(root, "a.ts");
  assert.equal(result.ok, true);
});

test("flags an uninstalled, undeclared npm package", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", dependencies: {} }), "utf8");
  writeFileSync(join(root, "a.ts"), "import leftPad from 'left-pad';\n", "utf8");
  const result = checkImports(root, "a.ts");
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /"left-pad" is not installed/);
});

test("does not flag a package declared in package.json even if not yet installed", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", dependencies: { "left-pad": "^1.0.0" } }), "utf8");
  writeFileSync(join(root, "a.ts"), "import leftPad from 'left-pad';\n", "utf8");
  const result = checkImports(root, "a.ts");
  assert.equal(result.ok, true);
});

test("never flags Node builtins or node: specifiers", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "a.ts"), "import { readFileSync } from 'fs';\nimport { join } from 'node:path';\n", "utf8");
  const result = checkImports(root, "a.ts");
  assert.equal(result.ok, true);
});

test("flags a Python relative import that does not resolve inside the package", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "__init__.py"), "", "utf8");
  writeFileSync(join(root, "pkg", "a.py"), "from .missing import helper\n", "utf8");
  const result = checkImports(root, "pkg/a.py");
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /does not resolve inside the package/);
});

test("flags a Python relative import whose named symbol is not defined in the target module", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "__init__.py"), "", "utf8");
  writeFileSync(join(root, "pkg", "helper.py"), "def real_helper():\n    pass\n", "utf8");
  writeFileSync(join(root, "pkg", "a.py"), "from .helper import fake_helper\n", "utf8");
  const result = checkImports(root, "pkg/a.py");
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /"fake_helper" is not defined/);
});

test("does not flag a Python relative import whose symbol is real", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "__init__.py"), "", "utf8");
  writeFileSync(join(root, "pkg", "helper.py"), "def real_helper():\n    pass\n", "utf8");
  writeFileSync(join(root, "pkg", "a.py"), "from .helper import real_helper\n", "utf8");
  const result = checkImports(root, "pkg/a.py");
  assert.equal(result.ok, true);
});

test("flags a repo-internal absolute Python import that does not resolve", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "mathutils.py"), "def sum_range(a, b):\n    return sum(range(a, b))\n", "utf8");
  writeFileSync(join(root, "src", "app.py"), "import src.missing_module\n", "utf8");
  const result = checkImports(root, "src/app.py");
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /does not resolve inside this repo/);
});

test("flags a bare 'import module' (not just 'from module import name') that does not resolve", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "mathutils.py"), "def sum_range(a, b):\n    return sum(range(a, b))\n", "utf8");
  writeFileSync(join(root, "src", "app.py"), "import src.missing_module\n", "utf8");
  const result = checkImports(root, "src/app.py");
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /does not resolve inside this repo/);
});

test("does not flag a bare 'import module' that resolves inside a namespace package (no __init__.py)", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "mathutils.py"), "def sum_range(a, b):\n    return sum(range(a, b))\n", "utf8");
  writeFileSync(join(root, "src", "app.py"), "import src.mathutils\n", "utf8");
  const result = checkImports(root, "src/app.py");
  assert.equal(result.ok, true);
});

test("never flags third-party Python packages (cannot prove a negative about the environment)", () => {
  const root = tmpRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.py"), "import numpy\nimport requests\n", "utf8");
  const result = checkImports(root, "src/app.py");
  assert.equal(result.ok, true);
});

test("does not flag `import ssl` when a non-python data directory named ssl/ exists (openssl-cert case)", () => {
  // The openssl-selfsigned-cert task's solution creates an /app/ssl/ CERT directory, then a
  // check_cert.py does `import ssl` (stdlib). The old gate saw the ssl/ directory, treated the
  // module as repo-internal, failed to resolve it, and false-flagged it - so the model rewrote
  // its working verifier script to appease a phantom error. ssl is stdlib and a cert dir is not
  // a package, so this must be clean.
  const root = tmpRepo();
  mkdirSync(join(root, "ssl"), { recursive: true });
  writeFileSync(join(root, "ssl", "server.crt"), "-----BEGIN CERTIFICATE-----\n", "utf8");
  writeFileSync(join(root, "ssl", "server.key"), "-----BEGIN PRIVATE KEY-----\n", "utf8");
  writeFileSync(join(root, "check_cert.py"), "import ssl\nimport subprocess\nimport os\n", "utf8");
  const result = checkImports(root, "check_cert.py");
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test("does not treat a non-python DATA directory as a repo package on a name collision", () => {
  // `logs/` is a directory of log files, not a Python package. A `import logs...` must be treated
  // as an unprovable third-party/absent import (never flagged), NOT as a broken repo-internal one.
  const root = tmpRepo();
  mkdirSync(join(root, "src", "logs"), { recursive: true });
  writeFileSync(join(root, "src", "logs", "2025-08-10_db.log"), "ERROR x\n", "utf8");
  writeFileSync(join(root, "src", "app.py"), "import logs.reader\n", "utf8");
  const result = checkImports(root, "src/app.py");
  assert.equal(result.ok, true);
});

test("still flags a broken submodule import inside a REAL python package dir (regression guard)", () => {
  // The data-directory relaxation must not blind the gate to a genuinely-broken repo import: a
  // directory that DOES contain python is still a package whose missing submodules are flagged.
  const root = tmpRepo();
  mkdirSync(join(root, "src", "logs"), { recursive: true });
  writeFileSync(join(root, "src", "logs", "__init__.py"), "", "utf8");
  writeFileSync(join(root, "src", "logs", "reader.py"), "def read():\n    pass\n", "utf8");
  writeFileSync(join(root, "src", "app.py"), "import logs.missing_submodule\n", "utf8");
  const result = checkImports(root, "src/app.py");
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /does not resolve inside this repo/);
});

test("is a no-op for unsupported file types and missing files", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "README.md"), "# hi\n", "utf8");
  assert.deepEqual(checkImports(root, "README.md"), { ok: true, issues: [] });
  assert.deepEqual(checkImports(root, "does/not/exist.ts"), { ok: true, issues: [] });
});

test("bounds the number of reported issues to 4", () => {
  const root = tmpRepo();
  const lines = Array.from({ length: 8 }, (_, i) => `import { missing${i} } from './missing${i}.js';`).join("\n");
  writeFileSync(join(root, "a.ts"), `${lines}\n`, "utf8");
  const result = checkImports(root, "a.ts");
  assert.equal(result.ok, false);
  assert.ok(result.issues.length <= 4);
});
