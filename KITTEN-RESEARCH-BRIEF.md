# Research brief: turning full local-inference control into a coding-agent advantage

You are researching for **Kitten**, a local-first coding agent (native Windows desktop app) that runs
against a **local inference server we fully control**. Unlike agents built on hosted APIs, we own
everything below the prompt: the server process, its launch flags, the KV cache, sampling, slots,
grammars, logits, and — if we want it — the weights. Your job is to find, verify and rank the techniques
that convert that control into measurable coding-agent quality and latency wins on **this exact
hardware**, and to tell us honestly which ones are folklore.

The reader is a competent systems engineer who will implement your findings. Prefer primary sources
(llama.cpp source, PRs and docs; papers with released code; reproducible benchmarks) over blog
summaries. **Where you are uncertain, say so and name the experiment that would settle it.** Several
claims in §7 are ones we currently believe and want *falsified* if they are wrong.

---

## 1. The machine you are optimizing for (this dominates every answer)

- **GPU: 8 GB VRAM.** **System RAM: 32 GB.** One workstation, one GPU.
- **Main model: `ornith-1.0-35b` at Q5** — a **35B Mixture-of-Experts with ~3B active parameters**
  (A3B class), a *reasoning* model that emits `reasoning_content` separately from `content`.
- At Q5 the weights are far larger than 8 GB, so the model runs **with most expert tensors offloaded to
  CPU/RAM** (llama.cpp `--cpu-moe` / `--override-tensor`-style splits, attention on GPU). Treat
  **decode as weight-streaming-bound over CPU memory bandwidth**, not as a GPU-compute problem. Every
  recommendation must be evaluated in *this* regime — advice tuned for a fully-resident GPU model is
  actively misleading here, and we want you to say so where it applies.
- Observed: **~20 tok/s** decode, **16k context** in use, **30–90 s to first token on a cold model**.
- **Sidecar: `qwen3.5-2b`** (fast, no reasoning tax, clean JSON). Also present: `qwopus3.5-9b-coder`.
- **Runtime decision (already made): llama.cpp `llama-server` is the primary target.** LM Studio stays a
  degraded compatibility fallback. Do not constrain recommendations to what an OpenAI-compatible proxy
  can express — but do flag which techniques are llama.cpp-only.

### A decision that removes a whole branch
**The sidecar is NOT available as a draft model.** It has a job (classification, ranking, compaction,
triage, test selection) and we will not repurpose it. For speculation we intend to use
**MTP / self-speculative decoding** (multi-token-prediction heads, EAGLE/Medusa-style self-drafting,
n-gram / prompt-lookup) rather than a separate draft model. Research §3.4 accordingly.

---

## 2. What Kitten already implements — do NOT propose these as new

A code audit established the following are **already built and live**. Re-proposing them wastes the
report. Where useful, tell us how to *tune* or *extend* them.

- **Thinking toggle per lane** (`enable_thinking:false`); sidecar defaults to no-think with a 4xx fallback.
- **Decode bans** — `logit_bias` hard-bans built from the native `/tokenize` endpoint.
- **Self-certainty** — logprobs aggregated as a candidate tiebreaker (gated to genuine ties).
- **Sampler diversity** — per-attempt `top_p`/`top_k` profiles; `min_p` and DRY plumbed.
- **`cache_prompt: true`** on both chat and raw-completion paths.
- **`json_schema` structured output** with graceful downgrade latches when unsupported.
- **Capability probing** for grammar / logprobs / `cache_prompt` / engine kind, cached.
- **An outcome-reward model path**: single-token YES/NO logprob scoring, plus a training pipeline.
- **`--model-draft` plumbing** exists but is opt-in and, per the decision above, not our direction.
- **A lever/ablation framework**: every feature is flag-gated and leave-one-out ablated on held-out tasks.
- Agent-side: adaptive lane router, verified completion via execution receipts, durable subagent DAG with
  scoped permissions and isolated git worktrees, ~30 schema-validated sidecar jobs, a workspace index.

**Known unused surface (this is where the leverage is):** GBNF grammar is plumbed but used in **zero**
production paths; `/infill` (FIM) has **no callers**; no probability signal feeds the router; no KV
discipline beyond `cache_prompt:true`; the managed launch plan emits only **4 flags**; no degeneration
detection; nothing trains on the harness's own receipts.

---

