// How Kitten decides what to hand llama.cpp — derived from measurement, not from optimism.
//
// The old auto plan asked one question ("what is the largest context this card will hold?") and let
// the answer determine everything else. On a 24.7 GB MoE against 8.6 GB of VRAM that produced a
// 131072-token window, a KV cache that ate the card, and every expert evicted to system RAM. Measured
// on that machine: 10.9 tok/s decode, 86 tok/s prefill. Hand-tuning beat it by ~30%, and the user who
// did it by hand landed on exactly the split the sweep later found.
//
// The sweep (scripts/llama-tuning-sweep.mjs, 30 configurations on an RTX 4060 8 GB / 40-layer 35B).
// The numbers below are from the WARM ladder — one session, mmap throughout — because an early pass
// mixed mmap-disabled configs in with mmap ones and evicted the page cache between runs, which
// depressed every absolute figure by roughly half. The ordering survived; the magnitudes did not.
//
//   blanket 20.2    ncmoe 36 → 21.0    ncmoe 34 → 22.1    ncmoe 30 → 32.1    ncmoe 29 → 10.5
//
// Three facts came out of it, and this module exists to encode them:
//
//   1. THE CLIFF IS REAL AND SHARP. One layer past the optimum, throughput does not degrade — it
//      collapses (13.7 → 9.8, and prefill 108 → 42) because the driver starts spilling to shared
//      memory. So the estimate must approach the edge from the SAFE side and stop short of it.
//   2. CONTEXT IS NOT FREE, AND IT IS NOT THE GOAL. Every token of window is VRAM an expert could
//      have used. A smaller window did not rescue a bad split (28 was just as slow at 16k as at 32k),
//      so context should be sized to what the work needs and no further.
//   3. VRAM SPENT ANYWHERE ELSE IS VRAM THE EXPERTS DO NOT GET. This is the same fact as (2) wearing
//      a different hat, and it is why forcing a 4096 batch — which sounded right, and which an early
//      sweep appeared to support — cost 2.3x: its compute buffer pushed the split over the cliff.
//      llama.cpp's own defaults win. Disabling mmap (which llama.cpp advises under CPU overrides)
//      also loses: 24s of load against 8s, for no decode gain.

import type { GgufKvMeta } from "./modelRuntime.js";

/** What the machine and the model are, in the only terms this decision needs. */
export interface TuningInputs {
  /** Size of the weights on disk, which is what has to fit somewhere. */
  modelBytes: number;
  /** VRAM of the device that will hold them. */
  vramBytes?: number;
  /** System RAM, which is where the evicted experts land. */
  ramBytes?: number;
  /** Layer count and KV geometry from the model's own header, when it could be read. */
  meta?: GgufKvMeta | null;
  /** Bytes of KV cache per context token for the chosen cache type. */
  kvBytesPerToken?: number;
  /** An explicit context pin from settings; absent means "choose one". */
  contextTokens?: number;
  /** True when the weights are a mixture-of-experts model, i.e. when a split is even possible. */
  mixtureOfExperts?: boolean;
}

export interface TuningPlan {
  contextTokens: number;
  /** Layers to place in VRAM. "all" is llama.cpp's 999; a number is a dense model that does not fit. */
  gpuLayers: number | "all";
  /** Layers whose experts run on the CPU. 0 = everything stays on the GPU; null = no split possible. */
  cpuMoeLayers: number | null;
  /** True when even a full split will not fit, so the blanket flag is the only option. */
  blanketCpuMoe: boolean;
  batchSize: number;
  ubatchSize: number;
  /** `--load-mode`, or null to leave llama.cpp's default alone. */
  loadMode: "mmap+mlock" | null;
  /** Why each choice was made, in the user's terms. These reach the settings panel verbatim. */
  reasons: string[];
}

/**
 * The context a coding agent actually works in.
 *
 * Bigger is not better here — it is VRAM taken from the experts, and the sweep showed the experts pay
 * for it in throughput. 32k holds a substantial file, its neighbours and a working history, which is
 * the shape of the work; beyond that the window is mostly unused most of the time.
 */
export const WORKING_CONTEXT_TOKENS = 32768;

/** The smallest window in which agent work is still viable. Never size below this to buy speed. */
export const MINIMUM_WORKING_CONTEXT = 16384;

/**
 * Share of a MoE model's weight that lives in its expert tensors.
 *
 * A 35B-A3B-class model activates ~3B of 35B per token: the dense path (attention, embeddings, norms)
 * is a small minority of the file. 0.92 reproduces the measured optimum on the reference machine
 * within one layer. It is an estimate of a real physical quantity, and it is labelled as one — the
 * calibration pass below exists precisely because an estimate is not a measurement.
 */
