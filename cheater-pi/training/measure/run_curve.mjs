#!/usr/bin/env node
// Kitten Ascent D1 — the REAL measurement driver. Runs a task set through the full ascent machine at
// each k, oracle-scores every candidate, and prints the pass@1 / pass@k / Best@1 curve. Needs a live
// model (local LM Studio or the Alibaba cloud) + a per-task oracle — this is the user's post-session
// validation; the batteries take hours.
//
// tasks.json: [{ "taskId": "...", "task": "<prompt>", "workspaceDir": "<template dir to copy>",
//                "oracleCmd": "<shell run in the candidate workspace; exit 0 = solved>" }]
//
// Usage:
//   # local LM Studio (ornith):
//   node run_curve.mjs --tasks tasks.json --ks 1,4,16 --out samples.jsonl
//   # cloud burst (same weights, parallel):
//   KITTEN_CLOUD_BASE_URL=... KITTEN_CLOUD_API_KEY=... node run_curve.mjs --tasks tasks.json --ks 1,4,16,50 --cloud

import { spawnSync, } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KittenLLM, DEFAULT_MODELS } from "../../dist/src/core/llm.js";
import { runAscent, ALL_LEVERS } from "../../dist/src/core/ascent.js";
import { runMeasurement, curveFromSamples, renderCurve } from "../../dist/src/core/measure.js";
import { defaultRegistry } from "../../dist/src/core/disjointness.js";
import { loadOrm } from "../../dist/src/core/orm.js";
import { defaultWebAugmentor } from "../../dist/src/core/webAugment.js";
import { cloudBurstConfigFromEnv } from "../../dist/src/core/cloudBurst.js";

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const flag = (name) => process.argv.includes(name);

const tasksPath = arg("--tasks", "tasks.json");
const ks = arg("--ks", "1,4,16").split(",").map(Number);
const outPath = arg("--out", null);
const useCloud = flag("--cloud");

const tasksSpec = JSON.parse(readFileSync(tasksPath, "utf8"));
const registry = defaultRegistry(arg("--swe-manifest", null));
const llm = new KittenLLM(DEFAULT_MODELS);
const cloud = useCloud ? cloudBurstConfigFromEnv() : null;
if (useCloud && !cloud) { console.error("--cloud set but KITTEN_CLOUD_BASE_URL / KITTEN_CLOUD_API_KEY are missing"); process.exit(2); }

const config = {
  llm, registry,
  orm: loadOrm(llm),                      // null unless KITTEN_ORM_CHECKPOINT / KITTEN_ORM_MODEL set
  webAugmentor: defaultWebAugmentor(registry),
  cloudBurst: cloud,
  levers: { ...ALL_LEVERS, cloudBurst: !!cloud }
};

const tasks = tasksSpec.map((t) => ({
  taskId: t.taskId,
  task: t.task,
  freshWorkspace: () => { const d = mkdtempSync(join(tmpdir(), "measure-")); if (t.workspaceDir) cpSync(t.workspaceDir, d, { recursive: true }); return d; }
}));

// Oracle: run the task's oracleCmd in the candidate workspace; exit 0 = solved (behavior, not stdout format).
const oracle = (taskId, workspace) => {
  const t = tasksSpec.find((x) => x.taskId === taskId);
  if (!t?.oracleCmd) return false;
  const r = spawnSync(t.oracleCmd, { cwd: workspace, shell: true, encoding: "utf8", timeout: 120000, windowsHide: true });
  return (r.status ?? 1) === 0;
};

console.error(`[run_curve] ${tasks.length} tasks × k∈{${ks.join(",")}} ${cloud ? "(cloud-burst)" : "(local)"} — this runs the full machine per (task,k)…`);
const samples = await runMeasurement(tasks, {
  ks, oracle, runAscent, config,
  onSample: (s) => console.error(`  ${s.taskId} k=${s.k}: pass@k=${s.candidates.some((c) => c.oracleSolved)} pick=${s.verifierPick}`)
});
if (outPath) writeFileSync(outPath, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
console.log("\n" + renderCurve(curveFromSamples(samples), tasksPath));