## 3. Workstreams

For **each**: (a) what is actually possible today, with exact flag/API names and version caveats;
(b) expected win **in this offload regime**, with numbers and the conditions they hold under;
(c) failure modes and how to detect them; (d) the cheapest experiment that would prove or kill it here.

### 3.1 KV cache and prefix reuse as a scheduling resource
- Exactly how llama.cpp prompt caching works now: slot assignment, longest-common-prefix matching, what
  invalidates a cache, behaviour on partial mid-prompt mismatch.
- **Slot save/restore to disk** (`--slot-save-path` and the slot save/restore endpoints): current API,
  restore cost vs recompute, bytes per 1k tokens at 35B MoE Q5 with our KV settings, and whether restore
  survives a server restart. We persist conversations durably; resuming currently re-pays full prefill on
  a 16k context.
- Can we hold a **warm "repo capsule" prefix** (system + tools + repo digest + conventions) that every
  turn, candidate and subagent branches from — and what is the eviction behaviour with N slots?
- **Cache-aware prompt ordering**: quantify the recompute penalty of putting anything volatile before
  stable content across a 20-turn loop. We intend to freeze a canonical byte-order; tell us if that is
  the right shape and what breaks it.
- **KV quantization** (`--cache-type-k/v` q8_0, q4_0): with only 8 GB VRAM this may be the difference
  between 16k and 24–32k usable context. We need **code-specific** quality evidence, not general
  perplexity — does q4 KV break long-range consistency in multi-file edits?

### 3.2 Constrained decoding: make malformed output structurally impossible
GBNF is plumbed and unused. This is our biggest immediate lever.
- Current GBNF syntax and semantics; the **throughput cost of a large grammar**; how grammars interact
  with prompt caching and with speculative decoding.
- Where is a raw grammar genuinely better than `json_schema` structured output (which llama.cpp converts
  internally)? Our hypothesis: enums, line-oriented formats, and anchored edit scripts.
- **Enum grammars for classification** — single-token, in-label answers for routing/triage/family labels.
  Confirm the latency and reliability story.
- The one we most want validated: **constrain generated file paths to a grammar built from the live
  repository index**, making a hallucinated path unrepresentable. Prior art? Failure modes for new files,
  renames, and path prefixes? Cost of rebuilding the grammar per turn on a large repo?
- **Anchored edit-script grammars vs whole-file rewrite vs unified diff** for a 3B-active model: which
  format has the best apply-success rate per token? Evidence, not intuition.
- **FIM / `/infill`** for single-region edits: for which model families is infill reliable, how do you
  choose prefix/suffix windows, and how much token cost does it actually save versus an anchored edit?

### 3.3 Probability streams as control signals
We can read per-token logprobs locally, for free, on every generation. Nobody on a hosted API can.
- Best-validated uncertainty signals for **code generation** (mean logprob, min-token logprob, entropy,
  margin), and how well they actually predict wrongness.
- **Confidence-calibrated routing**: using the label-token probability from an enum-grammar classifier to
  decide k=1 vs escalation. How is such a threshold fitted without overfitting, and how stable is it
  across models?
- **Hallucination guard on identifiers**: are low-probability spans a reliable detector for invented file
  paths and symbol names, such that we can cross-check the workspace index before executing a tool call?
  What false-positive rate should we expect?
- **Degeneration detection**: streaming n-gram loop detection plus entropy-collapse — thresholds that
  work, and how to avoid aborting legitimate repetitive code (tables, boilerplate).
- Does a **MoE reasoning model** calibrate differently from a dense one, and do reasoning tokens
  calibrate differently from answer tokens?
- What does requesting logprobs cost in throughput on llama.cpp?

### 3.4 Speculation without a draft model: MTP, self-speculation, lookup
Given §1: no separate draft model. Also note the **weight-streaming-bound** regime — verifying several
tokens in one forward pass amortizes the same expert-weight read, so speculation may be *worth more*
here than on a GPU-resident model. Confirm or refute that mechanism explicitly.
- **Multi-token prediction (MTP)**: which open models ship MTP heads, what does llama.cpp support today,
  and what speedups are measured? Our library already contains an MTP-suffixed coder model
  (`kat-coder-v2.5-dev-apex-mtp`), and we may adopt a KAT-Coder-class main model — so MTP support is a
  live model-selection criterion, not a hypothetical.