const EXPERT_SHARE = 0.92;

/**
 * VRAM the display, the driver and other applications need, plus the scratch llama.cpp allocates for
 * the batch. Both are back-solved from the reference machine rather than guessed: at the measured
 * optimum (10 of 40 expert layers resident, 32k of q8_0 cache) the card had roughly 0.2-0.3 GB spare,
 * so an allowance near 0.6 GB is conservative without being timid. Earlier values totalling 0.9 GB
 * cost three layers — about 10% of throughput — for safety that was already covered twice over.
 */
const DEVICE_RESERVE_BYTES = 0.25e9;
const COMPUTE_BUFFER_BYTES = 0.35e9;

/**
 * Extra layers to stay back from the cliff, beyond the allowance above.
 *
 * Zero, deliberately. The asymmetry is brutal — one layer too far costs 30% and a prefill collapse,
 * one layer too shy costs a few percent — but the reserve constants already provide that margin, and
 * stacking a second one on top is how the estimate ended up three layers short of the optimum.
 * Calibration is what closes the remaining gap, because only a measurement can.
 */
const CLIFF_MARGIN_LAYERS = 0;

/**
 * Batch geometry: llama.cpp's own, deliberately.
 *
 * An earlier version of this forced 4096/4096, on the strength of a guide arguing that the defaults
 * are sized for pure-GPU inference and too small once experts stream over PCIe. The first sweep
 * seemed to agree — 108 → 173 tok/s prefill. It was measuring the wrong thing.
 *
 * A physical batch of 4096 allocates a compute buffer several times larger than the default one, and
 * on a card that is already full that buffer is exactly what pushes the split over the edge. Measured
 * on the reference machine, same 30-layer split, same 32k window, back to back in one warm session:
 *
 *     llama.cpp default batch   32.12 tok/s decode, 186 tok/s prefill
 *     forced 4096/4096          14.27 tok/s decode, 172 tok/s prefill
 *
 * Not a regression of a few percent — a factor of 2.3, and the prefill it was supposed to buy was
 * worse too. The VRAM this frees is worth far more as resident experts than as batch scratch.
 */
const MOE_BATCH = 0;

/**
 * Pin the weights in RAM via `--load-mode mmap+mlock` — but only with room to spare.
 *
 * With experts on the CPU, decode reads them from system memory on every token, so residency is not a
 * detail: measured back to back, 23.5 tok/s pinned against 20.4 unpinned, and the unpinned figure
 * swung between 13.7 and 25.1 across sessions purely on what the page cache happened to hold.
 *
 * The threshold is 2x, not the 1.25x a first version used, and that number was paid for. At 1.25x
 * (24.7 GB of weights on a 34 GB machine) the launch DIED mid-load — the server's last words were
 * `load_model: loading model` and then nothing, because locking that many pages alongside the sidecar,
 * the engine and a desktop leaves the machine nothing to work with. A runtime that will not start is
 * infinitely worse than one that is 15% slower, so the gate is set where the trade is not close.
 */
const MLOCK_RAM_HEADROOM = 2.0;
const MLOCK_SPARE_RAM_BYTES = 8e9;

/**
 * Decide everything at once, because the decisions are coupled: context costs VRAM, VRAM decides the
 * split, and the split decides throughput. Choosing them in sequence is what produced the 131072-token
 * window that made the model crawl.
 */
