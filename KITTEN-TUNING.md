# Auto-tuning llama.cpp — what was measured, and what Kitten does with it

Kitten's "auto" used to ask one question: *what is the largest context this card will hold?* Everything
else followed. On the reference machine that produced a 131,072-token window, a KV cache that filled
the card, and every expert evicted to system RAM.

This pass replaced the guessing with measurement — and then had to correct itself twice, because two
of the things the first sweep appeared to prove were artefacts of how it was run.

## The reference machine

| | |
|---|---|
| GPU | RTX 4060 Laptop, 8.59 GB |
| CPU / RAM | i7-13700H (6 P-cores + 8 E-cores), 34 GB |
| Model | Ornith 1.0 35B (MoE, `qwen35moe`), Q5_K_M, 24.7 GB, 40 layers |
| KV | 21 KiB/token at q8_0, read from the model's own GGUF header |
| Harness | `cheater-pi/scripts/llama-tuning-sweep.mjs` — cold launch per config, server-reported timings |

30 configurations across five phases. **Only the warm ladder below is quotable**: an early phase mixed
`--load-mode none` configs in with mmap ones, which evicted the page cache between runs and halved
every absolute number. With experts on the CPU, decode reads them from RAM on every token, so whether
those pages are cached is worth about 2×. The *ordering* survived that; the magnitudes did not.

> **These are WARM numbers, and a cold launch is slower.** The shipped calibrator cold-launches every
> rung — which is what a user and a benchmark actually experience — and on the same machine and model
> it measured 21.3 tok/s at ncmoe 30 and 19.6 at 31, not 32.4 (`~/.kitten/calibration.json`,
> 2026-08-03; a live E0 run on 2026-08-09 landed at ~16–18). The **ordering below is what survives and
> is what any decision rests on**: 30 and 31 are close, 29 falls off a cliff. Do not quote 32.45 as
> what this machine does in use. See `cheater-pi/scripts/BENCHMARK-STATE.md`.

## The warm ladder — one session, mmap throughout

| configuration | decode tok/s | prefill tok/s |
|---|---|---|
| ncmoe 30, ctx 16k, batch 4096 | **32.45** | 374 |
| **ncmoe 30, ctx 32k, llama.cpp default batch** | **32.12** | 186 |
| ncmoe 34, ctx 32k, batch 4096 | 22.09 | 284 |
| ncmoe 30, ctx 65k, batch 4096 | 21.90 | 53 |
| ncmoe 36, ctx 32k, batch 4096 | 20.97 | 279 |
| blanket `--cpu-moe`, ctx 32k | 20.20 | 243 |
| ncmoe 30, ctx 32k, **batch 4096** | 14.27 | 172 |
| ncmoe 31, ctx 32k, batch 4096 | 13.99 | 180 |
| ncmoe 29, ctx 32k, batch 4096 | 10.54 | 50 |
| ncmoe 28, ctx 32k, batch 4096 | 9.76 | 49 |

### 1. The cliff is real, sharp, and one layer wide

30 → 32.1 tok/s. 29 → 10.5, with prefill collapsing 186 → 50. Not degradation — the driver starting
to spill to shared memory. Everything below the edge is worse than everything above it, so an
estimate must approach from the safe side. The user had already found 30 by hand; the sweep landed
on the same number independently.

### 2. Context is not free, and it is not the goal

Every token of window is VRAM an expert could have used. The old auto spent the whole card on context
and then had no choice but to evict every expert. Note ctx 65k: same split, decode holds up but
prefill falls off a cliff (53 tok/s) as the cache crowds the card.

A smaller window does **not** rescue a bad split — ncmoe 28 measured the same at 16k and 32k. The
weights are what did not fit, not the cache.

### 3. VRAM spent anywhere else is VRAM the experts do not get — including on batch scratch

**This is the correction that cost the most.** A CPU+GPU MoE guide argues llama.cpp's batch defaults
are sized for pure-GPU inference and too small once experts stream over PCIe, and the first sweep
appeared to agree (prefill 108 → 173). So Kitten forced `--batch-size 4096 --ubatch-size 4096`.

Measured properly — same split, same window, back to back in one warm session:

```
llama.cpp default batch    32.12 tok/s decode, 186 tok/s prefill
forced 4096 / 4096         14.27 tok/s decode, 172 tok/s prefill
```

