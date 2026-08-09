import type { ChatParams } from "./llm.js";
import type { EffortLevel } from "./effort.js";

export type InferenceRole = "classifier" | "planner" | "executor" | "repair" | "verifier" | "judge" | "sidecar" | "compactor";
export type SamplingMode = "instruct" | "thinking";

export interface InferenceProfile {
  schemaVersion: 1;
  role: InferenceRole;
  temperature: number;
  samplingMode?: SamplingMode;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  dryMultiplier?: number;
  seed?: number;
  reasoningBudget?: number;
  maxTokens: number;
  structuredOutput: boolean;
  logprobs: boolean;
  cachePrompt: boolean;
  /** Provider fields explicitly omitted during capability negotiation, retained for diagnostics. */
  dropped?: string[];
}

export interface InferenceOverrides {
  temperature?: number;
  samplingMode?: SamplingMode;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  dryMultiplier?: number;
  seed?: number;
  reasoningBudget?: number;
  maxTokens?: number;
  structuredOutput?: boolean;
  logprobs?: boolean;
  cachePrompt?: boolean;
}

/** Capability names are deliberately small and optional: absent means unknown, true/false is explicit. */
export type InferenceCapabilities = Partial<Record<"temperature" | "topP" | "topK" | "minP" | "dryMultiplier" | "repeatPenalty" | "presencePenalty" | "seed" | "reasoningBudget" | "maxTokens" | "structuredOutput" | "logprobs" | "cachePrompt", boolean>>;

const ROLE_DEFAULTS: Record<InferenceRole, Omit<InferenceProfile, "schemaVersion" | "role">> = {
  classifier: { temperature: 0, reasoningBudget: 0, maxTokens: 256, structuredOutput: true, logprobs: false, cachePrompt: true },
  planner: { temperature: 0.2, topP: 0.9, topK: 40, minP: 0.05, reasoningBudget: 2_048, maxTokens: 1_200, structuredOutput: true, logprobs: false, cachePrompt: true },
  executor: { temperature: 0.15, topP: 0.95, topK: 40, minP: 0.05, maxTokens: 16_384, structuredOutput: false, logprobs: false, cachePrompt: true },
  repair: { temperature: 0.3, topP: 0.9, topK: 40, minP: 0.05, maxTokens: 16_384, structuredOutput: false, logprobs: false, cachePrompt: true },
  verifier: { temperature: 0, reasoningBudget: 512, maxTokens: 512, structuredOutput: true, logprobs: false, cachePrompt: true },
  judge: { temperature: 0, reasoningBudget: 512, maxTokens: 512, structuredOutput: true, logprobs: false, cachePrompt: true },
  sidecar: { temperature: 0, reasoningBudget: 0, maxTokens: 1_024, structuredOutput: true, logprobs: false, cachePrompt: true },
  compactor: { temperature: 0, reasoningBudget: 0, maxTokens: 1_024, structuredOutput: true, logprobs: false, cachePrompt: true },
};

const EFFORT_BUDGET: Record<EffortLevel, number> = { fast: 512, balanced: 2_048, careful: 8_192, "think-hard": 16_384 };

export function isQwen35Family(model?: string): boolean {
  return typeof model === "string" && /(?:qwen\s*3(?:\.5|\.6)|qwen3[._-]?5|qwen3[._-]?6|kat[-_ ]?coder)/i.test(model);
}