export function planTuning(input: TuningInputs): TuningPlan {
  const reasons: string[] = [];
  const layers = input.meta?.blockCount ?? 0;
  const trained = input.meta?.contextLength;
  const isMoe = input.mixtureOfExperts ?? true;

  // ── 1. Context: what the work needs, clamped to what the model was trained for ─────────────────
  let contextTokens: number;
  if (input.contextTokens && input.contextTokens > 0) {
    contextTokens = input.contextTokens;
    reasons.push(`Context pinned to ${count(contextTokens)} tokens.`);
  } else {
    contextTokens = WORKING_CONTEXT_TOKENS;
    if (trained && trained < contextTokens) {
      contextTokens = Math.max(MINIMUM_WORKING_CONTEXT, trained);
      reasons.push(`Context ${count(contextTokens)} — the most this model was trained for.`);
    } else {
      reasons.push(`Context ${count(contextTokens)} — sized for the work, so the rest of the card can hold experts.`);
    }
  }

  // Zero means "say nothing and let llama.cpp choose", which is what the measurement supports.
  const batchSize = MOE_BATCH;
  const ubatchSize = MOE_BATCH;
  const ram = input.ramBytes ?? 0;
  const canPin = ram > 0 && input.modelBytes > 0
    && ram > input.modelBytes * MLOCK_RAM_HEADROOM
    && ram - input.modelBytes > MLOCK_SPARE_RAM_BYTES;
  const loadMode: "mmap+mlock" | null = canPin ? "mmap+mlock" : null;
  if (canPin) reasons.push("Weights pinned in RAM, so the CPU-side experts are never paged out mid-run.");
  const vram = input.vramBytes ?? 0;
  const kvPerToken = input.kvBytesPerToken ?? 0;
  const pinned = Boolean(input.contextTokens && input.contextTokens > 0);

  if (vram <= 0 || layers <= 0 || input.modelBytes <= 0) {
    // Without a layer count there is no partial split to compute. That is not a reason to evict every
    // expert: if the sizes are known and the weights comfortably fit the card, they should simply stay
    // on it. The blanket split is for weights that genuinely do not fit.
    const mightNotFit = vram <= 0 || input.modelBytes <= 0 || input.modelBytes > vram * 0.8;
    reasons.push(mightNotFit
      ? "The model's layer count could not be read, so every expert runs on the CPU rather than risking a launch that does not fit."
      : `${gb(input.modelBytes)} of weights fit ${gb(vram)} of VRAM comfortably; nothing is offloaded.`);
    return { contextTokens, gpuLayers: "all", cpuMoeLayers: null, blanketCpuMoe: isMoe && mightNotFit, batchSize, ubatchSize, loadMode, reasons };
  }

  /** VRAM left for weights once the window, the scratch and the display have taken their share. */
  const roomForWeights = (tokens: number): number =>
    vram - kvPerToken * tokens - COMPUTE_BUFFER_BYTES - DEVICE_RESERVE_BYTES;

  /**
   * Grow the window while it costs nothing — free capacity, taken only when it is genuinely free.
   * `stillFits` decides what "free" means for the model in hand.
   */
  const growWindow = (from: number, stillFits: (tokens: number) => boolean): number => {
    if (pinned || kvPerToken <= 0) return from;
    let chosen = from;
    for (const rung of CONTEXT_LADDER) {
      if (rung <= chosen) continue;
      if (trained && rung > trained) break;
      if (!stillFits(rung)) break;
      chosen = rung;
    }
    if (chosen !== from) reasons.push(`Context raised to ${count(chosen)} — the card has room the experts do not need.`);
    return chosen;
  };

  // ── 2. A dense model has no experts to move: it fits, or fewer of its layers go to the GPU ──────
  if (!isMoe) {
    const perLayer = input.modelBytes / layers;
    const layersThatFit = (tokens: number): number => Math.floor(roomForWeights(tokens) / perLayer);
    if (layersThatFit(contextTokens) >= layers) {
      reasons.push(`The whole model fits in ${gb(vram)} of VRAM.`);
      return { contextTokens: growWindow(contextTokens, (tokens) => layersThatFit(tokens) >= layers), gpuLayers: "all", cpuMoeLayers: null, blanketCpuMoe: false, batchSize, ubatchSize, loadMode, reasons };
    }
    const onGpu = Math.max(0, layersThatFit(contextTokens) - CLIFF_MARGIN_LAYERS);
    reasons.push(`${onGpu} of ${layers} layers in VRAM — the rest run on the CPU, because ${gb(input.modelBytes)} does not fit ${gb(vram)}.`);
    return { contextTokens, gpuLayers: onGpu, cpuMoeLayers: null, blanketCpuMoe: false, batchSize, ubatchSize, loadMode, reasons };
  }

  // ── 3. The MoE split ───────────────────────────────────────────────────────────────────────────
  const denseBytes = input.modelBytes * (1 - EXPERT_SHARE);
  const perLayerExpertBytes = (input.modelBytes * EXPERT_SHARE) / layers;

  /** Layers whose experts the card can hold at a given window, one layer clear of the cliff. */
  const splitFor = (tokens: number): number => {
    // The dense path must be resident before a single expert can be, so it comes off the top.
    const forExperts = roomForWeights(tokens) - denseBytes;
    if (forExperts <= 0) return layers;
    const affordable = Math.floor(forExperts / perLayerExpertBytes);
    return layers - Math.max(0, Math.min(layers, affordable - CLIFF_MARGIN_LAYERS));
  };

  const cpuMoeLayers = splitFor(contextTokens);

  if (cpuMoeLayers >= layers) {
    reasons.push(`${gb(input.modelBytes)} of weights against ${gb(vram)} of VRAM: every expert runs on the CPU.`);
    // A window is cheap once the experts have already left, so take the one the work wants.
    return { contextTokens, gpuLayers: "all", cpuMoeLayers: null, blanketCpuMoe: true, batchSize, ubatchSize, loadMode, reasons };
  }

  if (cpuMoeLayers <= 0) {
    reasons.push(`The whole model fits in ${gb(vram)} of VRAM — nothing is offloaded.`);
    // Nothing competes for the card, so spend what is left on a longer window rather than wasting it.
    return { contextTokens: growWindow(contextTokens, (tokens) => splitFor(tokens) <= 0), gpuLayers: "all", cpuMoeLayers: 0, blanketCpuMoe: false, batchSize, ubatchSize, loadMode, reasons };
  }

  reasons.push(`Experts of ${cpuMoeLayers} of ${layers} layers on the CPU — the fewest Kitten can be sure of. A measured tune can usually shave one or two more off.`);
  return { contextTokens, gpuLayers: "all", cpuMoeLayers, blanketCpuMoe: false, batchSize, ubatchSize, loadMode, reasons };
}

