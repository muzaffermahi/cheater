# Research brief: turning full local-inference control into a coding-agent advantage

You are researching for **Kitten**, a local-first coding agent (a native Windows desktop app) that runs
against a **local inference server we fully control**. Unlike agents built on hosted APIs, we own the
whole stack below the prompt: the server process, its launch flags, the KV cache, sampling, slots,
grammars, logits. Today we use almost none of that. Your job is to find, verify and rank the techniques
that convert that control into measurable coding-agent quality, latency and cost wins — and to tell us
honestly which ones are folklore.

Assume the reader is a competent systems engineer who will implement your findings. Prefer primary
sources (llama.cpp source/docs/PRs, papers with released code, reproducible benchmarks) over blog
summaries. **Where you are uncertain, say so and say what experiment would settle it.**

---

## 1. The system you are optimizing

**Runtime.** An OpenAI-compatible local server. Two concrete targets:
- **llama.cpp** `llama-server` (native — exposes grammars, logprobs, `cache_prompt`, slots, `/completion`,
  `/tokenize`, speculative decoding flags).
- **LM Studio** (OpenAI-compatible proxy; a strict subset — no slot control, no GBNF, limited sampling).

Kitten already probes which one it is talking to and caches a capability profile.

**Models (single workstation, one GPU).**
- Main: `ornith-1.0-35b` — a **35B MoE with ~3B active parameters** (an A3B-class reasoning model). It
  emits `reasoning_content` separately from `content`, and it will spend an entire small token budget on
  reasoning and return empty content — we have been bitten by this repeatedly.
- Sidecar: `qwen3.5-2b` (fast, no reasoning tax, clean JSON) — also available: `qwopus3.5-9b-coder`.
- Typical context window in use: **16k tokens**. Estimated free system memory ~27 GiB.
- Throughput: tens of tokens/s. **First token on a cold model: 30–90 s.**
- Both models normally share **one endpoint**, so requests are serialized process-wide today.

**Agent architecture (what the tokens are spent on).** A router picks an execution lane
(answer / direct / reliable / best-of-N / "ascent"); work is decomposed into verified steps; a durable
subagent DAG can spawn child agents with scoped file permissions and isolated git worktrees; a "sidecar
control plane" runs ~30 bounded, schema-validated clerical jobs (classification, ranking, compaction,
test selection, failure triage, postflight review) with deterministic fallbacks; a workspace index
provides files/symbols/imports/tests. Completion is gated on execution receipts, not model prose.

**The thesis to test:** for 35B-class local models, *harness-level control of inference* (cache,
constraints, uncertainty, scheduling) is worth more than model swaps — and it is the durable moat,
because no hosted-API competitor can implement it.

---

## 2. What we already know — do not re-derive

- Structured tool-calling, verification-before-completion, and execution receipts matter. We have them.
- Small models benefit from a narrow, typed action space rather than a raw shell. We have that.
- Prompt/context bloat hurts small models. We already compact and bound context.
- Reasoning models need token headroom or they return empty content. Known.
- "Just use a bigger model" is not available: this is the hardware.

Spend your effort **below** the prompt layer, and on the scheduling/orchestration questions in §3.8.

---

## 3. Workstreams

For **each** workstream deliver: (a) what is actually possible today, with exact API/flag names and
version caveats; (b) expected magnitude of the win, with numbers and the conditions they hold under;
(c) implementation sketch against our seams; (d) failure modes and how to detect them; (e) the cheapest
experiment that would prove or kill it on our hardware.

### 3.1 KV cache and prefix reuse as a first-class resource
The central question: **how much of a coding agent's latency can be eliminated by never recomputing a
prefix?**
- Exactly how does `llama.cpp` prompt caching work today — `cache_prompt`, slot assignment, longest-common-prefix
  matching, what invalidates a cache, what happens on partial mismatch mid-prompt?
- **Slot save/restore to disk** (`--slot-save-path`, slot save/restore endpoints): current API, cost of a
  save/restore vs recompute, size on disk per 1k tokens at our model size, and whether restore is
  bit-exact across server restarts.
- Can we keep a **warm "repo capsule" KV state** (system prompt + project conventions + file map) and
  branch every turn, every candidate, and every subagent from it?
- **Cache-aware prompt ordering:** quantify the cost of putting anything volatile (timestamps, changing
  file lists, tool output) before stable content. What is the real token-recompute penalty per turn in a
  20-turn agent loop?