- **Self-speculative decoding** (EAGLE/Medusa/layer-skipping): current llama.cpp support status, and
  whether any of it is usable without training our own heads.
- **Prompt-lookup / n-gram decoding**: for an agent that constantly restates known code and test output,
  what acceptance rates and speedups are real? This needs no second model and looks like the best
  cost/benefit for us — validate.
- **Harness-known-truth seeding**: after a tool runs, *we* know the file's new contents and the test
  output. Can we seed those spans via raw-completion prefix instead of letting the model decode them —
  turning restatement into prefill — and use divergence as a signal? Any prior art or pitfalls?

### 3.5 Concurrency and batching on 8 GB VRAM
- With experts on CPU, what actually happens to throughput and latency when 2–6 requests share the model
  via parallel slots / continuous batching? Does batching amortize expert weight streaming enough to make
  **best-of-N nearly free**, or does KV pressure in 8 GB kill it first?
- What is the maximum sensible slot count at 16k–32k context with q8_0 KV on this VRAM budget?
- Is co-residency of the 2B sidecar with the offloaded 35B viable, or is a separate CPU-only server
  process strictly better? Give the reasoning in terms of memory bandwidth contention, not just VRAM.
- **MoE offload tuning is probably our single largest raw-performance lever**: what is the current best
  practice for choosing which tensors stay on GPU (`--n-cpu-moe` / `-ot` regex patterns), how much does
  getting it right matter at 8 GB, and can it be auto-tuned by a short probe at setup?
- `--flash-attn`, batch/ubatch sizing, thread counts: what actually moves the needle in this regime?

### 3.6 Reasoning budget: keeping the benefit, cutting the tax
Thinking demonstrably helps us and we are keeping it — but the model over-thinks, and at ~20 tok/s that
is the dominant latency cost. This workstream is high priority.
- **Budget forcing** (s1-style: cap thinking tokens, then force a closing think tag and a final answer):
  what does the evidence say about quality loss vs tokens saved, and does it hold for MoE reasoning models?
- Per-request **reasoning-effort control**: what do current local reasoning models expose (chat-template
  kwargs, effort levels, stop-on-think-tag), and what does llama.cpp pass through?
- Is there a reliable way to make reasoning length **proportional to task difficulty**, decided by the
  harness rather than the model? We already classify task hardness before running.
- Evidence on **reasoning vs non-reasoning models for agentic coding** when the harness *already*
  provides structured verification and repair: does the reasoning tax still pay for itself, or is a
  strong non-reasoning coder model plus more verified iterations better wall-clock-for-wall-clock?
- Known failure mode to design against: with a small token budget the model spends the entire budget on
  reasoning and returns **empty content**.

### 3.7 Context engineering under 16k (and what KV quant buys)
- Best prompt *layout* given cache-aware ordering: what must be immutable, what may churn, where tool
  output goes.
- Evidence-based compaction: what must survive (decisions, file facts, error signatures, rejected
  approaches) for agent success — any published ablations on trajectory reduction?
- Effective vs advertised context for this model class on code: how much of 16k–32k is actually used well?

### 3.8 Subagent architecture when the main model is serialized
Most multi-agent results assume cheap parallel API calls. We have one GPU and a CPU-offloaded main model.
- Which patterns survive that constraint, and which are pure overhead? Be specific about decomposition,
  delegation, independent verification, review panels and repair loops.
- Where do subagents actually help on software tasks — localization, verification, parallel edits in
  isolated worktrees, integration? Integration is the reported failure point of multi-agent coding
  systems; what mitigations are proven?
- How much context should a child inherit? Any measured guidance on capsule size?
- Can a **2–9B sidecar reliably critique a 35B's code**, or is small-model review wishful thinking?
  Evidence either way — we run ~30 sidecar jobs and want to know which classes are real.
- What should a sidecar be *besides* an LLM worker: reranker (is a small cross-encoder better than an LLM
  for file ranking?), embedder, cache warmer, speculative prefetcher?

### 3.9 Learning from our own receipts (and whether it is affordable here)
We have durable event logs, execution receipts, verifier grading and a disjointness firewall — every
verified run is a labelled preference pair produced for free.
- **Is any of this trainable on 8 GB VRAM / 32 GB RAM?** Be concrete: QLoRA on a 2B is presumably fine;
  is LoRA on a 35B MoE Q5 plausible at all on this box, or is that a cloud-only step? Do not hand-wave.