/** Windows worth choosing between. A ladder, not a continuum: predictable sizes reuse warm caches. */
const CONTEXT_LADDER = [32768, 49152, 65536, 98304, 131072, 196608, 262144] as const;

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Thousands separators that do not depend on the host locale — "8.192" for 8192 reads as a decimal. */
function count(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ── Calibration ─────────────────────────────────────────────────────────────────────────────────
// The estimate above lands within a layer or two of the measured optimum, which is worth a lot and is
// not the same as being right. The cliff is sharp, its exact position depends on driver version,
// desktop composition and whatever else holds VRAM, and no formula can see those. So the estimate is
// a starting point that a real measurement can improve on — and once measured, it is remembered.

/** One measured configuration: what was tried, and what it produced. */
export interface CalibrationSample {
  cpuMoeLayers: number;
  contextTokens: number;
  decodeTokensPerSecond: number;
  promptTokensPerSecond: number;
}

/** A remembered result, keyed to the machine and model it was measured on. */
export interface CalibrationRecord {
  /** Identity of what was measured — a result is only valid for the same model on the same device. */
  fingerprint: string;
  cpuMoeLayers: number;
  contextTokens: number;
  batchSize: number;
  decodeTokensPerSecond: number;
  promptTokensPerSecond: number;
  measuredAt: number;
  samples: CalibrationSample[];
}

/**
 * What makes one measurement applicable to another launch. The model file, its size, the device and
 * its VRAM: change any of them and the cliff moves, so the stored result must not be reused.
 */
export function calibrationFingerprint(input: { modelPath: string; modelBytes: number; gpuName?: string; vramBytes?: number }): string {
  const device = `${input.gpuName ?? "unknown-gpu"}@${Math.round((input.vramBytes ?? 0) / 1e8)}`;
  return `${input.modelPath.toLowerCase()}|${input.modelBytes}|${device}`;
}

/**
 * The ladder a calibration walks: start at the safe estimate and step TOWARD the cliff one layer at a
 * time, because the gain is on that side. Bounded to a handful of rungs — this costs a model load
 * each, and a user is not going to wait through twenty of them.
 */
export function calibrationLadder(estimate: number, layers: number, rungs = 4): number[] {
  const ladder: number[] = [];
  for (let i = 0; i < rungs; i++) {
    const value = estimate - i;
    if (value < 1 || value >= layers) break;
    ladder.push(value);
  }
  return ladder;
}

/**
 * Pick the winner from measured samples.
 *
 * "Fastest decode" is the wrong objective on its own: a coding agent spends much of its time reading
 * files back into the model, so prefill counts too. The score weights them the way an agent turn
 * actually spends its time — roughly a thousand tokens of prompt for every couple of hundred it
 * writes — and a configuration that collapses prefill can therefore never win on decode alone.
 */
export function scoreSample(sample: CalibrationSample, promptTokens = 1200, generatedTokens = 250): number {
  if (sample.decodeTokensPerSecond <= 0 || sample.promptTokensPerSecond <= 0) return Number.POSITIVE_INFINITY;
  return promptTokens / sample.promptTokensPerSecond + generatedTokens / sample.decodeTokensPerSecond;
}

/** The best measured configuration: the one that finishes a representative turn soonest. */
export function bestSample(samples: readonly CalibrationSample[]): CalibrationSample | null {
  let best: CalibrationSample | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const score = scoreSample(sample);
    if (score < bestScore) { bestScore = score; best = sample; }
  }
  return best;
}

/**
 * Whether a measured sample has fallen off the cliff relative to the best seen so far. The collapse is
 * unmistakable — a third of the throughput, not a few percent — so a generous threshold identifies it
 * without mistaking ordinary variance for it.
 */
export function fellOffCliff(sample: CalibrationSample, best: CalibrationSample): boolean {
  return sample.decodeTokensPerSecond < best.decodeTokensPerSecond * 0.8
    || sample.promptTokensPerSecond < best.promptTokensPerSecond * 0.6;
}
