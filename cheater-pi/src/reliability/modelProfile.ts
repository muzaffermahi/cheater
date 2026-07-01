import type { BlueprintConfig } from "../blueprint/config.js";
import type { ModelClass, ModelProfile } from "./types.js";

export function inferModelClass(name = ""): ModelClass {
  const lower = name.toLowerCase();
  if (/\b(9b|8b|7b)\b/.test(lower)) return "9b";
  if (/\b(30b|32b)\b/.test(lower)) return "moe30b";
  if (/\b(35b|34b)\b/.test(lower)) return "moe35b";
  return "unknown";
}

export function modelProfile(name: string | undefined, config: BlueprintConfig): ModelProfile {
  const klass = inferModelClass(name);
  const moe = klass === "moe30b" || klass === "moe35b";
  return {
    name: name || "unknown",
    class: klass,
    packetContextBudget: moe ? config.packetContextBudgetTokensMoE : config.packetContextBudgetTokens9B,
    hardContextCeiling: moe ? config.packetHardContextCeilingTokensMoE : config.packetHardContextCeilingTokens9B,
    temperature: moe ? 0.3 : 0.25,
    topP: moe ? 0.92 : 0.88,
    repetitionPenalty: moe ? 1.05 : 1.08,
    frequencyPenalty: moe ? 0.1 : 0.2,
    maxOutputTokens: moe ? 700 : 500
  };
}
