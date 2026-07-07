import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPiCommand,
  firstLegacyCommand,
  formatCommand,
  isStaleCheaterPiShim,
  parseLaunchOptions
} from "../src/launcher.js";
import { doctorChecks } from "../src/doctor.js";

test("parses Cheater launcher flags separately from Pi args", () => {
  const options = parseLaunchOptions(["--debug", "--no-theme", "--model", "x", "hello"]);
  assert.equal(options.debug, true);
  assert.equal(options.noTheme, true);
  assert.deepEqual(options.passthrough, ["--model", "x", "hello"]);
});

test("builds Pi command with Cheater resources and preserves spaces", () => {
  const root = join(tmpdir(), "Cheater Package With Spaces");
  const options = parseLaunchOptions(["--provider", "openai"]);
  const command = buildPiCommand({ piCommand: "C:\\Program Files\\Pi\\pi.cmd" }, options, root);
  assert.equal(command[0], "C:\\Program Files\\Pi\\pi.cmd");
  assert.ok(command.includes("--extension"));
  assert.ok(command.some((part) => part.includes("Cheater Package With Spaces")));
  assert.ok(command.includes("--theme"));
  assert.deepEqual(command.slice(-2), ["--provider", "openai"]);
});

test("no-theme skips only the theme flag", () => {
  const command = buildPiCommand({ piCommand: "pi" }, parseLaunchOptions(["--no-theme"]), "C:\\pkg");
  assert.ok(command.includes("--extension"));
  assert.equal(command.includes("--theme"), false);
});

test("detects legacy Python primary commands", () => {
  assert.equal(firstLegacyCommand(["guide", "bug"]), "guide");
  assert.equal(firstLegacyCommand(["--model", "x", "normal request"]), undefined);
});

test("formats Windows paths without losing spaces", () => {
  const formatted = formatCommand(["C:\\Program Files\\Pi\\pi.cmd", "--extension", "C:\\A B\\extension.ts"]);
  assert.match(formatted, /"C:\\Program Files\\Pi\\pi.cmd"/);
  assert.match(formatted, /"C:\\A B\\extension.ts"/);
});

test("detects stale old pi shim", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheater-shim-"));
  const shim = join(dir, "pi.bat");
  writeFileSync(shim, '@echo off\npython "cheater.py" --wrap-pi %*\n');
  assert.equal(isStaleCheaterPiShim(shim), true);
});

test("doctor reports Cheater resources", () => {
  const checks = doctorChecks({ piCommand: "pi" }, parseLaunchOptions(["--doctor"]));
  const names = new Set(checks.map((check) => check.name));
  assert.ok(names.has("Cheater extension exists"));
  assert.ok(names.has("Runtime entrypoint is Cheater"));
});
