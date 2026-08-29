#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const cli = join(here, "..", "dist", "src", "core", "kitten.js");
const prompt = process.env.KITTEN_BENCH_PROMPT;
const cwd = process.env.KITTEN_BENCH_CWD;
if (!prompt || !cwd) { console.error("benchmark adapter requires KITTEN_BENCH_PROMPT and KITTEN_BENCH_CWD"); process.exit(2); }
const child = spawn(process.execPath, [cli, "run", prompt, "--cwd", cwd, "--json", "--effort", "balanced", "--dangerous"], {
  cwd,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
child.on("error", (error) => { console.error(error.message); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
