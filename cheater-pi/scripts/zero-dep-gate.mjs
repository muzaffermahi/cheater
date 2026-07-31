#!/usr/bin/env node
// Release invariant: the published Kitten command must run with Node built-ins only. Legacy Pi
// packages remain dev-only for maintainers/tests and are never installed by an end user.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = join(packageDir, "package.json");
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const productionKeys = Object.keys(pkg.dependencies ?? {});
const peerKeys = Object.keys(pkg.peerDependencies ?? {});
if (productionKeys.length || peerKeys.length) {
  throw new Error(`production dependencies are not empty: dependencies=${productionKeys.join(",") || "none"}; peerDependencies=${peerKeys.join(",") || "none"}`);
}
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ls", "--omit=dev", "--depth=0", "--json"], { cwd: packageDir, encoding: "utf8" });
let tree;
try { tree = JSON.parse(result.stdout || "{}"); } catch { throw new Error(`npm ls returned invalid JSON: ${result.stdout || result.stderr}`); }
const installed = Object.keys(tree.dependencies ?? {});
if (installed.length) throw new Error(`npm reports production dependencies: ${installed.join(", ")}`);
console.log("zero-dep gate passed: no production or peer dependencies");
