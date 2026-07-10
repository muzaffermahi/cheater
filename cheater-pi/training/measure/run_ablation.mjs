#!/usr/bin/env node
// Kitten Ascent D3/D2 — the ablation ledger on the HELD-OUT set. Runs the machine all-levers-on, then
// once per lever with that lever OFF, and reports each lever's marginal Best@1. Because it runs on the
// held-out set (registered in the disjointness firewall so no store/skill/web can touch it), a positive
// marginal here is a REAL, transferable gain (Law 6). Needs a live model + oracles.
//
// Usage: node run_ablation.mjs --tasks heldout.json --ks 16 [--cloud]

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KittenLLM, DEFAULT_MODELS } from "../../dist/src/core/llm.js";
import { runAscent, ALL_LEVERS } from "../../dist/src/core/ascent.js";
import { runMeasurement } from "../../dist/src/core/measure.js";
import { runAblation, renderAblation } from "../../dist/src/core/ablation.js";
import { defaultRegistry } from "../../dist/src/core/disjointness.js";
import { registerHeldOut } from "../../dist/src/core/heldout.js";
import { loadOrm } from "../../dist/src/core/orm.js";
import { defaultWebAugmentor } from "../../dist/src/core/webAugment.js";
import { cloudBurstConfigFromEnv } from "../../dist/src/core/cloudBurst.js";

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const flag = (name) => process.argv.includes(name);

const tasksSpec = JSON.parse(readFileSync(arg("--tasks", "heldout.json"), "utf8"));
const ks = arg("--ks", "16").split(",").map(Number);
const cloud = flag("--cloud") ? cloudBurstConfigFromEnv() : null;

const registry = defaultRegistry();
// D2: the held-out set is registered so the firewall refuses to let any store/skill/web touch it.
registerHeldOut(registry, tasksSpec.map((t) => t.taskId), Object.fromEntries(tasksSpec.map((t) => [t.taskId, t.task])));

const llm = new KittenLLM(DEFAULT_MODELS);
const baseConfig = { llm, registry, orm: loadOrm(llm), webAugmentor: defaultWebAugmentor(registry), cloudBurst: cloud };

const tasks = tasksSpec.map((t) => ({
  taskId: t.taskId, task: t.task,
  freshWorkspace: () => { const d = mkdtempSync(join(tmpdir(), "abl-")); if (t.workspaceDir) cpSync(t.workspaceDir, d, { recursive: true }); return d; }
}));
const oracle = (taskId, ws) => { const t = tasksSpec.find((x) => x.taskId === taskId); if (!t?.oracleCmd) return false; return (spawnSync(t.oracleCmd, { cwd: ws, shell: true, encoding: "utf8", timeout: 120000, windowsHide: true }).status ?? 1) === 0; };

const measure = (levers) => runMeasurement(tasks, { ks, oracle, runAscent, config: { ...baseConfig, levers } });

console.error(`[run_ablation] leave-one-out over ${tasks.length} held-out tasks at k∈{${ks.join(",")}} — one full sweep per lever…`);
const { rows, allOnBest1 } = await runAblation({ measure, allLevers: { ...ALL_LEVERS, cloudBurst: !!cloud } });
console.log("\n" + renderAblation(rows, allOnBest1));