- **LoRA adapters as specialists**: llama.cpp per-request adapter selection — current status, switching
  cost, and whether adapters can absorb playbook/prompt tokens (buying back context at 16k).
- Preference-tuning (DPO and successors) on execution-verified pairs: what sample sizes actually move a
  small model, and what are the known collapse/regression failure modes?
- Training an **outcome-reward model** from harvested trajectories: what works at 2B scale, and how is it
  validated without leaking the eval set?
- Contamination hygiene when training on your own benchmark-adjacent traces.

### 3.10 Evaluation — Terminal-Bench 2 specifically
**We trust Terminal-Bench 2 over our own eyes.** Bias the evaluation research toward it.
- How TB2 is scored, what its harness assumes, and the known ways agents over- or under-perform on it for
  harness reasons rather than model reasons.
- What is a credible TB2 result for a 35B-class *local* model, and what do the best open harnesses do
  differently? Which TB2 task families are realistically reachable for a 3B-active model versus hopeless?
- How many tasks/seeds before a claimed improvement is real, given TB2's size and variance?
- The comparison we intend to publish is **same model, same hardware, Kitten vs a thin baseline harness**.
  What confounds that comparison and how do we run it so a skeptic believes it?
- Secondary: how to build a **hidden-oracle** battery (model never sees the test) robust to
  reasonable-but-different implementations — we have been burned by brittle scoring producing fake
  "hard tasks".

---

## 4. Deliverable format

1. **Executive ranking** of every technique: expected win (with units), implementation cost, risk, and
   whether it is llama.cpp-only.
2. **The five experiments to run first**, in order, each with exact flags/commands, what to measure, and
   the number that would make us adopt or drop it.
3. **A "do not bother" list** with reasons — specifically things that are good advice on a
   GPU-resident model and bad advice at 8 GB with CPU-offloaded experts.
4. Exact API/flag names, version constraints, known bugs.
5. Citations with dates; flag anything that changed in the last six months.
6. Explicitly separate **measured results** from **plausible reasoning**.

## 5. Non-goals

No prompt-engineering tricks for better prose. No hosted-API features. No agent frameworks as products.
No UI/UX. Do not recommend "use a bigger model" or "use a cloud API" — the product is a private,
single-workstation agent. Do not propose anything from §2 as new work.

## 6. Open questions we most want answered

1. Highest-value use of KV-cache control for a coding agent — warm repo prefix, branched candidates,
   per-session slots, or durable cross-restart cache? Rank with numbers.
2. Can constrained decoding **eliminate** malformed tool calls and hallucinated paths, and at what
   quality cost?
3. In a **weight-streaming-bound** offload regime, is batched shared-prefix best-of-N nearly free, and at
   what N does 8 GB of KV stop us?
4. Do logprob signals let us spend compute only where the model is unsure, better than uniform escalation?
5. Without a draft model, what is the best speculation route — **MTP**, self-speculation, or n-gram
   lookup — and is any of it usable in llama.cpp today?
6. How do we cut over-thinking without losing what thinking buys us?
7. Which subagent patterns beat one well-verified agent when the main model cannot run concurrently?
8. What would make a skeptical engineer believe a Kitten TB2 number?

## 7. Claims we currently believe — please falsify or confirm

State clearly which of these survive contact with evidence **in our regime**:

1. "A 2B drafting a 35B-A3B typically gives 1.5–2.5× decode speedup." *(We cannot use a draft model
   anyway — but is the underlying speculation win real when experts stream from CPU?)*
2. "One-prefill-N-decode makes best-of-N candidates 2..k decode-only, cutting Ascent wall-clock 2–4×."
3. "KV quantization gives 2–4× effective context at the same VRAM with acceptable quality loss on code."
4. "Anchored edit-script grammars beat whole-file rewrites by ≥30% tokens with no loss in apply success."
5. "FIM/infill halves the token cost of single-region edits."
6. "Prompt-lookup drafting is nearly free and accepts at a high rate on restatement-heavy repair turns."
7. "Small models fail on format far more than on reasoning" — is format really the dominant failure mode
   for a 3B-active reasoning model on agentic coding, or is that a 2023-era claim?
8. "QLoRA nightly training on harvested trajectories is feasible on this hardware."
