# Kitten Ascent — ORM training pipeline (Part B3)

The **Outcome Reward Model** is the single highest-leverage build in the plan. SWE-Gym's datapoint for a
fixed ~32B model: `Best@16 = 32.0` (a mediocre verifier picks) vs `pass@16 = 42.8` (oracle). **A mediocre
verifier leaves 10.8 points on the table** — points already inside the samples you generated. The ORM
learns *what a solved trajectory looks like* from real solves, so the verifier ranks by learned
recognition of correct work. The harness getting better at recognising correct work directly reduces the
confident-wrong finishes a user receives: the benchmark number and the user-value number stay the same
number.

## The loop

```
gen_data.mjs   →   data.jsonl   →   train.mjs   →   ckpt   →   eval_verifier.mjs   →   report card
 (label by                          (P(solved))               (AUC / Best@1 lift / gap-to-oracle)
  the REAL oracle)
```

All three scripts are dependency-free Node ESM and import the **single source of truth** for features
(`dist/src/core/ormFeatures.ts`) — so what you train on is exactly what the verifier scores with at
inference time.

## Proof-of-life (runs in seconds, no GPU)

The proof-of-life ORM is a real, runnable logistic-regression model over **execution-grounded**
trajectory features (did a check actually pass, did anything crash, did it finish, change size). An
outcome reward model is just `P(solved | trajectory)`; this is a genuine one, just small.

```bash
cd cheater-pi && npm run build            # builds dist/ (features are shared TS)
cd training/orm
node gen_data.mjs --out data.jsonl --synthetic 600     # fabricates labeled trajectories (~8% irreducible noise)
node train.mjs   --data data.jsonl --out ckpt.json     # trains the logreg ORM
node eval_verifier.mjs --data data.jsonl --ckpt ckpt.json --split 0.3 --group 8
```

Committed artifacts (`pol-ckpt.json`, `pol-report.txt`) from this exact run:

```
AUC (rank solved>unsolved) : 0.933      [0.5 = chance, 1.0 = perfect]
accuracy @0.5              : 92.2%
Best@1 (ORM picks)         : 95.5%       over 22 synthetic 8-candidate tasks
Best@1 (random picks)      : 50.0%
pass@k (oracle ceiling)    : 100.0%
ORM lift over random       : +45.5 pts   (gap to oracle: 4.5 pts)
```

The ORM captures nearly all of the pass@k ceiling as Best@1, leaving a small residual (the irreducible
verifier error) — the SWE-Gym story in miniature. **The AUC on synthetic data is not a real capability
claim**; it only proves the data→train→eval→infer loop works end to end.

> **The committed `pol-ckpt.json` is NOT trustworthy and must not be cited or loaded.** An audit
> (2026-08-09) found two things wrong with it, both visible in the file:
>
> 1. The sanity story above does not hold. `finished` is **−1.744**, not positive — this checkpoint
>    learned that a trajectory saying it finished is *less* likely to have solved anything. On the
>    synthetic corpus that may even be right (fabricated failures also "finish"), which is precisely
>    why a synthetic checkpoint must not be pointed at real runs.
> 2. `bias` (−0.40734597145868356) is byte-identical to `weights[2]` (`hasExecutionReceipt`). Two
>    independently-fit parameters do not land on the same 17 significant figures; this is a copy
>    artifact in `train.mjs`'s output, not a converged bias.
>
> The ORM is dark by default (`loadOrm()` returns null without `KITTEN_ORM_CHECKPOINT`), so nothing
> in the product is affected. Fix `train.mjs`'s output and re-train before wiring anything to it.

Wire it into the verifier with **zero code change**:

```bash
export KITTEN_ORM_CHECKPOINT=$PWD/pol-ckpt.json    # loadOrm() picks it up; the verifier ranks by it
```

## Scaling to the real ORM (the 2B fine-tune, the actual lift)

1. **Data (real).** Run the coverage engine (`bestofn.ts`, Part A) over a corpus **disjoint from every
   eval** — SWE-Gym *train* split, scraped GitHub issues, and the user's own past kitten runs. Label each
   trajectory by the **real oracle** (tests pass in a clean, reset env — never self-report). Emit the same
   `{id, trajectory, solved}` JSONL. `gen_data.mjs --manifest corpus.json` accepts it and **HARD-FAILS
   (exit 3) if any id is an eval task** (Law 4, asserted in code, not promised).
2. **Train.** Fine-tune the 2B (`qwen3.5-2b`) as a binary YES/NO classifier on `(task, trajectory) →
   solved`, following SWE-Gym: predict the single YES/NO token, rank by its **normalised logprob**. Any
   LoRA/SFT trainer works; the JSONL is the same. Save the adapter, serve it as a model id.
3. **Infer.** Point the verifier at it: `export KITTEN_ORM_MODEL=<served-checkpoint-id>`. `SidecarOrm`
   uses the logprob path (`yesProbFromLogprobs`) and falls back to the json prior if logprobs are absent.
4. **Prove.** `eval_verifier.mjs` on a **held-out** slice of the corpus reports AUC and the Best@1→pass@k
   gap. Only a lift that survives the held-out set (Part D2) counts.

## The anti-benchmaxx guarantee (Law 4)

Both `gen_data.mjs` (at generation) and the runtime `ExperienceStore` (at load/admit) assert the training
corpus is **disjoint from every eval set** via `defaultRegistry()` and hard-fail on overlap. An ORM
trained on eval solves would be benchmaxxing; an ORM trained on a disjoint corpus is the harness learning,
from its own verified history, to recognise correct work — which is exactly what real-world use
accumulates.
