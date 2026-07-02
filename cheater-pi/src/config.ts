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
  runStateEnabled: true
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
