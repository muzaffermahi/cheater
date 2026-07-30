# KITTEN-INFERENCE — the owned-engine execution plan

What we do with the fact that we own the inference stack, ordered by expected payoff **on this box**:
8 GB VRAM, 32 GB RAM, `ornith-1.0-35b` A3B at Q5 with experts streaming from CPU, ~20 tok/s, 16k ctx.
Primary runtime: llama.cpp `llama-server`. LM Studio is a degraded fallback.

This supersedes the ordering in earlier drafts. It is written against a deep-research pass that verified
the llama.cpp surface and **falsified several things we believed** — those are recorded honestly in §5
rather than quietly dropped.

The binding constraint: **decode is weight-streaming-bound over CPU memory bandwidth, and long prefill
is re-paid constantly.** Advice tuned for a GPU-resident dense model does not transfer.

---

## 0. Two findings that land on code we already shipped

**0.1 — We may be paying ~3× decode for a tiebreaker.** `ALL_LEVERS` has `confidence: true`, so every
Ascent generation sets `logprobs` + `topLogprobs: 5` (`agent.ts:171-172`). A llama.cpp issue reports
`n_probs > 0` cutting generation speed by roughly 3×. Self-certainty is used only to break *genuine
ties*. Measure this first (§1, E0); if it reproduces, request logprobs only where the value is
established — enum/label scoring, critical-span guards, ablation runs — not on every open-ended
candidate.

**0.2 — `reasoningEffort` may be a no-op.** We thread `"low" | "medium" | "high"` into
`reasoning_effort` (`agent.ts:46,170`; `llm.ts:269`). Per current llama.cpp docs only `none` reliably
disables reasoning; the other values may do nothing. If so we believe we are steering reasoning cost and
are not. Replace with the mechanisms that are real: `--reasoning-budget` and in-stream `reasoning_end`.

---

## 1. Priority order (and the threshold that decides adoption)

### Track A — KV/prefix as a scheduling resource *(highest expected payoff)*
Against a 30–90 s cold prefill, restoring a saved KV is close to I/O + memcpy. This is the difference
between "resume is instant" and "resume re-pays the whole 16k context".

- **Canonical prefix order, frozen.** system → tools → repo digest → conventions, then *everything
  volatile last*. Mid-prompt mismatch only reuses up to the longest common prefix, so an early drift
  invalidates the most expensive part of the cache. Enforce with a cross-call-site byte-equality
  assertion — deterministic, testable, free, and it does not depend on the runtime.
- **Warm repo capsule**: prefill the stable capsule once with `n_predict: 0` + `cache_prompt: true`.
- **Durable slot save/restore** (`--slot-save-path`, `POST /slots/{id}?action=save|restore`) so a
  reopened conversation restores instead of recomputing. The response reports `n_written`/`n_read`, so
  bytes-per-1k-tokens is measurable on our box rather than guessed.
- Server surface: `--slot-prompt-similarity`, `--cache-ram`, `--cache-idle-slots`, `--parallel`,
  `--kv-unified`.
- **Adopt if:** restored first-token time is ≥70 % below cold prefill. At ≥85 %, hang the whole
  pause/resume flow on it. Below 70 %, keep it for same-process reuse only.
- Value ranking within this track: cross-process restore > stable repo capsule > short candidate
  branches off one prefix > general multi-slot LRU.

### Track B — Constrained decoding *(highest certainty, cheapest)*
GBNF is plumbed and used in **zero** production paths. The goal is not to *reduce* malformed output but
to make it unrepresentable.

- Enum grammars for every classifier (routing, triage, family, risk) → single-token, in-label answers.
- Tool-call envelopes via `json_schema` (llama.cpp converts internally) with a GBNF fallback.
- Anchored edit-script grammar; the harness parses and applies the hunks (model proposes, harness
  mutates).
- File-path grammar built from the live workspace index — **must be two-armed**
  (`EXISTING_PATH | NEW_FILE_SENTINEL`), or the model can never create a file and we manufacture false
  negatives. No published prior art for this: it is promising, not proven.
- **Adopt if:** parse/apply failure ≈ 0 **and** sampling overhead stays under ~10–15 % for the same work.
  Large or naive grammars have real sampling cost — measure it, don't assume it away.

