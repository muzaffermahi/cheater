// The /sidecar TUI command: configure the small "clerk" model, its endpoint, and how it overlaps
// the main model - and see what it has actually been doing this session.
//
// Setting a model auto-enables the sidecar (see sidecarConfig). Config is persisted to the
// project's .cheater/config.json so it survives restarts, and mutated in-memory so it takes
// effect on the next task without a restart.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CheaterConfig } from "../types.js";
import { resolveSidecarClient, sidecarConfig } from "./client.js";
import { sidecarScheduler } from "./scheduler.js";
import { calibrationSummary } from "./calibration.js";
import type { SidecarClient } from "./types.js";

type ExtensionAPI = { registerCommand: (name: string, opts: unknown) => void };

function configFile(cwd: string): string {
  return join(resolve(cwd), ".cheater", "config.json");
}

/** Merge a patch into the project's .cheater/config.json (best-effort, never throws). */
function persistConfig(cwd: string, patch: Partial<CheaterConfig>): boolean {
  try {
    const file = configFile(cwd);
    mkdirSync(dirname(file), { recursive: true });
    let current: Record<string, unknown> = {};
    if (existsSync(file)) {
      try { current = JSON.parse(readFileSync(file, "utf8")); } catch { current = {}; }
    }
    writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function statusText(config: CheaterConfig, cwd?: string): string {
  const cfg = sidecarConfig(config);
  const lines = [
    `Cheater sidecar: ${cfg.enabled ? "ON" : "OFF"}`,
    `  model:       ${cfg.modelId ?? "(none - reuses the main model in bounded mode)"}`,
    `  provider:    ${cfg.provider ?? "(main provider)"}`,
    `  endpoint:    ${cfg.baseUrl ?? "(shared with main model)"}`,
    `  parallelism: ${cfg.parallelism}`,
    `  ${sidecarScheduler.summaryLine()}`
  ];
  // Live latch/online line from the last run's client (blank until a run configured a real client).
  const state = sidecarScheduler.stateLine();
  if (state) lines.push(`  ${state}`);
  // Per-job breakdown for this session so the user can see exactly what the clerk did.
  const byType = Object.entries(sidecarScheduler.stats().byType);
  if (byType.length) {
    lines.push("  jobs this session:");
    for (const [type, s] of byType) lines.push(`    ${type}: ${s.hits} used, ${s.fallbacks} ran-live`);
  }
  const calib = cwd ? calibrationSummary(cwd, cfg.modelId ?? "main") : [];
  if (calib.length) lines.push("  learned (prefetch hit-rate by job):", ...calib);
  lines.push("", "Health check anytime with: /sidecar doctor");
  if (!cfg.modelId) {
    lines.push(
      "",
      "Tip: on a single GPU, run the sidecar as a SEPARATE CPU model so it works truly in parallel.",
      "  1) LM Studio: load a 2-4B (e.g. qwen2.5-coder-3b-instruct), GPU layers = 0, start the server.",
      "  2) /sidecar setup <provider> http://localhost:1234/v1 qwen2.5-coder-3b-instruct",
      "  3) /sidecar doctor   (confirm it is ONLINE)",
      "A configured endpoint auto-selects concurrent mode so the clerk never waits for a GPU gap."
    );
  }
  return lines.join("\n");
}

/**
 * Active health probe for /sidecar doctor: run one trivial bounded completion and classify the
 * outcome into a precise, actionable reason. Never throws (complete() is contractually safe). The
 * client is injectable so the classification is testable without a real backend.
 */
export async function sidecarDoctor(config: CheaterConfig, ctx: any, injectedClient?: SidecarClient): Promise<string> {
  const cfg = sidecarConfig(config);
  if (!cfg.enabled) return "Sidecar is OFF. Enable it with `/sidecar on`, or point it at a model: `/sidecar model <id>`.";
  const client = injectedClient ?? resolveSidecarClient(config, ctx);
  if (!client.available()) {
    // resolveSidecarClient returned the null client: enabled, but no model resolved.
    if (!cfg.modelId) return "Sidecar is ON but has NO MODEL and no main-model fallback in this session. Set `/sidecar model <id>`, or use `/sidecar setup <provider> <url> <model>` for a separate CPU server.";
    return `Sidecar model "${cfg.modelId}" could not be resolved (provider "${cfg.provider ?? "?"}"${cfg.baseUrl ? `, endpoint ${cfg.baseUrl}` : ", no endpoint"}). For a local server no auth is needed - set the endpoint: \`/sidecar endpoint http://localhost:1234/v1\`. For a cloud provider, configure its auth first.`;
  }
  const res = await client.complete({ system: "You are a health probe.", prompt: "Reply with exactly: OK", maxOutputTokens: 8, timeoutMs: cfg.timeoutMs, label: "doctor" });
  if (res.ok) return `Sidecar ONLINE: model ${res.modelId ?? cfg.modelId ?? "(main)"}, ${res.elapsedMs}ms round-trip, parallelism "${cfg.parallelism}". The clerk is ready to work ahead.`;
  const err = res.error;
  if (/timed out/.test(err)) return `Sidecar TIMED OUT after ${cfg.timeoutMs}ms - the model is slow or still loading. Wait a moment and retry, or raise the timeout with \`/sidecar timeout <ms>\`. (${err})`;
  if (/session failed/.test(err)) return `Sidecar ENDPOINT UNREACHABLE. Is the CPU server running${cfg.baseUrl ? ` at ${cfg.baseUrl}` : " (no endpoint configured)"}? Start it (LM Studio / llama.cpp), then retry \`/sidecar doctor\`. (${err})`;
  if (/no resolvable model/.test(err)) return `Sidecar has NO RESOLVABLE MODEL - check the provider/model id and its auth. (${err})`;
  return `Sidecar FAILED its health probe: ${err}. It will self-heal and re-probe on the next task if this was transient.`;
}

export function registerSidecarCommands(pi: ExtensionAPI, config: CheaterConfig): void {
  pi.registerCommand("sidecar", {
    description: "Configure the 2-4B sidecar model (offloads chores + works ahead of the main model). /sidecar [status|doctor|setup <provider> <url> <model>|model <id>|endpoint <url>|provider <name>|mode <gap|concurrent|off>|timeout <ms>|on|off]",
    handler: async (args: string, ctx: any) => {
      const notify = (text: string) => { try { ctx?.ui?.notify?.(text, "info"); } catch { /* ignore */ } };
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "status").toLowerCase();
      const rest = parts.slice(1).join(" ").trim();

      const apply = (patch: Partial<CheaterConfig>, message: string) => {
        Object.assign(config, patch);                       // take effect on the next task
        const saved = persistConfig(ctx.cwd, patch);        // survive restarts
        notify(`${message}${saved ? "" : " (could not persist to .cheater/config.json)"}\n\n${statusText(config, ctx.cwd)}`);
      };

      switch (sub) {
        case "doctor":
          return notify(await sidecarDoctor(config, ctx));
        case "setup": {
          // One-shot: point the sidecar at a separate (CPU) endpoint in one command. Setting a
          // baseUrl makes sidecarConfig auto-select concurrent mode (see client.ts).
          const [prov, url, ...modelParts] = rest.split(/\s+/).filter(Boolean);
          const modelId = modelParts.join(" ");
          if (!prov || !url || !modelId) {
            return notify("Usage: /sidecar setup <provider> <endpoint-url> <model-id>\n  e.g. /sidecar setup openai http://localhost:1234/v1 qwen2.5-coder-3b-instruct\nThen run /sidecar doctor to confirm it is ONLINE.");
          }
          return apply(
            { sidecarProvider: prov, sidecarBaseUrl: url, sidecarModel: modelId, sidecarEnabled: true },
            `Sidecar configured: "${modelId}" @ ${url} (provider ${prov}), concurrent mode. Run /sidecar doctor to verify.`
          );
        }
        case "model":
          if (!rest) return notify("Usage: /sidecar model <model-id>  (auto-enables the sidecar)");
          return apply({ sidecarModel: rest, sidecarEnabled: true }, `Sidecar model set to "${rest}" and enabled.`);
        case "endpoint":
          return apply({ sidecarBaseUrl: rest || undefined }, rest ? `Sidecar endpoint set to ${rest}.` : "Sidecar endpoint cleared (shares the main model's).");
        case "provider":
          return apply({ sidecarProvider: rest || undefined }, rest ? `Sidecar provider set to ${rest}.` : "Sidecar provider cleared.");
        case "mode":
          if (!["gap", "concurrent", "off"].includes(rest)) return notify("Usage: /sidecar mode <gap|concurrent|off>");
          return apply({ sidecarParallelism: rest as "gap" | "concurrent" | "off" }, `Sidecar parallelism set to "${rest}".`);
        case "timeout": {
          const ms = Number(rest);
          if (!Number.isFinite(ms) || ms <= 0) return notify("Usage: /sidecar timeout <milliseconds>  (e.g. 20000 for a slow CPU model)");
          return apply({ sidecarTimeoutMs: Math.round(ms) }, `Sidecar per-call timeout set to ${Math.round(ms)}ms.`);
        }
        case "on":
          return apply({ sidecarEnabled: true }, "Sidecar enabled.");
        case "off":
          return apply({ sidecarEnabled: false }, "Sidecar disabled.");
        case "status":
        default:
          return notify(statusText(config, ctx.cwd));
      }
    }
  });
}
