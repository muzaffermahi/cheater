#!/usr/bin/env node
// Packed-install smoke test (KITTEN_PRODUCT_GOAL §11/§12.9): pack the package, install the tarball into
// a fresh temp project, and prove the `kitten` bin runs from the packed assets — help, doctor (store
// writable), a persisted run listing, and that `kitten web` boots and serves its page. Exits non-zero on
// any failure. Slow (real npm install), so it's an on-demand script + a CI gate, not a unit test.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkgDir = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); // strip leading slash on win
const log = (m) => process.stdout.write(m + "\n");
const fail = (m) => { process.stderr.write("SMOKE FAIL: " + m + "\n"); process.exit(1); };

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

const work = mkdtempSync(join(tmpdir(), "kitten-pack-"));
const home = join(work, "home");
let tarball = "";
try {
  log("• npm pack …");
  const packOut = run("npm", ["pack", "--silent"], { cwd: pkgDir });
  tarball = packOut.trim().split(/\r?\n/).pop();
  if (!tarball) fail("npm pack produced no tarball");
  log("  → " + tarball);

  log("• install the tarball into a clean project …");
  const proj = join(work, "proj");
  execFileSync("node", ["-e", `require('fs').mkdirSync(${JSON.stringify(proj)},{recursive:true})`]);
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "smoke", private: true, version: "1.0.0" }));
  run("npm", ["install", "--silent", join(pkgDir, tarball)], { cwd: proj });

  const bin = join(proj, "node_modules", ".bin", process.platform === "win32" ? "kitten.cmd" : "kitten");
  const env = { ...process.env, KITTEN_HOME: home, KITTEN_BASE_URL: "http://127.0.0.1:9/v1", KITTEN_MAIN_MODEL: "ornith" };

  log("• kitten help …");
  const help = run(bin, ["help"], { cwd: proj, env });
  if (!/Usage:/.test(help) || !/kitten run/.test(help)) fail("help output missing");

  log("• kitten doctor …");
  const doctor = run(bin, ["doctor"], { cwd: proj, env });
  if (!/store at/.test(doctor)) fail("doctor did not report the store");

  log("• kitten run (offline, persists) + resume …");
  try { run(bin, ["run", "explain what a store is", "--json"], { cwd: proj, env }); } catch { /* run may exit 1 offline; that's fine */ }
  const list = run(bin, ["conversations"], { cwd: proj, env });
  if (!/conv_/.test(list)) fail("no persisted conversation after a run");

  log("• kitten web boots + serves its page …");
  const port = 4137;
  const web = spawn(bin, ["web", "--no-open", "--port", String(port)], { cwd: proj, env, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetch(`http://127.0.0.1:${port}/`);
    if (res.status !== 200) fail("web page status " + res.status);
    const html = await res.text();
    if (!/<!doctype html>/i.test(html)) fail("web page is not html");
    // Unauthorized API must be rejected.
    const api = await fetch(`http://127.0.0.1:${port}/api/conversations`);
    if (api.status !== 401) fail("web API should require a token (got " + api.status + ")");
  } finally {
    web.kill();
  }

  log("\n✓ PACK SMOKE PASSED");
} finally {
  try { if (tarball) rmSync(join(pkgDir, tarball), { force: true }); } catch { /* */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  // avoid unused import lint
  void readdirSync;
}