### Track C — Draftless speculation *(no second model, fits our trace profile)*
llama.cpp exposes `--spec-type ngram-simple | ngram-map-k | ngram-map-k4v | ngram-mod | draft-mtp |
draft-eagle3 | draft-dflash | draft-dspark`. The docs specifically recommend n-gram self-speculation for
repetitive code and for reasoning models restating their own thinking, and note **MoEs need long
drafts**. Our repair turns restate failing code, diffs and test output constantly — exactly the profile.

- Start: `--spec-type ngram-mod --spec-ngram-mod-n-match 24 --spec-ngram-mod-n-min 48
  --spec-ngram-mod-n-max 64 --spec-draft-n-max 64`. The hash pool is light and shared across slots.
- **Adopt if:** ≥20 % decode tok/s or ≥15 % wall-clock at equal quality. Drop if acceptance is low and
  total throughput regresses.
- **MTP is a model-selection criterion, not a default.** It landed in llama.cpp around May 2026 with
  reported per-backend regressions and extra KV/context cost from a separate draft cache — on 8 GB that
  is not free. If we move to a KAT-Coder-class MTP model, accept it only on an A/B **at equal context
  budget**. EAGLE-3/DSpark need target-specific draft checkpoints, so that branch stays closed.

### Track D — Reasoning budget *(thinking stays; the tax gets cut)*
Real, native surface: `--reasoning`, `--reasoning-format`, `--reasoning-budget`,
`--reasoning-budget-message`, per-request `reasoning_control`, and in-stream `reasoning_end` via
`/v1/chat/completions/control`. Budget is set by **our** hardness classifier, not by the model's whim.

- On budget exhaustion: force `reasoning_end`; if `content` is still empty, one final-only retry. This is
  the exact failure we have already hit (whole budget spent thinking, empty content).
- Guard against loops in the reasoning channel only (entropy collapse + short n-gram repeat, sustained
  over several windows) so legitimate boilerplate is never cut.
- **Adopt if:** ≥20 % wall-clock reduction on a task family for ≤2–3 points of success. Worse means the
  budget is too tight; better means the default reasoning is wasteful.

### Track E — Probability streams, narrowly
Use logprobs as a **cheap control signal, not a correctness score**. Calibration work supports
single-token/choice settings; recent code-uncertainty work finds bare token log-probability does *not*
correlate meaningfully with code correctness (semantic-clustering methods do far better).

- Yes: enum-router label probability, short label scorers, identifier/path pre-screen (low-probability
  span → cross-check the workspace index → block or repair, never silently rewrite).
- No: mean/min logprob as a verdict on whether a whole solution is correct.
- Fit any threshold on a **separate validation slice** (Brier/ECE + action cost), freeze it, then report
  on test. See also §0.1 — capture must be scoped, because it is not free.

### Track F — Engine tuning `--n-cpu-moe` / `-ot` *(largest raw-perf lever, undocumented)*
There is no normative guidance on which tensors to keep on GPU; llama.cpp just exposes `--cpu-moe`,
`--n-cpu-moe` and `-ot`. So: a small setup probe, not folklore. Sweep `--n-cpu-moe` ∈ {0, 8, 16, 24, all},
then a second sweep pinning attention and shared/dense tensors to GPU via `-ot`. Also sweep `-b`/`-ub`
and `--threads` / `--threads-batch` separately for prompt-heavy and decode-heavy loads; keep
`--flash-attn on`. **Adopt if:** ≥10 % decode tok/s or ≥20 % prompt tok/s. If the gain is prompt-only,
deprioritise — our workload is decode-heavy.

### Track G — Sidecar roles, corrected
No strong evidence that a 2–9B model reliably critiques a 35B's code, and TB2 shows small models are
markedly weaker agents. Point the sidecar at what is defensible: classification, **reranking** (llama.cpp
has a `/rerank` endpoint with rank pooling — a dedicated cross-encoder is a better reviewer-slot
investment than an LLM critic), test selection, triage, receipt compaction.

### Track H — Learning from receipts, scoped to what fits
QLoRA fine-tuned a 65B on a 48 GB GPU; that puts **35B adapter training off this box**. A 2B sidecar
adapter and small outcome/reward models are reasonable here. llama.cpp supports per-request `lora`
selection but **cannot batch requests with different LoRA configs**, so many concurrent adapters will
cost throughput. Treat adapters primarily as a way to absorb long playbook prompts and hand context back
at 16k.

---

## 2. Experiments, in order

