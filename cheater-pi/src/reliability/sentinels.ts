import type { BlueprintConfig } from "../blueprint/config.js";
import type { ReliabilityPacketOutputFormat } from "./types.js";

export function sentinelFor(format: ReliabilityPacketOutputFormat, config: BlueprintConfig): string {
  if (format === "patch") return config.patchStopSentinel;
  if (format === "review") return config.reviewStopSentinel;
  return config.jsonStopSentinel;
}

export function stripSentinel(text: string, sentinel: string): { ok: boolean; body: string; repaired: boolean } {
  const index = text.indexOf(sentinel);
  if (index >= 0) return { ok: true, body: text.slice(0, index).trimEnd(), repaired: false };
  return { ok: false, body: text.trimEnd(), repaired: true };
}

export function repairMissingSentinelPrompt(text: string, sentinel: string): string {
  return [
    "Your previous output was incomplete because it did not end with the required stop sentinel.",
    "Return the same logical output in compact form and end with exactly this sentinel:",
    sentinel,
    "",
    text.slice(0, 2000)
  ].join("\n");
}
