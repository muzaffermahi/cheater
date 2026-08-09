#!/usr/bin/env node
import { spawn } from "node:child_process";

const prompt = process.env.KITTEN_BENCH_PROMPT;
const cwd = process.env.KITTEN_BENCH_CWD;
const model = process.env.OPENCODE_BENCH_MODEL || "maas/qwen3.6-35b-a3b";
const executable = process.env.OPENCODE_BIN || "C:/Users/LENOVO/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe";
if (!prompt || !cwd) { console.error("benchmark adapter requires KITTEN_BENCH_PROMPT and KITTEN_BENCH_CWD"); process.exit(2); }
const child = spawn(executable, ["run", "--pure", "--dangerously-skip-permissions", "--model", model, "--dir", cwd, "--format", "json", prompt], {
  cwd,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
child.on("error", (error) => { console.error(error.message); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
