import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheaterConfig } from "./types.js";
import { DEFAULT_BLUEPRINT_CONFIG } from "./blueprint/config.js";

export const VERSION = "0.7.0";

export const DEFAULT_CONFIG: CheaterConfig = {
  gymEnabled: true,
  gymDefaultLimit: 5,
  gymDefaultConcurrency: 1,
  gymTempDir: ".cheater/gym/runs",
  gymKeepWorkspaces: false,
  gymRunFullTests: "if_cheap",
  gymAutoLearn: false,
  gymDeltaModeEnabled: false,
  ...DEFAULT_BLUEPRINT_CONFIG,
  blueprintOfficialDocsSearchEnabled: false,
  // Durable run state (contract, digest, ledgers, capsules, phase control, post-success
  // guard) under .cheater/runs/<taskId>/. Deterministic and local-only; on by default.
  runStateEnabled: true,
  // Promoted from the underexplored-but-built set (28th session flag review):
  // - mainCallGovernor: PURE telemetry (call-economy receipt of big-model calls made vs avoided) -
  //   byte-identical behavior, zero risk, and it surfaces exactly the "call the big model less" metric
  //   this project optimizes. Safe to leave on.
  // - typeCheckGate: safe-by-design correctness gate - only ever blocks a NEW type error the model's
  //   OWN change introduced in a changed .ts file, is escapable (routes to the bounded repair path),
  //   and no-ops when there is no typechecker / it times out / no TS files changed. High value for a
  //   TS-first workflow. Reversible via config. (typeCheckGateBlocking:false makes it warn-only.)
  mainCallGovernorEnabled: true,
  typeCheckGateEnabled: true,
  // Promoted after a LIVE 3-way A/B (vite-ab/, 2 rounds): on a from-scratch Vite/React/TS build,
  // stamping the recognized-stack boilerplate (config/entry/index.css) made the model ~22% FASTER
  // (297s vs 382s avg) with fewer turns and ZERO build regressions - it decodes only app logic.
  // Safe-by-design: additive, only fires for a recognized stack, no-op otherwise.
  scaffoldTemplatesEnabled: true,
  // ADAPTIVE best-of-N (promote-A rule): the pass@k A/B decided A>B - independent samples + an
  // execution-verified selector took ornith 0.33 -> 1.00 on a hard single-file task. Promoted
  // ADAPTIVELY so it stays speed-safe on easy tasks: adaptiveCompute scales k by hardness and the
  // in-session resampler EARLY-EXITS on the first verified sample, so an easy single-file commitlet
  // runs exactly k=1 (no overhead), while a hard one gets up to adaptiveMaxSamples independent tries.
  // Fires only on single-file commitlets in the in-session (simulated) lane. maxSamples 3 keeps the
  // hardest commitlet inside the ~15-min local budget.
  adaptiveComputeEnabled: true,
  inSessionResampleEnabled: true,
  adaptiveMaxSamples: 3
};

export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (basename(here) === "src" && basename(dirname(here)) === "dist") {
    return resolve(here, "..", "..");
  }
  if (basename(here) === "src") return resolve(here, "..");
  return resolve(here, "..");
}

export function defaultConfigPaths(cwd = process.cwd()): string[] {
  return [
    join(homedir(), ".config", "cheater", "config.json"),
    join(cwd, ".cheater", "config.json")
  ];
}

export function loadConfig(cwd = process.cwd()): CheaterConfig {
  const merged: CheaterConfig = { ...DEFAULT_CONFIG };
  for (const path of defaultConfigPaths(cwd)) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as CheaterConfig;
      Object.assign(merged, parsed);
    } catch {
      // Bad user config should be reported by doctor, not crash startup.
    }
  }
  if (process.env.CHEATER_PI_COMMAND) merged.piCommand = process.env.CHEATER_PI_COMMAND;
  if (process.env.CHEATER_PI_PATH) merged.piCommand = process.env.CHEATER_PI_PATH;
  if (process.env.CHEATER_SEARXNG_BASE_URL) {
    merged.searxngBaseUrl = process.env.CHEATER_SEARXNG_BASE_URL;
    merged.blueprintDocsProvider = "searxng";
    merged.blueprintOfficialDocsSearchEnabled = true;
  }
  if (process.env.CHEATER_BLUEPRINT_FETCH_DOCS === "1") {
    merged.blueprintOfficialDocsSearchEnabled = true;
    merged.blueprintFetchDocsPages = true;
  }
  return merged;
}
