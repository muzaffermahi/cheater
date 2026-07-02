import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractDeclarations, extractExportNames, probeInstalledApi } from "../src/reliability/apiOracle.js";
import { buildCheatSheet, oracleEvidence } from "../src/reliability/cheatSheet.js";
import { DEFAULT_CONFIG } from "../src/config.js";

// The installed-API oracle: when a failure names a library symbol, the harness reads what
// the INSTALLED version of that package actually exposes (node_modules .d.ts / python
// inspect) and injects the real signature - environment fact, fully offline, no model tool.

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cheater-oracle-"));
}

function installFakePackage(root: string, name: string, dts: string, version = "2.3.4"): void {
  const dir = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, types: "index.d.ts" }), "utf8");
  writeFileSync(join(dir, "index.d.ts"), dts, "utf8");
}

const FAKE_DTS = [
  "export declare function greet(name: string, options?: { loud?: boolean }): string;",
  "export interface Config {",
  "  retries: number;",
  "  greet?: boolean;",
  "}",
  "export declare class Client {",
  "  connect(url: string): Promise<void>;",
  "}",
  "export { greet as hello };"
].join("\n");

test("node oracle finds a symbol's real declaration in the installed .d.ts", () => {
  const root = tmpRepo();
  installFakePackage(root, "fakepkg", FAKE_DTS);
  const result = probeInstalledApi(root, "fakepkg", "greet", "TypeError: fakepkg.greet is not a function");
  assert.ok(result);
  assert.equal(result!.installed, true);
  assert.equal(result!.version, "2.3.4");
  assert.equal(result!.symbolFound, true);
  assert.match(result!.declarations.join(" "), /greet\(name: string, options\?/);
});

test("node oracle lists real exports when the symbol does not exist", () => {
  const root = tmpRepo();
  installFakePackage(root, "fakepkg", FAKE_DTS);
  const result = probeInstalledApi(root, "fakepkg", "sendGreeting", "TypeError: fakepkg.sendGreeting is not a function");
  assert.ok(result);
  assert.equal(result!.symbolFound, false);
  assert.ok(result!.availableExports.includes("greet"));
  assert.ok(result!.availableExports.includes("Client"));
  assert.ok(result!.availableExports.includes("hello"), "re-exported aliases count as real exports");
});

test("node oracle handles scoped packages", () => {
  const root = tmpRepo();
  installFakePackage(root, "@scope/pkg", "export declare const version: string;");
  const result = probeInstalledApi(root, "@scope/pkg", "version", "TypeError: @scope/pkg version");
  assert.ok(result);
  assert.equal(result!.symbolFound, true);
});

test("node oracle proves the negative: uninstalled, undeclared package in a node repo", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", dependencies: {} }), "utf8");
  const result = probeInstalledApi(root, "left-pad", undefined, "Error: Cannot find module 'left-pad'");
  assert.ok(result);
  assert.equal(result!.installed, false);
  const card = oracleEvidence(result!);
  assert.ok(card);
  assert.match(card!.title, /not installed/);
  assert.match(card!.fix, /ask the user before adding a dependency/);
});

test("declared-but-not-installed packages produce no card (an install problem, not an API fact)", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", dependencies: { "left-pad": "^1.0.0" } }), "utf8");
  assert.equal(probeInstalledApi(root, "left-pad", undefined, "Cannot find module 'left-pad'"), null);
});

test("oracle rejects non-identifier package names (never interpolates junk)", () => {
  const root = tmpRepo();
  assert.equal(probeInstalledApi(root, "evil; import os", "x", "AttributeError"), null);
  assert.equal(probeInstalledApi(root, "pkg'); print(1)#", undefined, "Traceback"), null);
});

test(".d.ts extraction helpers are bounded and dedupe", () => {
  const decls = extractDeclarations(FAKE_DTS, "greet");
  assert.ok(decls.length >= 1 && decls.length <= 4);
  const names = extractExportNames("export declare function a(): void;\n".repeat(40) + "export { b, c as d };");
  assert.ok(names.length <= 18);
});

const pythonAvailable = (() => {
  try {
    return spawnSync("python", ["-c", "print(1)"], { encoding: "utf8", timeout: 4000, windowsHide: true }).status === 0;
  } catch {
    return false;
  }
})();

test("python oracle inspects a stdlib module's real signature", { skip: !pythonAvailable }, () => {
  const root = tmpRepo();
  const result = probeInstalledApi(root, "json", "dumps", "Traceback (most recent call last): AttributeError: module 'json' has no attribute 'dump_s'");
  assert.ok(result);
  assert.equal(result!.language, "python");
  assert.equal(result!.symbolFound, true);
  assert.match(result!.declarations.join(" "), /dumps\(/);
});

test("python oracle lists real members when the symbol is missing", { skip: !pythonAvailable }, () => {
  const root = tmpRepo();
  const result = probeInstalledApi(root, "json", "dump_everything", "Traceback: AttributeError: module 'json' has no attribute 'dump_everything'");
  assert.ok(result);
  assert.equal(result!.symbolFound, false);
  assert.ok(result!.availableExports.includes("dumps"));
});

test("cheat sheet carries the oracle card for a library API failure - offline, no tool call", async () => {
  const root = tmpRepo();
  installFakePackage(root, "fakepkg", FAKE_DTS);
  writeFileSync(join(root, "empty-corpus.jsonl"), "", "utf8");
  const sheet = await buildCheatSheet(root, "TypeError: fakepkg.sendGreeting is not a function at src/app.ts:12", DEFAULT_CONFIG, { memoryPath: join(root, "empty-corpus.jsonl") });
  assert.ok(sheet, "a classified library_api_error with an installed package must produce a sheet");
  const oracle = sheet!.cards.find((card) => card.source === "api_oracle");
  assert.ok(oracle, "the oracle card must be present");
  assert.equal(oracle!.confidence, "high");
  assert.match(oracle!.fix, /greet/);
});

test("cheat sheet oracle card outranks corpus/doc evidence in card order", async () => {
  const root = tmpRepo();
  installFakePackage(root, "fakepkg", FAKE_DTS);
  writeFileSync(join(root, "README.md"), "We use fakepkg for greetings.\n", "utf8");
  writeFileSync(join(root, "empty-corpus.jsonl"), "", "utf8");
  const sheet = await buildCheatSheet(root, "TypeError: fakepkg.greet is not a function", DEFAULT_CONFIG, { memoryPath: join(root, "empty-corpus.jsonl") });
  assert.ok(sheet);
  const oracleIndex = sheet!.cards.findIndex((card) => card.source === "api_oracle");
  const docsIndex = sheet!.cards.findIndex((card) => card.source === "local_docs");
  assert.ok(oracleIndex >= 0);
  if (docsIndex >= 0) assert.ok(oracleIndex < docsIndex, "environment facts come before doc mentions");
});
