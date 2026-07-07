import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { CheaterConfig, DoctorCheck, LaunchOptions } from "./types.js";
import { buildPiCommand, formatCommand, resolvePiCommand, resourcePaths } from "./launcher.js";
import { defaultConfigPaths } from "./config.js";
import { inferModelClass } from "./reliability/modelProfile.js";

// HF model-card recommended sampling for Qwen3.x coding-act turns. These are server-side
// (llama.cpp flags / LM Studio per-model defaults) - the harness cannot set them through Pi,
// so doctor surfaces them for the user to configure on the backend.
function samplingRecommendation(model = ""): string {
  const klass = inferModelClass(model);
  if (klass === "unknown") return "coding-act: temp 0.6, top_p 0.95, top_k 20, presence_penalty 0.0; enable preserve_thinking for multi-turn; max_tokens >= 8192";
  return `Qwen ${klass}: coding-act temp 0.6/top_p 0.95/top_k 20/presence 0.0, non-thinking temp 0.7/top_p 0.8/presence 1.5, preserve_thinking on, max_tokens >= 8192, YaRN off`;
}

function configParseCheck(): DoctorCheck {
  const problems: string[] = [];
  for (const path of defaultConfigPaths()) {
    if (!existsSync(path)) continue;
    try {
      JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      problems.push(`${path}: ${(err as Error).message}`);
    }
  }
  return {
    name: "Config files parse",
    ok: problems.length === 0,
    detail: problems.length ? problems.join("; ") : "all config files are valid JSON (or none present)"
  };
}

function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

export function doctorChecks(config: CheaterConfig, options: LaunchOptions, root?: string): DoctorCheck[] {
  const paths = resourcePaths(root);
  const pi = resolvePiCommand(config);
  const node = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
  return [
    { name: "Runtime is resolvable", ok: pi.source !== "fallback", detail: `${pi.source}: ${pi.command.join(" ")}` },
    { name: "Cheater extension exists", ok: existsSync(paths.extension), detail: paths.extension },
    { name: "Cheater prompt exists", ok: existsSync(paths.prompt), detail: paths.prompt },
    { name: "Cheater skills exist", ok: existsSync(paths.skills), detail: paths.skills },
    { name: "Cheater theme exists", ok: existsSync(paths.theme), detail: paths.theme },
    { name: "Current folder readable", ok: canAccess(process.cwd(), constants.R_OK), detail: process.cwd() },
    { name: "Current folder writable", ok: canAccess(process.cwd(), constants.W_OK), detail: process.cwd() },
    { name: "Node is available", ok: node.status === 0, detail: node.stdout.trim() || process.execPath },
    { name: "Runtime entrypoint is Cheater", ok: true, detail: "cheater runs its own bundled runtime with Cheater resources" },
    configParseCheck(),
    { name: "Recommended model sampling (set on backend)", ok: true, detail: samplingRecommendation(config.model) },
    { name: "Resolved launch command", ok: true, detail: formatCommand(buildPiCommand(config, options, root)) }
  ];
}

export function printDoctor(config: CheaterConfig, options: LaunchOptions, root?: string): number {
  const checks = doctorChecks(config, options, root);
  console.log("Cheater doctor");
  console.log(`repo: ${process.cwd()}`);
  for (const check of checks) {
    console.log(`[${check.ok ? "OK" : "FAIL"}] ${check.name}: ${check.detail}`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}