- Multi-conversation: with N slots, what is the eviction policy, and can we pin a slot per active session?
- Does KV cache quantization (`--cache-type-k/v` q8_0, q4_0) change accuracy on *code* tasks specifically,
  and how much context does it buy? Find code-specific evidence, not general perplexity.

### 3.2 Constrained decoding: make malformed output structurally impossible
- GBNF grammars in `llama.cpp`: current syntax, performance cost of a large grammar, and how grammars
  interact with prompt caching and with speculative decoding.
- **Tool calls that cannot be malformed** — is a full JSON-schema-derived grammar worth it vs constraining
  only the structural skeleton and leaving free-text fields open?
- The one we most want validated: **constrain generated file paths to a grammar built from the actual
  repository index**, making a hallucinated path unrepresentable. Any prior art? Failure modes (new files,
  renames, path prefixes)? Cost of rebuilding the grammar per turn?
- **Logit bias / token banning** as a cheaper alternative: banning refusal openers, banning a forbidden API
  (`[::-1]`, deprecated calls), steering away from a known-bad identifier. Does biasing degrade coherence?
- Constrained *patch* formats (unified diff / search-replace) — can a grammar make an unappliable edit
  impossible, and what does that do to edit quality? (Compare against lenient/fuzzy patch appliers.)

### 3.3 Logprobs and uncertainty as a control signal
We can read per-token logprobs locally, for free, on every generation.
- What are the best-validated uncertainty signals for **code generation** (mean logprob, min-token
  logprob, entropy, margin, self-consistency proxies), and how well do they actually predict wrongness?
- Can uncertainty **replace sampling**? i.e. instead of best-of-N (N× cost), detect a low-confidence
  region and re-sample only that span, or escalate only uncertain tasks.
- Token-level uncertainty for **localization**: does the model's confidence tell us which file/symbol it
  is unsure about, well enough to trigger a targeted read?
- Calibration on a small MoE reasoning model — does reasoning-token logprob behave differently from
  answer-token logprob? Any evidence about A3B/MoE calibration specifically?
- Practical: what does requesting logprobs cost in throughput on llama.cpp?

### 3.4 Speculative decoding and draft models
- Current state of `llama.cpp` speculative decoding: flags, required tokenizer/vocab compatibility,
  measured speedups, and when it *loses*.
- Is `qwen3.5-2b` a viable draft model for a 35B A3B main model (same family/tokenizer)? What acceptance
  rate should we expect on **code** vs prose, and what does that mean in tokens/s?
- **MoE-specific:** with only ~3B active parameters, is the main model already so cheap per token that
  drafting has little headroom? Does the win move from decode to prefill?
- N-gram / lookup decoding (no second model, exploits code repetition — e.g. re-emitting a function
  body). For an agent that constantly regenerates near-identical code, is this the better bet?
- Memory: does hosting a draft model cost us more than it returns, given the sidecar also wants VRAM?

### 3.5 Concurrency: getting parallel work out of one GPU
Our biggest structural constraint — the main model is serialized.
- llama.cpp **parallel slots** (`-np`, continuous batching): what actually happens to per-request latency
  and total throughput when 2–6 requests share a 35B MoE on one GPU?
- Is **best-of-N nearly free** if candidates share a prefix and run in one batch? What is the real curve?
- Can main-model and sidecar work be **co-resident** without thrashing, or is a second small server
  process on CPU strictly better? Numbers for both.
- **MoE expert offload** (`-ot`/`--override-tensor` style: attention on GPU, experts on CPU) — does it
  change the concurrency calculus enough to matter?
- What is the right scheduler policy for a queue of mixed user-blocking, verification, and speculative
  jobs on one device? Look for real systems work here (inference schedulers, SLO-aware batching), not
  just flags.

### 3.6 Context engineering under a 16k budget
- Given cache-aware ordering (§3.1), what is the best *layout* for an agent prompt: what must be
  immutable, what can churn, where does tool output go?
- Evidence-based compaction: what survives compaction without hurting task success — decisions, file
  facts, error signatures, rejected approaches? Any published ablations on agent trajectory reduction?
- Is retrieval-into-prompt or KV-level context reuse the better fit when the "documents" are files we
  already have indexed locally?
- How much context does a 35B actually use well? Find evidence on effective context vs advertised context
  for this class of model, on code.

