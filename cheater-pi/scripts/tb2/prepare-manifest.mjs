#!/usr/bin/env node
/** Freeze the cached TB2 slice without ever pulling an image. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const TASKS = ["cancel-async-tasks", "configure-git-webserver", "db-wal-recovery", "fix-code-vulnerability", "fix-git", "fix-ocaml-gc", "git-leak-recovery", "git-multibranch", "headless-terminal", "kv-store-grpc", "large-scale-text-editing", "sanitize-git-repo"];
const root = resolve(process.env.HARBOR_TASKS_ROOT || "C:/Users/LENOVO/.cache/harbor/tasks");
const out = resolve(process.env.TB2_MANIFEST || "data/benchmarks/tb2-campaign.v1.json");
const kittenBundle = process.env.KITTEN_BUNDLE || "C:/Users/LENOVO/Desktop/tbench-run/tb2-bakeoff/payload/kitten-bundle.tgz";
const opencodeBundle = process.env.OPENCODE_BUNDLE || "C:/Users/LENOVO/Desktop/tbench-run/tb2-bakeoff/payload/opencode-bundle.tgz";
const ompBundle = process.env.OMP_BUNDLE;
const pinnedOmp = JSON.parse(readFileSync(new URL("./omp-asset.json", import.meta.url), "utf8"));

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const taskToml = (id) => {
  const matches = [];
  // Harbor's cache key is opaque, so discover by the leaf directory name.
  const listing = execFileSync("powershell", ["-NoProfile", "-Command", `Get-ChildItem -LiteralPath '${root}' -Recurse -Filter task.toml | Where-Object { $_.Directory.Name -eq '${id}' } | Select-Object -First 1 -ExpandProperty FullName`], { encoding: "utf8" }).trim();
  if (!listing) throw new Error(`cached task is absent: ${id}`);
  const text = readFileSync(listing, "utf8");
  const image = text.match(/docker_image\s*=\s*"([^"]+)"/)?.[1];
  if (!image) throw new Error(`task has no docker_image: ${id}`);
  return { id, image, toml: listing, tomlSha256: sha256File(listing) };
};
const imageDigest = (image) => {
  try {
    return execFileSync("wsl", ["-d", "Ubuntu-24.04", "-u", "root", "--", "docker", "image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { throw new Error(`cached image is absent (refusing to pull): ${image}`); }
};
for (const path of [kittenBundle, opencodeBundle]) if (!existsSync(path)) throw new Error(`agent bundle is absent: ${path}`);
if (!ompBundle || !existsSync(ompBundle)) console.warn(`OMP asset is not local; manifest will pin the remote digest and the campaign will remain unschedulable until it is staged: ${pinnedOmp.url}`);

const tasks = TASKS.map((id) => { const task = taskToml(id); return { id, image: task.image, imageDigest: imageDigest(task.image), taskTomlSha256: task.tomlSha256 }; });
const taskIds = tasks.map((task) => task.id);
const rotate = (offset) => [...taskIds.slice(offset), ...taskIds.slice(0, offset)];
const common = { model: process.env.BENCH_MODEL || "qwen3.6-35b-a3b", webAccess: "off", persistentMemory: false, ceilingSeconds: 900, taskCompiler: "off", fastPath: "off" };
const manifest = {
  schemaVersion: 1, campaignId: "tb2-cached-slice-v1", frozenAt: new Date().toISOString(),
  dataset: { name: "terminal-bench-2", revision: "terminal-bench@2.0", sha256: createHash("sha256").update(tasks.map((task) => task.taskTomlSha256).join("\n")).digest("hex") },
  model: { name: common.model, endpointId: process.env.BENCH_ENDPOINT_ID || "credential-proxy" },
  budgets: { ceilingSeconds: 900, maxModalUsd: 20, maxTransferBytes: 250 * 1024 * 1024 },
  executionOrder: { kitten: rotate(0), opencode: rotate(4), omp: rotate(8) },
  tasks,
  agents: {
    kitten: { version: process.env.KITTEN_VERSION || "0.7.3-dirty-worktree", bundleSha256: sha256File(kittenBundle), adapter: "kitten", configurationSha256: createHash("sha256").update(JSON.stringify({ ...common, agent: "kitten" })).digest("hex") },
    opencode: { version: "1.15.13", bundleSha256: sha256File(opencodeBundle), adapter: "opencode", configurationSha256: createHash("sha256").update(JSON.stringify({ ...common, agent: "opencode" })).digest("hex") },
    omp: { version: "17.2.7", bundleSha256: ompBundle && existsSync(ompBundle) ? sha256File(ompBundle) : pinnedOmp.sha256, adapter: `omp:${pinnedOmp.url}`, configurationSha256: createHash("sha256").update(JSON.stringify({ ...common, agent: "omp" })).digest("hex") },
  },
  resultSchema: "trial-record-v1",
};
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ manifest: out, tasks: tasks.length, images: tasks.length, noPulls: true }, null, 2));
