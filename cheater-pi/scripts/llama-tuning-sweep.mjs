#!/usr/bin/env node
// Measure real llama-server configurations on THIS machine.
//
// The auto launch plan is a set of guesses about a machine it cannot see. This script replaces the
// guessing with numbers: it launches llama-server once per configuration, waits for the weights to
// load, runs the same prompt through it, and records what the server itself reports for prompt
// processing and token generation. The winner becomes the shipped default; the shape of the curve
// becomes the algorithm.
//
//   node scripts/llama-tuning-sweep.mjs --out sweep.json [--only 1,4,7] [--tokens 128]
//
// Every configuration is launched cold and torn down afterwards, because a warm server keeps the
// weights resident and would hand later configurations a head start they do not have in real use.

import { spawn } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SERVER = arg("server", "C:/Users/LENOVO/Desktop/cheater/runtimes/llama.cpp/llama-server.exe");
const MODEL = arg("model", "C:/Users/LENOVO/.lmstudio/models/deepreinforce-ai/Ornith-1.0-35B-GGUF/ornith-1.0-35b-Q5_K_M.gguf");
const PORT = Number(arg("port", "8099"));
const OUT = arg("out", "sweep.json");
const GEN_TOKENS = Number(arg("tokens", "128"));
const ONLY = arg("only", "");
const LOAD_TIMEOUT_MS = Number(arg("load-timeout", "420000"));

const BASE = `http://127.0.0.1:${PORT}`;

// A prompt with the shape of real agent work: a chunk of context to prefill, then a request that
// forces sustained generation. Prefill and decode are measured separately because they respond to
// different flags.
const CONTEXT_BLOCK = `
function parseLedger(lines) {
  const entries = [];
  for (const line of lines) {
    const [date, description, amount] = line.split(",");
    if (!date || !amount) continue;
    entries.push({ date, description: (description ?? "").trim(), amount: Number(amount) });
  }
  return entries;
}

function summarise(entries) {
  const byMonth = new Map();
  for (const entry of entries) {
    const month = entry.date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + entry.amount);
  }
  return byMonth;
}
`.repeat(6);

const PROMPT = `You are a careful software engineer.

Here is some existing code:
${CONTEXT_BLOCK}

Task: explain precisely what happens when \`parseLedger\` receives a line whose amount is not a
number, and describe the smallest change that would make the function reject such a line instead.
Be specific and complete.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(deadlineMs, alive) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (!alive()) return { ready: false, reason: "the server exited during load" };
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return { ready: true, loadMs: Date.now() - started };
    } catch { /* still loading */ }
    await sleep(500);
  }
  return { ready: false, reason: "timed out waiting for the weights to load" };
}

async function measure() {
  // llama-server reports its own timings; trust those over wall-clock arithmetic here.
  const res = await fetch(`${BASE}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: PROMPT, n_predict: GEN_TOKENS, temperature: 0, cache_prompt: false }),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) throw new Error(`completion failed: HTTP ${res.status}`);
  const body = await res.json();
  const t = body.timings ?? {};
  return {
    promptTokens: t.prompt_n ?? 0,
    promptPerSecond: t.prompt_per_second ?? 0,
    generatedTokens: t.predicted_n ?? 0,
    decodePerSecond: t.predicted_per_second ?? 0,
    promptMs: t.prompt_ms ?? 0,
    decodeMs: t.predicted_ms ?? 0,
  };
}

function launch(args) {
  const child = spawn(SERVER, [...args, "--host", "127.0.0.1", "--port", String(PORT)], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr = (stderr + String(c)).slice(-4000); });
  return { child, stderr: () => stderr };
}

async function stop(handle) {
  if (!handle) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(handle.child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    else handle.child.kill("SIGTERM");
  } catch { /* already gone */ }
  // Give the driver time to actually release the VRAM, or the next launch inherits a dirty device.
  for (let i = 0; i < 40; i++) {
    if (handle.child.exitCode !== null) break;
    await sleep(250);
  }
  await sleep(3000);
}

/**
 * Phase 2: combine the individual winners and map the cliff edge precisely. Phase 1 varied one thing
 * at a time; the settings interact, so the combination has to be measured rather than assumed.
 */
