// Kitten Ascent B3 — the Outcome Reward Model (ORM). The single build SWE-Gym proves is worth the most
// and that kitten doesn't have. It learns "what a SOLVED trajectory looks like" from real solves, then
// scores each candidate's P(solved) so the verifier ranks by learned recognition of correct work — the
// harness getting better at recognising correct work directly reduces confident-wrong finishes a user
// receives (the benchmark number and the user-value number stay the same number).
//
// SWE-Gym's recipe: fine-tune to predict YES/NO given (diff + test output + reasoning), rank by the
// NORMALISED logprob of YES. This module is the INFERENCE shim; the offline training pipeline lives in
// training/orm/. Two modes, so it degrades gracefully:
//   - logprob mode (a trained checkpoint served as a model id): P(YES) from token logprobs.
//   - json mode (default, untrained): ask {solved, confidence} — works on any endpoint. This is only a
//     cheap PRIOR, so the ORM is OFF by default (loadOrm returns null); B1+B2 already beat naive
//     selection. It turns on only when a checkpoint is configured, gated on the training run existing.

import type { KittenLLM } from "./llm.js";
import { loadFeatureOrm } from "./ormFeatures.js";

export interface OrmScorer {
  readonly kind: string;
  /** P(this trajectory solved the task), in [0,1]. Never throws; returns 0.5 on failure (no signal). */
  score(trajectory: string, task: string): Promise<number>;
}

const ORM_SCHEMA = {
  name: "orm_verdict",
  schema: {
    type: "object",
    properties: { solved: { type: "boolean" }, confidence: { type: "number" } },
    required: ["solved", "confidence"]
  }
} as const;

function clamp01(x: number): number { return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5; }

/** Best-effort P(YES) from an OpenAI-style logprobs payload (trained-checkpoint path). */
export function yesProbFromLogprobs(raw: unknown): number | null {
  try {
    const content = (raw as any)?.choices?.[0]?.logprobs?.content;
    if (!Array.isArray(content) || !content.length) return null;
    // Look at the first emitted token's top alternatives for YES / NO.
    const top = content[0]?.top_logprobs ?? [content[0]];
    let yes = -Infinity, no = -Infinity;
    for (const t of top) {
      const tok = String(t?.token ?? "").trim().toLowerCase();
      const lp = typeof t?.logprob === "number" ? t.logprob : -Infinity;
      if (tok.startsWith("yes") || tok === "y" || tok === "1") yes = Math.max(yes, lp);
      if (tok.startsWith("no") || tok === "n" || tok === "0") no = Math.max(no, lp);
    }
    if (yes === -Infinity && no === -Infinity) return null;
    const ey = yes === -Infinity ? 0 : Math.exp(yes);
    const en = no === -Infinity ? 0 : Math.exp(no);
    return ey + en > 0 ? ey / (ey + en) : null;
  } catch {
    return null;
  }
}

export interface SidecarOrmOpts {
  /** A trained-checkpoint model id (served by the endpoint). When set, the logprob path is tried. */
  ormModel?: string;
  maxTrajectoryChars?: number;
}

/** ORM backed by the local model. Uses the trained checkpoint (logprobs) if configured, else the 2B json prior. */
export class SidecarOrm implements OrmScorer {
  readonly kind: string;
  constructor(private llm: KittenLLM, private opts: SidecarOrmOpts = {}) {
    this.kind = opts.ormModel ? `trained:${opts.ormModel}` : "sidecar-prior";
  }

  async score(trajectory: string, task: string): Promise<number> {
    const traj = (trajectory || "").slice(0, this.opts.maxTrajectoryChars ?? 4000);
    const prompt =
      `You are an outcome reward model judging whether a coding attempt SOLVED the task.\n\n` +
      `TASK:\n"""${(task || "").slice(0, 800)}"""\n\nATTEMPT (diff + test output + notes):\n"""${traj}"""\n\n` +
      `Did the attempt solve the task?`;

    // Trained-checkpoint path: single YES/NO token with logprobs → normalised P(YES).
    if (this.opts.ormModel) {
      try {
        const r = await this.llm.chat({
          model: this.opts.ormModel,
          messages: [{ role: "user", content: prompt + " Answer with exactly one word: YES or NO." }],
          maxTokens: 4, temperature: 0, logprobs: true, timeoutMs: 30000
        });
        if (r.ok) {
          const p = yesProbFromLogprobs(r.raw);
          if (p !== null) return clamp01(p);
          if (/^\s*yes/i.test(r.content)) return 0.85;
          if (/^\s*no/i.test(r.content)) return 0.15;
        }
      } catch { /* fall through to the json prior */ }
    }

    // Default json prior (untrained): {solved, confidence}. A cheap prior, never the sole final reason.
    try {
      const r = await this.llm.sidecar({
        messages: [{ role: "user", content: prompt + ' Return {"solved": bool, "confidence": 0..1}.' }],
        jsonSchema: ORM_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
        maxTokens: 60, timeoutMs: 30000
      });
      if (r.ok && r.content.trim()) {
        const o = JSON.parse(r.content) as { solved?: boolean; confidence?: number };
        const conf = clamp01(typeof o.confidence === "number" ? o.confidence : 0.5);
        return o.solved ? conf : 1 - conf;
      }
    } catch { /* no signal */ }
    return 0.5;
  }
}

/**
 * Load the ORM. Returns null by default — the ORM is the TOP-END lift, gated on a training run existing;
 * B1+B2 carry the verifier until then. It turns on when, in priority order:
 *   1. a trained FEATURE checkpoint exists (KITTEN_ORM_CHECKPOINT / opts.checkpointPath) — the runnable
 *      proof-of-life ORM (training/orm/), scores with zero model calls;
 *   2. a fine-tuned 2B checkpoint id is configured (KITTEN_ORM_MODEL) — the scaled logprob ORM;
 *   3. `enableUntrainedPrior` is explicitly set (for A/B measuring the cheap json prior alone).
 */
export function loadOrm(llm: KittenLLM, opts: { ormModel?: string; checkpointPath?: string; enableUntrainedPrior?: boolean } = {}): OrmScorer | null {
  const ckptPath = opts.checkpointPath ?? process.env.KITTEN_ORM_CHECKPOINT;
  if (ckptPath) { const fo = loadFeatureOrm(ckptPath); if (fo) return fo; }
  const model = opts.ormModel ?? process.env.KITTEN_ORM_MODEL;
  if (model) return new SidecarOrm(llm, { ormModel: model });
  if (opts.enableUntrainedPrior) return new SidecarOrm(llm, {});
  return null;
}