function clampNumber(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

/** Resolve model-family defaults → effort → caller override → capability-safe profile. */
export function resolveInferenceProfile(
  role: InferenceRole,
  effort: EffortLevel = "balanced",
  overrides: InferenceOverrides = {},
  capabilities: InferenceCapabilities = {},
  model?: string,
): InferenceProfile {
  const defaults = ROLE_DEFAULTS[role];
  const qwen35 = isQwen35Family(model);
  const samplingMode: SamplingMode | undefined = qwen35
    ? (overrides.samplingMode ?? (effort === "fast" || effort === "balanced" || role === "classifier" || role === "planner" || role === "sidecar" || role === "compactor" || role === "verifier" || role === "judge" ? "instruct" : "thinking"))
    : overrides.samplingMode;
  const qwenSampling = qwen35 && samplingMode && !["classifier", "verifier", "judge", "sidecar", "compactor"].includes(role)
    ? (samplingMode === "instruct"
      ? (role === "executor" || role === "repair"
        ? { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1 }
        : { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 })
      : (role === "executor" || role === "repair"
        ? { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1 }
        : { temperature: 1.0, topP: 0.95, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 }))
    : {};
  const effortBudget = role === "classifier" || role === "sidecar" || role === "compactor" || role === "verifier" || role === "judge"
    ? defaults.reasoningBudget
    : EFFORT_BUDGET[effort];
  const candidate: InferenceProfile = {
    schemaVersion: 1, role, samplingMode,
    ...defaults,
    reasoningBudget: overrides.reasoningBudget ?? (samplingMode === "instruct" ? 0 : effortBudget),
    temperature: clampNumber(overrides.temperature ?? qwenSampling.temperature ?? defaults.temperature, 0, 2) ?? defaults.temperature,
    topP: clampNumber(overrides.topP ?? qwenSampling.topP ?? defaults.topP, 0, 1),
    topK: clampNumber(overrides.topK ?? qwenSampling.topK ?? defaults.topK, 0, 100_000),
    minP: clampNumber(overrides.minP ?? qwenSampling.minP ?? defaults.minP, 0, 1),
    repeatPenalty: clampNumber(overrides.repeatPenalty ?? qwenSampling.repeatPenalty ?? defaults.repeatPenalty, 0, 3),
    presencePenalty: clampNumber(overrides.presencePenalty ?? qwenSampling.presencePenalty ?? defaults.presencePenalty, 0, 2),
    dryMultiplier: clampNumber(overrides.dryMultiplier ?? defaults.dryMultiplier, 0, 5),
    seed: overrides.seed ?? defaults.seed,
    maxTokens: Math.round(clampNumber(overrides.maxTokens ?? defaults.maxTokens, 1, 131_072) ?? defaults.maxTokens),
    structuredOutput: overrides.structuredOutput ?? defaults.structuredOutput,
    // Open-ended candidates must not pay the logprob tax. Callers can explicitly enable this for a
    // constrained classifier or a short judge tiebreak, but ordinary executor/planner calls stay off.
    logprobs: Boolean(overrides.logprobs) && (role === "classifier" || role === "judge" || role === "verifier"),
    cachePrompt: overrides.cachePrompt ?? defaults.cachePrompt,
  };
  const dropped: string[] = [];
  for (const key of ["temperature", "topP", "topK", "minP", "dryMultiplier", "repeatPenalty", "presencePenalty", "seed", "reasoningBudget", "maxTokens", "structuredOutput", "logprobs", "cachePrompt"] as const) {
    if (capabilities[key] === false) {
      dropped.push(key);
      if (key === "temperature") candidate.temperature = defaults.temperature;
      else if (key === "maxTokens") candidate.maxTokens = defaults.maxTokens;
      else if (key === "structuredOutput") candidate.structuredOutput = false;
      else if (key === "logprobs") candidate.logprobs = false;
      else if (key === "cachePrompt") candidate.cachePrompt = false;
      else delete candidate[key];
    }
  }
  if (dropped.length) candidate.dropped = dropped;
  return candidate;
}

/** Convert the profile into the transport fields understood by KittenLLM. */
export function profileChatParams(profile: InferenceProfile): Pick<ChatParams, "temperature" | "topP" | "topK" | "minP" | "dryMultiplier" | "repeatPenalty" | "presencePenalty" | "seed" | "reasoningBudget" | "maxTokens" | "logprobs" | "cachePrompt"> {
  return {
    temperature: profile.temperature, topP: profile.topP, topK: profile.topK, minP: profile.minP,
    dryMultiplier: profile.dryMultiplier, repeatPenalty: profile.repeatPenalty, presencePenalty: profile.presencePenalty, seed: profile.seed, reasoningBudget: profile.reasoningBudget, maxTokens: profile.maxTokens,
    logprobs: profile.logprobs, cachePrompt: profile.cachePrompt,
  };
}

export const inferenceRoleDefaults = ROLE_DEFAULTS;
