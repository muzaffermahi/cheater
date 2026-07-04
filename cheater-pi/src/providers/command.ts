// /provider-probe: measure whether the configured LM Studio endpoint offers native STATEFUL chat
// (response_id / previous_response_id) and TTFT/token stats. This is a standalone fetch probe - it
// never rewires Pi's provider - and it reports only what it measured (no KV-cache claims). The point
// is to know whether prompt-cache-like behaviour actually helps before trusting it.

import type { CheaterConfig } from "../types.js";
import { providerProbeBaseUrl, runProviderProbe } from "./lmStudioStateful.js";

type ExtensionAPI = { registerCommand: (name: string, opts: unknown) => void };

export function registerProviderCommands(pi: ExtensionAPI, config: CheaterConfig): void {
  pi.registerCommand("provider-probe", {
    description: "Probe the configured LM Studio endpoint for native stateful chat + TTFT/token stats (standalone fetch; does not rewire Pi). /provider-probe [bench]",
    handler: async (args: string, ctx: any) => {
      const notify = (text: string) => { try { ctx?.ui?.notify?.(text, "info"); } catch { /* ignore */ } };
      const baseUrl = providerProbeBaseUrl(config);
      if (!baseUrl) {
        return notify("No endpoint to probe. Cheater can't see the main model's endpoint (Pi owns it), so set one to measure:\n  /sidecar endpoint http://localhost:1234  (reused), or add \"lmStudioBaseUrl\" to .cheater/config.json\nThen retry /provider-probe.");
      }
      const benchmark = (args ?? "").trim().toLowerCase() === "bench";
      notify(`Probing ${baseUrl}${benchmark ? " with a fixed-prefix reuse benchmark" : ""} ...`);
      const cap = await runProviderProbe(config, { benchmark });
      if (!cap) return notify("Probe skipped (no base URL resolved).");
      const lines = [
        `Provider probe: ${cap.provider} @ ${cap.baseUrl}`,
        `  native /api/v1/chat (stateful): ${cap.statefulChatAvailable ? "AVAILABLE" : "unavailable/unknown"}`,
        `  response_id follow-up:          ${cap.responseIdSupported ? "works (stateful confirmed)" : "no"}`,
        `  /v1/chat/completions:           treated STATELESS (per LM Studio docs) unless proven`,
        `  per-call stats:                 ${cap.statsAvailable ? `TTFT ${cap.ttftSeconds ?? "?"}s, ${cap.tokensPerSecond ?? "?"} tok/s, input ${cap.inputTokens ?? "?"} tok` : "unavailable"}`,
        `  measured prefix-reuse benefit:  ${cap.measuredPrefixReuseBenefit} (observation only; not proof of KV-cache reuse)`,
        ...cap.notes.map((n) => `  - ${n}`)
      ];
      notify(lines.join("\n"));
    }
  });
}
