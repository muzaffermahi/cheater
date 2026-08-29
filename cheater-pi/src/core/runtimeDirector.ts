import type { InferenceCapabilities, InferenceOverrides, InferenceProfile, InferenceRole } from "./inferenceProfiles.js";
import { profileChatParams, resolveInferenceProfile } from "./inferenceProfiles.js";
import type { EffortLevel } from "./effort.js";

/** The phases Kitten exposes to the product. A phase is a contract, not a second agent. */
export type InferencePhase = "inspect" | "plan" | "act" | "repair" | "judge" | "answer" | "compact";
export type RuntimeOwnership = "managed-native" | "external-compatible";

export interface BootProfile {
  ownership: RuntimeOwnership;
  model: string;
  contextTokens?: number;
  batchSize?: number;
  ubatchSize?: number;
  threads?: number;
  gpuLayers?: number;
  parallelSlots?: number;
  jinja?: boolean;
  templateHash?: string;
  runtimeRecipe?: string;
  /** Fields acknowledged by a live runtime probe (/props, /slots, or an equivalent provider receipt). */
  verifiedControls?: readonly string[];
}

export interface InferenceContract {
  phase: InferencePhase;
  role: InferenceRole;
  profile: InferenceProfile;
  transport: ReturnType<typeof profileChatParams>;
  model?: string;
  templateKwargs?: Record<string, unknown>;
}

export interface RuntimeReceipt {
  phase: InferencePhase;
  role: InferenceRole;
  ownership: RuntimeOwnership;
  requested: Record<string, unknown>;
  applied: Record<string, unknown>;
  dropped: string[];
  unverifiable: string[];
  evidence: "verified" | "sent-only";
  templateHash?: string;
  recipe?: string;
}

const PHASE_ROLE: Record<InferencePhase, InferenceRole> = {
  inspect: "classifier",
  plan: "planner",
  act: "executor",
  repair: "repair",
  judge: "judge",
  answer: "executor",
  compact: "compactor",
};

/** One place where phase → model controls are resolved. No caller should hand-roll sampler fields. */
export function contractForPhase(
  phase: InferencePhase,
  effort: EffortLevel = "balanced",
  overrides: InferenceOverrides = {},
  capabilities: InferenceCapabilities = {},
  model?: string,
): InferenceContract {
  const role = PHASE_ROLE[phase];
  const profile = resolveInferenceProfile(role, effort, overrides, capabilities, model);
  return { phase, role, profile, transport: profileChatParams(profile), model };
}

/** Produce a truthful receipt: unknown external providers are never reported as applied/verified. */
export function receiptFor(contract: InferenceContract, boot: BootProfile, sent: Record<string, unknown> = {}): RuntimeReceipt {
  const requested = { ...contract.transport, ...sent };
  const dropped = contract.profile.dropped ?? [];
  const applied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(requested)) if (!dropped.includes(key) && value !== undefined) applied[key] = value;
  const native = boot.ownership === "managed-native";
  const verified = new Set(boot.verifiedControls ?? []);
  // Ownership tells us who launched the process, not whether this particular request was accepted.
  // Only explicit runtime evidence upgrades a field from sent-only to verified.
  const unverifiable = Object.keys(applied).filter((key) => !verified.has(key));
  return {
    phase: contract.phase, role: contract.role, ownership: boot.ownership,
    requested, applied, dropped, unverifiable,
    evidence: native && unverifiable.length === 0 ? "verified" : "sent-only",
    ...(boot.templateHash ? { templateHash: boot.templateHash } : {}),
    ...(boot.runtimeRecipe ? { recipe: boot.runtimeRecipe } : {}),
  };
}

export function phaseForAgent(name?: string): InferencePhase {
  switch ((name ?? "general").toLowerCase()) {
    case "explore": case "architect": case "security": case "docs": return "inspect";
    case "verify": case "test": case "release": return "judge";
    case "review": return "judge";
    case "debug": return "repair";
    case "compact": return "compact";
    case "title": return "inspect";
    default: return "act";
  }
}