Every one: same machine, same model, same task set, same harness. Record `timings.prompt_ms`,
`timings.predicted_ms`, `usage.prompt_tokens_details.cached_tokens`, `n_busy_slots_per_decode`,
apply/build/test success, wall-clock.

- **E0 — logprob cost.** Identical generation with and without `logprobs`. Settles §0.1. Cheapest test we
  have and it is about code we already ship.
- **E1 — repo capsule + slot restore.** Prefill capsule, save slot, restore in-process and after a server
  restart. Threshold in Track A.
- **E2 — enum + tool + patch grammars.** Parse/apply failure to ~0; sampling overhead ≤10–15 %.
- **E3 — n-gram speculation** on repair-heavy turns. Thresholds in Track C.
- **E4 — `--n-cpu-moe` / `-ot` sweep.** Thresholds in Track F.
- **E5 — reasoning budget + `reasoning_end`.** Thresholds in Track D.

Server baseline for E1:

```
llama-server -m ORNITH_Q5.gguf --jinja --reasoning-format deepseek \
  --ctx-size 16384 --cache-type-k q8_0 --cache-type-v q8_0 \
  --cache-ram 8192 --slot-save-path ./slot-kv --slot-prompt-similarity 0.25 \
  --cache-idle-slots --parallel 2 --flash-attn on
```

---

## 3. Terminal-Bench 2 protocol (the number we intend to publish)

TB2.0 is 89 outcome-driven tasks scored on final container state, run through Harbor
(`terminal-bench@2.0`). Small models land ~15 %; open-weight 35B-A3B-class runs sit around the mid-20s.
**So the goal is not SOTA — it is a double-digit relative gain over a thin baseline harness on the same
box**, which is also the claim least vulnerable to confounds.

Binding rules, because the harness confound is real (the verified 2.1 pass moved scores by more than a
couple of points on environment and instruction fixes alone):

1. State **2.0 vs 2.1** explicitly. Pin Harbor and llama.cpp commits. Publish the full server flags.
2. Publish per-task timeout, restart policy, tool whitelist, token limits, reasoning-budget policy and
   retry count.
3. The public leaderboard picks the *best scaffold per model*. Our claim is the opposite — **same model
   endpoint, same tool surface, same token limits, orchestration is the only difference.**
4. Paired per-task comparison. Stratified 20–30 task smoke set for feature pruning, then the full 89
   paired for the final. Report mean resolution **and** paired per-task win rate, with raw artifacts.

---

## 4. Do not bother (on this box)

- Scaling N on the strength of GPU-resident dense-model advice. Offloaded-MoE work shows continuous
  batching keeps decode batches small; the real throughput jumps come from module-level batching that is
  not interactive.
- Enabling MTP without measuring its context/VRAM cost.
- Requesting `n_probs` on every open-ended generation (§0.1).
- Shipping repo-scale grammars without measuring sampling cost.
- Nightly LoRA/QLoRA on the 35B here.
- Assuming small-model review panels are cheap quality. Give the small model classification, ranking and
  compaction instead.

## 5. Claims we held that did not survive

| Claim | Verdict |
|---|---|
| A 2B draft gives a 35B-A3B 1.5–2.5× decode | **Unverified, near folklore** in a CPU-streaming regime (and moot — no draft model) |
| One-prefill-N-decode makes best-of-N nearly free, 2–4× on Ascent | **Half true.** Prefill amortises; decode does not become cheap. Plausible at N=2 on short branches; N≥3 carries the burden of proof |
| KV quant gives 2–4× context at acceptable quality | **Base-dependent.** f16→q4 ≈ 4×; from our existing q8_0 baseline it is ≈2×. Code-specific quality evidence does not exist — q8_0 stays the default |
| Anchored edit grammars: ≥30 % fewer tokens, no apply-success loss | Directionally sound, **both hard thresholds unproven** |
| FIM halves single-region edit cost | **Only for FIM-trained families**, and the ratio depends on suffix geometry |
| Prompt-lookup drafting is nearly free with high acceptance | **The strongest surviving claim** — zero second-model cost, and llama.cpp documents this exact use case |
| Small models fail on format far more than on reasoning | **Too reductive for 2026.** True for narrow tool/output tasks; integration and dependent step chains dominate agentic failure. Constrain format anyway — precisely so the remaining failures are attributable |
| QLoRA nightly training is feasible here | **2B yes, 35B no** |
