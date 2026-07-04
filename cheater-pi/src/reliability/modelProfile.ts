import type { BlueprintConfig } from "../blueprint/config.js";
import type { ModelClass, ModelProfile } from "./types.js";

// A handful of extremely common local coding models whose ids are often shipped WITHOUT a
// size token (e.g. "codestral-latest", "deepseek-coder-v2-lite-instruct"). Best-effort only:
// used solely as a fallback when no "<n>b" appears in the name. Kept tiny on purpose - a large
// family table goes stale; the "<n>b" token in the id is the real signal for everything else.
const FAMILY_SIZE_HINTS: Array<[RegExp, number]> = [
  [/codestral/, 22],
  [/deepseek-?coder-?v2-?lite|deepseek.*\blite\b/, 16],
];

/**
 * Approximate parameter count (in billions) parsed from a model name/id, or null when the
 * name carries no reliable size token.
 *
 * Local model ids are polluted by two things that a naive `\d+b` match would misread:
 *   - quantization tags: q4, Q4_K_M, q8_0, iq3_xs, 4bit, fp16, int8 - none of which are the
 *     model's parameter count. A parameter size is always "<n>b" on a trailing word boundary;
 *     "4bit" is "4b"+"it" (no boundary after b) and "q4"/"q4_k" never has a "b" after the digit.
 *   - version numbers: qwen2.5, llama-3.1, qwen3 - the version digits are never followed by "b".
 *
 * Sparse-MoE "NxMb" ids (Mixtral 8x7b / 8x22b) are handled first: the bare expert size (7, 22)
 * badly understates the model, so they map to an effective size that lands 8x7b in `medium`
 * and 8x22b in `large` rather than reading "7b" as a small model.
 */
export function inferParamBillions(name = ""): number | null {
  const lower = name.toLowerCase();

  const moe = lower.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/);
  if (moe) {
    const experts = Number(moe[1]);
    const each = Number(moe[2]);
    if (Number.isFinite(experts) && Number.isFinite(each) && each > 0) {
      // Represent by ~2 active experts' worth (routing quality), floored so a big expert still
      // reads large: 8x7b -> 14 (medium), 8x22b -> 44 (large).
      return Math.max(each * 2, each);
    }
  }

  const matches = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*b\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 2000);
  if (matches.length) return Math.max(...matches);

  for (const [pattern, size] of FAMILY_SIZE_HINTS) {
    if (pattern.test(lower)) return size;
  }
  return null;
}

/**
 * Map a model name to a capability tier across the target band. Coverage is the whole point:
 * before this, only 7/8/9B, 30/32B, and 34/35B were recognized, so Qwen2.5-Coder-14B,
 * Codestral-22B, Gemma-2-27B, DeepSeek-Coder-33B - the bulk of real local coding setups - all
 * fell to "unknown" and got the roomiest snippets with the weakest generic rules, the exact
 * wrong combination. Now every size in range gets a tier tuned to it.
 */
export function inferModelClass(name = ""): ModelClass {
  const billions = inferParamBillions(name);
  if (billions === null) return "unknown";
  if (billions <= 10) return "small";
  if (billions <= 23) return "medium";
  return "large";
}

function packetBudgetFor(klass: ModelClass, config: BlueprintConfig): { soft: number; hard: number } {
  const small = { soft: config.packetContextBudgetTokens9B, hard: config.packetHardContextCeilingTokens9B };
  const large = { soft: config.packetContextBudgetTokensMoE, hard: config.packetHardContextCeilingTokensMoE };
  if (klass === "large") return large;
  if (klass === "medium") {
    return { soft: Math.round((small.soft + large.soft) / 2), hard: Math.round((small.hard + large.hard) / 2) };
  }
  // small AND unknown use the tight budget: an unrecognized model gets under-fed rather than
  // over-fed (it can always inspect more; it cannot un-blow a small context window).
  return small;
}

export function modelProfile(name: string | undefined, config: BlueprintConfig): ModelProfile {
  const klass = inferModelClass(name);
  const budget = packetBudgetFor(klass, config);
  return {
    name: name || "unknown",
    class: klass,
    paramsBillions: inferParamBillions(name),
    packetContextBudget: budget.soft,
    hardContextCeiling: budget.hard,
    maxOutputTokens: klass === "large" ? 700 : klass === "medium" ? 600 : 500
  };
}