**A factor of 2.3, and the prefill it was meant to buy was worse too.** A 4096 physical batch
allocates a compute buffer several times larger than the default, and on a card that is already full
that buffer is exactly what pushes the split over the cliff. Kitten no longer touches batch geometry.

This is also the answer to "I get 15 tok/s but LM Studio gives me 20-30": LM Studio was running
2048/512, and Kitten was forcing 4096.

### 4. Two more pieces of received wisdom that did not survive

- **Disabling mmap** under CPU tensor overrides — llama.cpp's own advice — cost 24s of load against
  8s for no decode gain (14.26 vs 14.35, inside the noise). Kitten imposes no load mode.
- **Pinning weights with `mlock`** measured +15%, then **killed the launch mid-load** at 24.7 GB on a
  34 GB machine. Now gated at 2× RAM, which means off on this machine. A runtime that will not start
  is infinitely worse than one that is 15% slower.
- **Speculation** (`--spec-type ngram-mod`) measured neutral (14.10 vs 14.30) and stays on, being
  output-lossless.
- **Pinning threads to the 6 P-cores** — the obvious move on a hybrid Intel — was not the lever: the
  config that used it was slower overall than one that did not.

## The algorithm

`cheater-pi/src/core/autoTune.ts`. Context, expert split and load mode are decided **together**,
because they compete for the same bytes:

```
room     = VRAM − KV(context) − compute buffer − device reserve
experts  = room − dense weights
onGpu    = floor(experts / per-layer expert bytes)
nCpuMoe  = layers − onGpu
```

with `per-layer expert bytes = modelBytes × 0.92 / layers` — 0.92 being the expert share of a
35B-A3B-class MoE, which activates ~3B of 35B per token.

It is not specific to this machine or this model. It also handles:

- **a model that fits** — every expert stays on the GPU, and leftover VRAM is spent growing the window
  up a ladder rather than wasted;
- **a dense model** — no experts to move, so it returns a `--n-gpu-layers` count instead;
- **an unreadable header** — falls back to what file size alone can justify, and refuses to evict
  experts from a model that comfortably fits;
- **a model too large for any split** — the blanket `--cpu-moe`, with an honest warning.

14 unit tests cover those branches. On the reference machine it proposes 31 against a measured optimum
of 30 — the safe side of the cliff.

## Why there is also a measured mode

A formula cannot see the driver version, the compositor, or what else is holding VRAM, and the cliff
moves with all three. **Settings → Performance → Tune for this machine** walks down from the estimate,
times each rung with three passes and keeps the median, stops at the collapse, and remembers the
winner keyed to `(model file, size, GPU, VRAM)`. Verified live:

```
[1/4] ncmoe 31 → 12.96 tok/s decode, 151 prefill
[2/4] ncmoe 30 → 13.24 tok/s decode, 141 prefill
[3/4] ncmoe 29 → 10.80 tok/s decode,  53 prefill   ← cliff, stop
```

The winner is scored on **time to finish a representative turn** (~1200 prompt tokens, ~250 generated),
not decode alone, so a configuration that collapses prefill can never win. Once measured, every launch
uses it; a value you pin yourself always wins over both.

## Against opencode — same model, hidden oracles

Five scratch tasks from `Desktop\tbench-run\bakeoff30`, both agents on the same llama.cpp endpoint,
graded by behavioural oracles the agents never see, each in a pristine copy of the workspace.

| task | Kitten | opencode |
|---|---|---|
| todo_cli | **pass** 174s | fail 322s |
| csv_stats | **pass** 158s | fail 196s |
| expr_eval | **pass** 517s | fail 355s |
| matrix_lib | **pass** 171s | fail 502s |
| md_toc | fail 185s | fail 900s (timeout) |
| | **4/5** | **0/5** |

opencode's failures were mostly import errors — the produced module did not expose what the contract
asked for. Kitten's one miss was `md_toc`: indent depth 2 missing from the generated table of contents.

## Reproducing

```bash
node scripts/llama-tuning-sweep.mjs --phase 5 --out sweep-warm.json
```

Phases: 1 the first ladder, 2 combinations, 3 against LM Studio's settings, 4 mlock, 5 the warm ladder
above. Use phase 5 — it is the one that holds the page cache still.

## Sources

- [llama.cpp — Optimize my llama.cpp (discussion #21112)](https://github.com/ggml-org/llama.cpp/discussions/21112)
- [Guide to optimizing inference of large MoE models across CPU+GPU](https://gist.github.com/DocShotgun/a02a4c0c0a57e43ff4f038b46ca66ae0)
