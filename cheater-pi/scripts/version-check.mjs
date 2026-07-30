#!/usr/bin/env node
// Keep every published surface on the same version. Tag checking is opt-in for local development
// and strict in the release workflow (`npm run version-check -- --tag v0.7.0`).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pyproject = readFileSync(join(root, "..", "pyproject.toml"), "utf8");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const pyVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const headingVersion = changelog.match(/^## \[([^\]]+)\]/m)?.[1];
const errors = [];
if (!pyVersion || pyVersion !== pkg.version) errors.push(`package ${pkg.version} != pyproject ${pyVersion ?? "missing"}`);
if (!headingVersion || !headingVersion.includes(pkg.version)) errors.push(`CHANGELOG latest heading does not contain ${pkg.version}`);
const kitten = spawnSync(process.execPath, [join(root, "dist", "src", "core", "kitten.js"), "--version"], { cwd: root, encoding: "utf8" });
if (kitten.status !== 0 || kitten.stdout.trim() !== pkg.version) errors.push(`kitten --version returned ${JSON.stringify(kitten.stdout.trim())}`);
const tagIndex = process.argv.indexOf("--tag");
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1] ?? "";
  if (tag !== `v${pkg.version}`) errors.push(`tag ${tag || "missing"} != v${pkg.version}`);
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`version lock passed: ${pkg.version}`);