### 3.7 What else should a 2–9B sidecar be doing?
Today it is a bounded JSON worker. With full local control it could also be a draft model, an embedder, a
reranker, a grammar-constrained classifier, a cache warmer, a speculative prefetcher, or a guard model.
- Which of these are *measurably* worth a GPU/CPU slot on this hardware?
- Is a dedicated **reranker** (e.g. a small cross-encoder) better than an LLM sidecar for file ranking?
- Can the sidecar usefully **predict the next context** and pre-warm a KV prefix before the user submits?
- Guard/critic models at 2–9B: does a small model reliably catch a 35B's coding mistakes, or is this
  wishful? Evidence either way.

### 3.8 Subagent architecture that pays off on serialized hardware
Most multi-agent results assume cheap parallel API calls. We do not have that.
- Which multi-agent patterns survive when the main model **cannot** run concurrently — and which are pure
  overhead? Be specific about decomposition, delegation, review panels, and repair loops.
- What does the evidence say about where subagents actually help on software tasks: localization,
  independent verification, parallel edits with isolated worktrees, merge/integration?
- Integration is the reported failure point of multi-agent coding systems — what mitigations are proven?
- Context isolation: how much should a child agent inherit? Any measured guidance on capsule size?
- Depth/fan-out limits before quality degrades.

### 3.9 Model and quantization choice for this exact box
- For a ~27 GiB budget and one GPU: is a 35B A3B MoE the right main model for *agentic coding*, or does a
  dense 9–14B coder model win on quality-per-second once latency is priced in?
- Quantization sensitivity **for agentic code editing specifically** (not perplexity): where does Q4 vs Q5
  vs Q6 actually start to break tool-call formatting, long-range consistency, patch correctness?
- Does the reasoning-model tax pay for itself in an agent loop that already has structured verification,
  or should we prefer a non-reasoning coder model and spend the tokens on more verified iterations?

### 3.10 How to measure any of this honestly
We have been burned by brittle scoring producing fake results.
- Which benchmarks actually predict real-world agentic coding ability for local models, and what are their
  known contamination and harness-sensitivity problems?
- How should we build a **hidden-oracle** battery (the model never sees the test) that is robust to
  reasonable-but-different implementations? Concrete anti-patterns to avoid.
- How to measure latency-quality tradeoffs fairly when a technique changes both.
- Statistical hygiene: how many tasks/seeds before a claimed improvement is real at this sample size?

---

## 4. Deliverable format

1. **Executive ranking** — every technique from §3, scored on: expected win (with units), implementation
   cost, risk, and whether it works on llama.cpp only or also through an OpenAI-compatible proxy.
2. **The five experiments to run first**, in order, each with the exact command/flags, what to measure,
   and the number that would make us adopt or drop it.
3. **A "do not bother" list** with reasons — things that sound good and are not, for this hardware.
4. Per-technique: exact API/flag names, version constraints, and known bugs.
5. Citations with dates. Flag anything that changed in the last six months.
6. Explicitly separate **measured results** from **plausible reasoning**.

## 5. Non-goals

Do not research: prompt-engineering tricks for better prose, hosted-API features, fine-tuning or training
runs (we are not training), agent frameworks as products, or UI/UX. Do not recommend "use a bigger model"
or "use a cloud API" — the entire point is a local, private, single-workstation agent.

## 6. Open questions we most want answered

1. What is the **highest-value use of KV cache control** for a coding agent — warm repo prefix, branch
   candidates, per-session slots, or cross-turn persistence? Rank them with numbers.
2. Can constrained decoding **eliminate** (not reduce) malformed tool calls and hallucinated file paths,
   and what does it cost in quality?
3. Is local **best-of-N effectively free** with shared-prefix batching, and if so at what N?
4. Do logprob-based uncertainty signals let us spend compute only where the model is unsure — and is that
   better than uniform escalation?
5. Is speculative decoding worth it for a **3B-active MoE**, or is n-gram/lookup decoding the better fit
   for repetitive code?
6. What is the correct **scheduling policy** for one GPU serving user-blocking, verification, and
   speculative work with wildly different deadlines?
7. Which subagent patterns beat a single well-verified agent **when the main model is serialized**?
8. What benchmark would convince a skeptical engineer that a local 35B in Kitten beats the same model in
   a simpler harness — without being gameable?