function combinedConfigurations() {
  const common = ["--model", MODEL, "--jinja", "--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--no-warmup"];
  const list = [];
  const add = (name, note, extra) => list.push({ name, note, args: [...common, "--n-gpu-layers", "999", ...extra] });
  const best = ["--ctx-size", "32768", "--batch-size", "4096", "--ubatch-size", "4096"];
  // The predicted optimum: the winning split, the winning batch geometry, and mmap left alone.
  add("combined-30", "ncmoe 30 + b/ub 4096 + mmap", ["--n-cpu-moe", "30", ...best]);
  // One layer either side, to confirm 30 is the edge and not a lucky sample.
  add("combined-29", "ncmoe 29 + b/ub 4096 + mmap", ["--n-cpu-moe", "29", ...best]);
  add("combined-31", "ncmoe 31 + b/ub 4096 + mmap", ["--n-cpu-moe", "31", ...best]);
  // Does pinning every core help once the batch is already large?
  add("combined-30-threads", "ncmoe 30 + b/ub 4096 + mmap + all cores", ["--n-cpu-moe", "30", ...best, "--threads", String(Math.max(1, cpus().length))]);
  // Speculation is on by default in Kitten's plan. Prompt-lookup drafting is free of VRAM but not
  // free of compute, and on a CPU-split MoE the verification pass may cost more than the drafts save.
  add("spec-off", "ncmoe 30 + b/ub 4096, no speculation", ["--n-cpu-moe", "30", ...best]);
  add("spec-ngram", "ncmoe 30 + b/ub 4096 + --spec-type ngram-mod", ["--n-cpu-moe", "30", ...best, "--spec-type", "ngram-mod"]);
  // f16 KV instead of q8_0: better quality per token, but it doubles the cache — does it cost a layer?
  const noQuant = common.filter((a, i) => !(common[i - 1] === "--cache-type-k" || common[i - 1] === "--cache-type-v" || a === "--cache-type-k" || a === "--cache-type-v"));
  list.push({ name: "combined-30-f16kv", note: "ncmoe 30 + b/ub 4096 + f16 KV", args: [...noQuant, "--n-gpu-layers", "999", "--n-cpu-moe", "30", ...best] });
  return list;
}

/**
 * Phase 3: the user's own LM Studio settings, which reportedly reach 20-30 tok/s, against Kitten's
 * measured plan. LM Studio differs on five axes at once (smaller window, f16 KV, small batch, pinned
 * threads, no speculation), so each is also isolated to find which one actually carries the gain.
 */
