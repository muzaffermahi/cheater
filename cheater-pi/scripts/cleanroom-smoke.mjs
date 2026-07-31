#!/usr/bin/env node
// Clean-room package smoke: installs the exact tarball with --omit=dev and exercises only the
// dependency-free command surface. No repository mount, browser, or legacy Pi entry is required.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDir = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const supplied = process.argv[2] ? resolve(process.argv[2]) : null;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts });
const work = mkdtempSync(join(tmpdir(), "kitten-cleanroom-"));
const home = join(work, "home");
let tarball = supplied;
try {
  if (!tarball) tarball = join(packageDir, run("npm", ["pack", "--silent"], { cwd: packageDir }).trim().split(/\r?\n/).pop());
  const project = join(work, "project");
  execFileSync(process.execPath, ["-e", `require('fs').mkdirSync(${JSON.stringify(project)},{recursive:true})`], { encoding: "utf8" });
  run("npm", ["install", "--silent", "--omit=dev", tarball, "--prefix", project], { cwd: packageDir });
  const binDir = join(project, "node_modules", ".bin");
  const bin = (name) => join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
  const env = { ...process.env, KITTEN_HOME: home, KITTEN_BASE_URL: "http://127.0.0.1:9/v1", KITTEN_MAIN_MODEL: "fixture" };
  const help = run(bin("kitten"), ["help"], { cwd: project, env });
  if (!/Usage:/.test(help) || !/kitten run/.test(help)) throw new Error("clean-room help failed");
  let init = "";
  try { init = run(bin("kitten"), ["init", "--yes"], { cwd: project, env }); } catch (error) { init = error.stdout ?? ""; }
  if (!/store writable/.test(init)) throw new Error("clean-room init failed");
  let doctor = "";
  try { doctor = run(bin("kitten"), ["doctor"], { cwd: project, env }); } catch (error) { doctor = error.stdout ?? ""; }
  if (!/store writable/.test(doctor)) throw new Error("clean-room doctor failed");
  const conversations = run(bin("kitten"), ["conversations"], { cwd: project, env });
  if (typeof conversations !== "string") throw new Error("clean-room conversations failed");
  for (const shell of ["bash", "zsh", "fish", "powershell"]) {
    const completion = run(bin("kitten"), ["completions", shell], { cwd: project, env });
    if (!completion.trim()) throw new Error(`clean-room ${shell} completion failed`);
  }
  const installedPackage = JSON.parse(readFileSync(join(project, "node_modules", "@cheater", "cheater-pi", "package.json"), "utf8"));
  if (Object.keys(installedPackage.dependencies ?? {}).length || Object.keys(installedPackage.peerDependencies ?? {}).length) throw new Error("clean-room package has production dependencies");
  console.log(`clean-room smoke passed: ${tarball}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
