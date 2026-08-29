#!/usr/bin/env node
/** Create an evidence-only available subset without pulling a missing cached image. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const input = resolve(process.env.TB2_MANIFEST || "data/benchmarks/tb2-campaign.v1.json");
const output = resolve(process.env.TB2_AVAILABLE_MANIFEST || "data/benchmarks/tb2-campaign-available.v1.json");
const manifest = JSON.parse(readFileSync(input, "utf8"));
const available = manifest.tasks.filter((task) => {
  try { execFileSync("wsl", ["-d", "Ubuntu-24.04", "-u", "root", "--", "docker", "image", "inspect", task.image], { stdio: "ignore" }); return true; }
  catch { return false; }
});
const ids = new Set(available.map((task) => task.id));
const filtered = {
  ...manifest,
  campaignId: `${manifest.campaignId}-available`,
  tasks: available,
  executionOrder: Object.fromEntries(Object.entries(manifest.executionOrder).map(([agent, order]) => [agent, order.filter((id) => ids.has(id))])),
  excludedTasks: manifest.tasks.filter((task) => !ids.has(task.id)).map((task) => ({ id: task.id, image: task.image, imageDigest: task.imageDigest })),
};
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, `${JSON.stringify(filtered, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, available: available.length, excluded: filtered.excludedTasks.map((task) => task.id), noPulls: true }, null, 2));