function lmStudioConfigurations() {
  const base = ["--model", MODEL, "--jinja", "--flash-attn", "on", "--no-warmup", "--n-gpu-layers", "999"];
  const list = [];
  const add = (name, note, extra) => list.push({ name, note, args: [...base, ...extra] });

  // Exactly what the user's LM Studio panel shows.
  add("lmstudio-asis", "ctx 16654, ncmoe 32, b2048/ub512, threads 6, f16 KV, no spec",
    ["--ctx-size", "16654", "--n-cpu-moe", "32", "--batch-size", "2048", "--ubatch-size", "512", "--threads", "6"]);
  // Kitten's current plan, for the same prompt and token count.
  add("kitten-plan", "ctx 32768, ncmoe 31, b4096/ub4096, q8_0 KV, ngram spec",
    ["--ctx-size", "32768", "--n-cpu-moe", "31", "--batch-size", "4096", "--ubatch-size", "4096",
     "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--spec-type", "ngram-mod"]);
  // Which single axis matters? Start from LM Studio and move one thing at a time toward Kitten.
  add("lm-plus-q8kv", "LM Studio settings but q8_0 KV",
    ["--ctx-size", "16654", "--n-cpu-moe", "32", "--batch-size", "2048", "--ubatch-size", "512", "--threads", "6",
     "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  // A small window frees VRAM: does it buy a smaller split, which is where the speed is?
  add("smallctx-ncmoe28", "ctx 16654, ncmoe 28, q8_0 KV, b4096",
    ["--ctx-size", "16654", "--n-cpu-moe", "28", "--batch-size", "4096", "--ubatch-size", "4096",
     "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  add("smallctx-ncmoe26", "ctx 16654, ncmoe 26, q8_0 KV, b4096",
    ["--ctx-size", "16654", "--n-cpu-moe", "26", "--batch-size", "4096", "--ubatch-size", "4096",
     "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  add("smallctx-ncmoe24", "ctx 16654, ncmoe 24, q8_0 KV, b4096",
    ["--ctx-size", "16654", "--n-cpu-moe", "24", "--batch-size", "4096", "--ubatch-size", "4096",
     "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  return list;
}

/** Phase 4: does pinning the weights in RAM (mlock) hold the fast regime? */
function mlockConfigurations() {
  const base = ["--model", MODEL, "--jinja", "--flash-attn", "on", "--no-warmup", "--n-gpu-layers", "999",
    "--ctx-size", "32768", "--n-cpu-moe", "31", "--batch-size", "4096", "--ubatch-size", "4096",
    "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"];
  return [
    { name: "plain-mmap", note: "the shipped plan, mmap as llama.cpp defaults it", args: [...base] },
    { name: "mmap-mlock", note: "the shipped plan + weights pinned in RAM (mlock)", args: [...base, "--load-mode", "mmap+mlock"] },
  ];
}

/**
 * Phase 5: the whole ladder again, in ONE session, all with mmap on.
 *
 * Phase 1 mixed `--load-mode none` configs in with mmap ones, which evicted the page cache between
 * runs — so its absolute numbers were depressed and not comparable across the sweep. With experts on
 * the CPU, decode reads them from RAM every token, and whether those pages are cached is worth ~2x.
 * This phase holds that variable still so the ladder can be read honestly.
 */
function warmLadderConfigurations() {
  const base = ["--model", MODEL, "--jinja", "--cont-batching", "--flash-attn", "on", "--no-warmup",
    "--n-gpu-layers", "999", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"];
  const list = [];
  const add = (name, note, extra) => list.push({ name, note, args: [...base, ...extra] });
  const big = ["--batch-size", "4096", "--ubatch-size", "4096"];

  add("blanket-allcpu", "ctx 32768, every expert on the CPU", ["--ctx-size", "32768", "--cpu-moe", ...big]);
  for (const n of [36, 34, 32, 31, 30, 29, 28]) {
    add(`ncmoe-${n}`, `ctx 32768, experts of ${n}/40 layers on the CPU`, ["--ctx-size", "32768", "--n-cpu-moe", String(n), ...big]);
  }
  add("ncmoe-30-smallbatch", "ctx 32768, ncmoe 30, llama.cpp default batch", ["--ctx-size", "32768", "--n-cpu-moe", "30", "--batch-size", "2048", "--ubatch-size", "512"]);
  add("ncmoe-30-ctx16k", "ctx 16384, ncmoe 30", ["--ctx-size", "16384", "--n-cpu-moe", "30", ...big]);
  add("ncmoe-30-ctx65k", "ctx 65536, ncmoe 30", ["--ctx-size", "65536", "--n-cpu-moe", "30", ...big]);
  return list;
}

/** The configurations under test. Each is a named hypothesis, not a random point in a grid. */
function configurations() {
  const common = ["--model", MODEL, "--jinja", "--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--no-warmup"];
  const ngl = ["--n-gpu-layers", "999"];
  const list = [];
  const add = (name, note, extra) => list.push({ name, note, args: [...common, ...ngl, ...extra] });

  // What Kitten's auto plan does today: take the biggest context the card will hold, which forces
  // every expert onto the CPU. This is the 5 tok/s baseline.
  add("auto-today", "ctx 131072, all experts on CPU (Kitten's current auto)", ["--ctx-size", "131072", "--cpu-moe", "--load-mode", "none"]);
  // The same blanket split at a sane context — isolates how much of the loss is the context alone.
  add("blanket-32k", "ctx 32768, all experts on CPU", ["--ctx-size", "32768", "--cpu-moe", "--load-mode", "none"]);

  // The sweep the research prescribes: modest context, then the fewest CPU expert layers that fit.
  for (const n of [36, 34, 32, 30, 28, 26]) {
    add(`ncmoe-${n}-32k`, `ctx 32768, experts of ${n}/40 layers on CPU`, ["--ctx-size", "32768", "--n-cpu-moe", String(n), "--load-mode", "none"]);
  }
  // Does a smaller context buy a smaller split (and therefore more speed)?
  add("ncmoe-28-16k", "ctx 16384, experts of 28/40 layers on CPU", ["--ctx-size", "16384", "--n-cpu-moe", "28", "--load-mode", "none"]);
  add("ncmoe-26-16k", "ctx 16384, experts of 26/40 layers on CPU", ["--ctx-size", "16384", "--n-cpu-moe", "26", "--load-mode", "none"]);
  // Batch geometry at a good split: the CPU+GPU guides argue the GPU defaults are too small here.
  add("batch-4096", "best split, -b 4096 -ub 4096", ["--ctx-size", "32768", "--n-cpu-moe", "30", "--load-mode", "none", "--batch-size", "4096", "--ubatch-size", "4096"]);
  add("batch-2048-512", "best split, -b 2048 -ub 512", ["--ctx-size", "32768", "--n-cpu-moe", "30", "--load-mode", "none", "--batch-size", "2048", "--ubatch-size", "512"]);
  // mmap left ON, against Kitten's current always-off choice under a CPU split.
  add("mmap-on", "best split, default load mode (mmap)", ["--ctx-size", "32768", "--n-cpu-moe", "30"]);
  // Thread count: the guides say use every core for expert work.
  add("threads-all", "best split, threads = all cores", ["--ctx-size", "32768", "--n-cpu-moe", "30", "--load-mode", "none", "--threads", String(Math.max(1, cpus().length))]);
  return list;
}

async function main() {
  if (!existsSync(SERVER)) throw new Error(`llama-server not found: ${SERVER}`);
  if (!existsSync(MODEL)) throw new Error(`model not found: ${MODEL}`);
  const phase = arg("phase", "1");
  const all = phase === "5" ? warmLadderConfigurations() : phase === "4" ? mlockConfigurations() : phase === "3" ? lmStudioConfigurations() : phase === "2" ? combinedConfigurations() : configurations();
  const wanted = ONLY ? ONLY.split(",").map((n) => Number(n.trim())) : null;
  const selected = wanted ? all.filter((_, i) => wanted.includes(i)) : all;

  const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  console.log(`sweeping ${selected.length} configuration(s), ${GEN_TOKENS} tokens each\n`);

  for (const [index, config] of selected.entries()) {
    process.stdout.write(`[${index + 1}/${selected.length}] ${config.name}: ${config.note}\n`);
    let handle = null;
    const record = { name: config.name, note: config.note, args: config.args.filter((a) => a !== MODEL) };
    try {
      const startedAt = Date.now();
      handle = launch(config.args);
      const ready = await waitForReady(LOAD_TIMEOUT_MS, () => handle.child.exitCode === null);
      if (!ready.ready) {
        record.failed = ready.reason;
        record.stderr = handle.stderr().split("\n").filter((l) => /error|failed|out of memory|cannot/i.test(l)).slice(-3).join(" | ");
        console.log(`      FAILED: ${ready.reason}${record.stderr ? ` — ${record.stderr}` : ""}\n`);
      } else {
        record.loadMs = ready.loadMs;
        // One warm pass then two measured, keeping the better: the first request after load pays
        // for lazy allocations that no later request in a real session would pay again.
        await measure();
        const runs = [await measure(), await measure()];
        const best = runs.sort((a, b) => b.decodePerSecond - a.decodePerSecond)[0];
        Object.assign(record, best);
        record.totalMs = Date.now() - startedAt;
        console.log(`      load ${(ready.loadMs / 1000).toFixed(0)}s · prefill ${best.promptPerSecond.toFixed(1)} tok/s · decode ${best.decodePerSecond.toFixed(2)} tok/s\n`);
      }
    } catch (error) {
      record.failed = error instanceof Error ? error.message : String(error);
      console.log(`      ERROR: ${record.failed}\n`);
    } finally {
      await stop(handle);
    }
    results.push(record);
    writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  const ok = results.filter((r) => !r.failed).sort((a, b) => b.decodePerSecond - a.decodePerSecond);
  console.log("\n=== ranked by decode speed ===");
  for (const r of ok) console.log(`${r.decodePerSecond.toFixed(2)} tok/s  prefill ${String(Math.round(r.promptPerSecond)).padStart(5)} tok/s  ${r.name}  (${r.note})`);
  const failed = results.filter((r) => r.failed);
  if (failed.length) {
    console.log("\n=== did not run ===");
    for (const r of failed) console.log(`${r.name}: ${r.failed}`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
