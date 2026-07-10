import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledPiCli, ensurePiBranded, resolvePiCommand, BRAND_NAME } from "../src/launcher.js";
import { CheaterHeaderComponent } from "../src/ui/headerComponent.js";
import { registerCheaterCommands } from "../src/commands.js";

// A throwaway pi package tree: <root>/package.json + <root>/dist/cli.js, so ensurePiBranded can
// derive the package dir from the cli path exactly as it does at launch.
function fakePiPackage(piConfig?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "cheater-brand-"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "cli.js"), "// stub\n");
  writeFileSync(join(root, "package.json"), JSON.stringify(piConfig ? { name: "pi", piConfig } : { name: "pi" }, null, 2));
  return join(root, "dist", "cli.js");
}

test("ensurePiBranded stamps piConfig.name=Cheater and defaults configDir to .pi", () => {
  const cli = fakePiPackage();
  ensurePiBranded(cli);
  const pkg = JSON.parse(readFileSync(join(cli, "..", "..", "package.json"), "utf8"));
  assert.equal(pkg.piConfig.name, BRAND_NAME);
  assert.equal(pkg.piConfig.configDir, ".pi", "configDir must default to .pi so existing Pi login/sessions keep working");
});

test("ensurePiBranded preserves an existing configDir (never breaks auth/session storage)", () => {
  const cli = fakePiPackage({ configDir: ".pi", extra: "keep" });
  ensurePiBranded(cli);
  const pkg = JSON.parse(readFileSync(join(cli, "..", "..", "package.json"), "utf8"));
  assert.equal(pkg.piConfig.name, BRAND_NAME);
  assert.equal(pkg.piConfig.configDir, ".pi");
  assert.equal(pkg.piConfig.extra, "keep", "unrelated piConfig keys must be preserved");
});

test("ensurePiBranded is idempotent (already-branded package is left byte-identical)", () => {
  const cli = fakePiPackage({ name: BRAND_NAME, configDir: ".pi" });
  const before = readFileSync(join(cli, "..", "..", "package.json"), "utf8");
  ensurePiBranded(cli);
  const after = readFileSync(join(cli, "..", "..", "package.json"), "utf8");
  assert.equal(after, before, "a second run must not rewrite an already-branded package.json");
});

test("ensurePiBranded never throws on a missing/locked package (best-effort)", () => {
  assert.doesNotThrow(() => ensurePiBranded(join(tmpdir(), "does-not-exist", "dist", "cli.js")));
});

test("resolvePiCommand prefers the bundled Pi and runs it with the current node", () => {
  const savedCmd = process.env.CHEATER_PI_COMMAND;
  const savedPath = process.env.CHEATER_PI_PATH;
  delete process.env.CHEATER_PI_COMMAND;
  delete process.env.CHEATER_PI_PATH;
  try {
    const cli = bundledPiCli();
    assert.ok(cli && cli.endsWith("cli.js"), "the bundled pi-coding-agent must be resolvable in this workspace");
    const resolved = resolvePiCommand({});
    assert.equal(resolved.source, "bundled");
    assert.equal(resolved.command[0], process.execPath, "run the bundled Pi with the same node that launched Cheater");
    assert.equal(resolved.command[1], cli);
  } finally {
    if (savedCmd !== undefined) process.env.CHEATER_PI_COMMAND = savedCmd;
    if (savedPath !== undefined) process.env.CHEATER_PI_PATH = savedPath;
  }
});

test("resolvePiCommand still honors an explicit configured command (no bundled override)", () => {
  const resolved = resolvePiCommand({ piCommand: "C:\\custom\\pi.cmd" });
  assert.equal(resolved.source, "config");
  assert.deepEqual(resolved.command, ["C:\\custom\\pi.cmd"]);
});

test("CheaterHeaderComponent renders a kitten wordmark and never leaks 'pi'", () => {
  const header = new CheaterHeaderComponent(null, undefined, { style: "cat" });
  const lines = header.render(80);
  assert.ok(lines.length >= 1);
  assert.ok(lines.some((l) => l.includes("kitten")), "the header must show the Kitten Code wordmark");
  assert.ok(!lines.join("\n").toLowerCase().includes(" pi "), "the header must not print the word pi");
});

test("CheaterHeaderComponent 'off' style is a single plain wordmark line (still hides Pi's banner)", () => {
  const header = new CheaterHeaderComponent(null, undefined, { style: "off" });
  const lines = header.render(80);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^kitten/);
});

test("CheaterHeaderComponent height is stable across renders (never forces a relayout)", () => {
  const header = new CheaterHeaderComponent(null, undefined, { style: "cat" });
  assert.equal(header.render(80).length, header.render(80).length);
});

test("the raw-output toggle command replaced the old /pi command", () => {
  const commands = new Map<string, unknown>();
  registerCheaterCommands({ registerCommand: (name: string, def: unknown) => commands.set(name, def) } as never);
  assert.ok(commands.has("raw"), "the /raw command must be registered");
  assert.ok(!commands.has("pi"), "the /pi command must be gone");
  const map = commands.get("map") as { description?: string } | undefined;
  assert.ok(map && !/\bPi\b/.test(map.description ?? ""), "no command description should say 'Pi'");
});
