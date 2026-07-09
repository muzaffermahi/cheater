// Kitten Inference P1 — self-certainty: an owned-engine SELECTION signal. When execution consensus
// can't separate the k candidates (the cron failure: all agree but are wrong), rank by how DECISIVE the
// model was while generating each — a confident, low-entropy trajectory is more trustworthy than a
// hesitant one. This needs per-token logprobs, which only an engine kitten OWNS returns (Pi/opencode
// never ask for them on the code turn); the cloud + native llama.cpp both expose them.
//
// CRITICAL (research: self-certainty paper 2502.18581): do NOT rank by mean-logprob / perplexity — it
// prefers short/degenerate output and *underperforms* majority voting. Self-certainty measures distance
// from UNIFORM (peakedness), which rewards a decisive model without the length bias. We approximate it
// from the top-k alternatives per token (the full vocab isn't returned), as the mean over tokens of
// (1 − normalised entropy of the renormalised top-k). Length-invariant (a mean); in [0,1]; higher = more
// certain. Used ONLY as a tiebreaker in the verifier, never as the sole reason a candidate wins (Law 1).

import type { TokenLogprob } from "./llm.js";

/** Mean over tokens of (1 − H(top-k)/log k): how peaked the token distributions were. 0.5 if no data. */
export function selfCertainty(tokens: TokenLogprob[] | undefined): number {
  if (!tokens || !tokens.length) return 0.5;
  let sum = 0, n = 0;
  for (const t of tokens) {
    const alts = t.top && t.top.length ? t.top : [{ token: t.token, logprob: t.logprob }];
    if (alts.length < 2) { sum += 1; n++; continue; } // only one alternative => maximally certain
    // Renormalise the observed top-k probabilities, then measure their entropy vs the max (log k).
    const ps = alts.map((a) => Math.exp(a.logprob));
    const z = ps.reduce((s, p) => s + p, 0) || 1;
    let H = 0;
    for (const p of ps) { const q = p / z; if (q > 0) H -= q * Math.log(q); }
    const Hmax = Math.log(alts.length);
    sum += Hmax > 0 ? Math.max(0, Math.min(1, 1 - H / Hmax)) : 1;
    n++;
  }
  return n ? sum / n : 0.5;
}

/**
 * Accumulate self-certainty across a multi-turn trajectory: a weighted mean by token count, so a long
 * confident stretch counts more than a one-token aside. `chunks` is the per-call logprobs (many turns).
 */
export function aggregateSelfCertainty(chunks: Array<TokenLogprob[] | undefined>): { selfCertainty: number; tokens: number } {
  let weighted = 0, total = 0;
  for (const c of chunks) {
    if (!c || !c.length) continue;
    weighted += selfCertainty(c) * c.length;
    total += c.length;
  }
  return { selfCertainty: total ? weighted / total : 0.5, tokens: total };
}
