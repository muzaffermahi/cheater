#!/usr/bin/env node
/** Harbor/fixture adapter for the pinned oh-my-pi Linux bundle. */
import { spawn } from "node:child_process";

const prompt = process.env.KITTEN_BENCH_PROMPT;
const cwd = process.env.KITTEN_BENCH_CWD;
const model = process.env.OMP_BENCH_MODEL || "openai/qwen3.6-35b-a3b";
const executable = process.env.OMP_BIN || "omp";
if (!prompt || !cwd) { console.error("OMP benchmark adapter requires KITTEN_BENCH_PROMPT and KITTEN_BENCH_CWD"); process.exit(2); }
const args = ["--print", "--no-pty", "--model", model, prompt];
const child = spawn(executable, args, { cwd, env: { ...process.env, PI_NO_TITLE: "1", PI_NO_PTY: "1" }, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
child.on("error", (error) => { console.error(`omp adapter: ${error.message}`); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

