# Making a local model better at agentic work: what the literature says, and what applies to Kitten

Research pass, 2026-07-30. Everything below is mapped to Kitten's actual constraints — one 35B-A3B
at Q5 on 8 GB VRAM, experts streaming from CPU, ~20 tok/s, llama.cpp `n_ctx` 8192, plus a real
qwen3.5-2b sidecar on a second endpoint.

**Reading caveat:** most of these were read as abstracts and fetched summaries, not full papers.
Where I give a number, it came from the paper's own abstract or a fetched section — I have not
reproduced any of it. Treat the numbers as claims to verify, not as measurements.

---

## The single most important finding for Kitten

**The generation–verification gap is the bottleneck, not generation.**

[Benchmark Test-Time Scaling of General LLM Agents](https://arxiv.org/html/2602.18998v1) measured
that sampling K=4 trajectories instead of 1 improves pass@K by roughly 50% on average — but
self-choice performance lags that upper bound badly, and *in some cases gets worse as K grows*. The
answer is already in the samples; the agent cannot pick it.

Two consequences, both counterintuitive:

1. They found that **GPT-5 as an external verifier underperformed the models' own internal
   judgment**. So "add a bigger judge" is not the fix. This is direct evidence for Kitten's existing
   design choice — the Ascent verifier ranks by *execution* evidence (red-then-green, regression,
   worked examples, self-probe consensus), not by an LLM opinion. Keep it that way.
2. [T1](https://arxiv.org/pdf/2504.04718) shows *why*: verification is a different and easier skill
   than generation, and small models get disproportionate benefit from tools that let them **check
   by executing** rather than by reasoning. A 2B cannot review a patch, but it can run one.

**Where Kitten already does this:** `verifier.ts` B1 execution eligibility, the finish gate's
execution-receipt requirement, and the "no non-execution signal may be the sole reason a candidate is
final" law.

**The gap that remains:** Kitten's `winnerHasExecutionReceipt` is binary. The literature suggests
list-wise comparison across candidates outperforms pointwise scoring
([Scaling Test-time Compute for LLM Agents](https://arxiv.org/abs/2506.12928) found list-wise
merging best). Kitten's verifier ranks pointwise then sorts. Worth an experiment.

---

## Long-horizon: the constraint is compounding error, not context length

The arithmetic is brutal and worth internalizing: at a **95% per-step success rate, a 10-step task
completes 60% of the time; a 25-step task completes 28%**. Reliability falls off a cliff with
trajectory length regardless of how good the model is per step.

Two families of response, both applicable here:

**1. Decompose and restart at boundaries.** The consistent finding across the long-horizon survey
work is that decomposing into short sub-tasks and *restarting the agent at each boundary* is the
highest-leverage reliability intervention — because a restart discards the accumulated error state.
Recent work branches into a bounded sub-trajectory and then collapses it into a concise summary.

> **Kitten already has the machinery**: `taskGraph.ts` (durable subagent DAG with per-node
> acceptance criteria, allowed/forbidden files, and a bounded capsule) and the child-conversation
> spawn path that deliberately withholds the parent transcript. What is missing is *automatic*
> decomposition — today a plan only exists if something creates it. The Task Compiler now produces
> exactly the typed contract a decomposer would need as input.

**2. Redundancy beats chain length.** If atomic steps have error rate `p` and you sample `n`
independent outputs selecting by consensus, system error becomes roughly `O(p^⌈n/2⌉)` — falling
exponentially with redundancy instead of compounding multiplicatively with length. This is the
formal argument for why Ascent's k=2 + consensus is the right shape, and why *shorter* verified
segments beat longer unverified ones.

**Caveat I'd apply to Kitten:** the measured cost of Ascent on this hardware was **589 s for one
task** (two candidates, serialized through one GPU). Redundancy is exponentially effective and
linearly expensive, and on 20 tok/s the linear term dominates the user's patience. Decomposition
into short verified segments is the cheaper half of this trade.

---

## Context: Kitten is nowhere near the ceiling, and that changes the advice

The sequential-scaling ceiling measured for large models is ~112K tokens (Qwen3-235B) and ~96K
(Gemini 2.5-Flash) — beyond which extra compute yields nothing.

**Kitten runs at 8192.** So the fashionable long-horizon-context literature is mostly aimed at a
problem you do not have. What you *do* have is the failure I measured this session: Task B died with
`Context size has been exceeded` because the harness assumed 16K while the server had 8K.

What still transfers:

- **Context rot is architectural, not a capability gap.** Primacy comes from the first-token
  attention sink; recency from causal masking and rotary decay; the middle is starved by neither.
  Training does not fix it. Practical implication: *position matters more than length* at 8K.
  Putting the current task contract last (which the Task Compiler now does) is aligned with this,
  and so is keeping the stable prefix genuinely stable.
- **Structured eviction beats summarization.**
  [Beyond Compaction](https://arxiv.org/pdf/2606.11213) annotates the trajectory as typed,
  dependency-linked episodes and evicts by dependency rather than compressing uniformly — reportedly
  beating StreamingLLM and MemGPT. This is the same shape as the architecture report's Context
  Ledger with retention classes, and Kitten has neither yet.
- [CompactionRL](https://arxiv.org/pdf/2607.05378) and
  [Self-Compacting agents](https://arxiv.org/pdf/2606.23525) go further and *train* the compaction
  policy. Out of scope for now, but the framing is worth keeping: accumulated context is not merely
  expensive, it is actively harmful.

---

## Test-time compute: what the best 2026 result actually did

[Scaling Test-Time Compute for Agentic Coding](https://arxiv.org/abs/2604.16529) is the most
directly relevant paper I found. Reported gains: **SWE-Bench Verified 70.9% → 77.6%** (Claude-4.5-
Opus) and **Terminal-Bench 2.0 46.9% → 59.1%** (Terminus 1).

Their framing: test-time scaling for long-horizon agents is fundamentally about **representation,
selection and reuse** — not about generating more attempts. Two mechanisms:

- **Recursive Tournament Voting** — narrow a population of rollout *summaries* by small-group
  comparison (note: comparisons, i.e. list-wise, matching the finding above).
- **Parallel-Distill-Refine** — condition each new attempt on summaries distilled from prior
  attempts, keeping salient hypotheses, progress and failure modes while discarding low-signal trace.

**This is the highest-value unimplemented idea for Kitten.** Ascent currently generates k candidates
*independently* and compares finished workspaces. It does not distill a failed candidate into "what
was tried and why it failed" and feed that to the next attempt. On 20 tok/s hardware, where you can
afford very few rollouts, making each rollout benefit from the last one's failures is worth far more
than adding a third independent rollout.

---

## Training on your own receipts — the cheapest unexploited asset

[Step Rejection Fine-Tuning](https://blog.jetbrains.com/research/2026/06/step-rejection-fine-tuning/)
(JetBrains, Qwen2.5-Coder-32B, SWE-bench Verified):

- Standard rejection-sampling FT discards failed trajectories — about **61%** of collected runs in
  SWE-smith.
- But analysis of failed runs showed only up to **24%** of steps were actually wrong; the remaining
  ~76% was productive exploration.
- Their method uses one cheap critic call per trajectory to label each step
  good/unnecessary/mistake/recover, then **masks the loss on harmful steps**.
- Result: 30.9% (standard RFT) → **32.2%** (SRFT). Training on masked *unresolved* trajectories
  alone still reached 29.7%.

**Why this matters here specifically:** Kitten already persists every run as durable, event-sourced
receipts with execution evidence, changed files, and terminal grades — including failures. That is
exactly the dataset SRFT needs, and it is currently written and never read. The critic role is a
textbook sidecar job: bounded, per-step, closed-label, cheap. And a 2B on a second endpoint is now
available to run it.

Related: [SWE-Gym](https://arxiv.org/pdf/2412.21139) and
[SWE-smith](https://arxiv.org/pdf/2504.21798) for trajectory data at scale;
[Kimi-Dev](https://arxiv.org/pdf/2509.23045) for the "agentless training as skill prior" framing.

---

## Logic and structured output: a direct caveat on what I shipped today

[When Correct Isn't Usable](https://arxiv.org/html/2605.02363v1) is uncomfortably relevant to the
sidecar fix I made this session. Their finding: small models hit 77–85% *task* accuracy on GSM8K but
**0% joint accuracy** — correct answer AND valid schema — because format failures are systematic
(one model wrapped every response in markdown fences).

That is precisely the failure I measured in Kitten's sidecar, and my fix (`json_schema` → GBNF) is
their CONSTRAINED arm. **But their numbers should temper my confidence:**

| Strategy | GSM8K output accuracy |
|---|---|
| naive | 0% |
| static prompt | 0–74% |
| **constrained decoding** | **15–52%** |
| iterative prompt optimization | 84–87% |

They report constrained decoding costs **3.6×–8.2× latency** and *sometimes degrades task
performance* — the grammar guarantees shape but can distort content. Their better result came from
optimizing the prompt with a strong meta-model instead.

**Honest read for Kitten:** my schema fix demonstrably changed sidecar jobs from "always falls back"
to "returns real reviews", which is a large win from a low base. But I have not measured whether the
constraint degrades the *content* quality versus a well-written unconstrained prompt, and this paper
says that is a real risk. That is now a specific experiment worth running, not an assumption.

For logic specifically: [Improving Symbolic Translation](https://arxiv.org/abs/2601.09446) finds
that splitting inference into predicate generation then translation — with a verification module
targeting a specific error class — beats self-iteration, which depends on the very capability the
small model lacks. The general pattern holds across this literature: **decompose the structured task
and verify each stage deterministically, rather than asking a small model to self-correct.**

---

## Inference-level levers (Kitten's unique advantage)

The agent literature is almost entirely written above the inference layer. Kitten owns llama.cpp, so
these are available and mostly unexploited:

- **Speculative decoding / MTP** — reported 1.5–3× throughput. Local inference is
  memory-bandwidth-bound, not compute-bound, which is exactly your regime (24.7 GB of weights
  streaming past an 8 GB card). This is the single biggest lever on the 20 tok/s number, and you
  already ruled the sidecar out as a draft model in favour of MTP.
- **KV quantization** — Q4 KV validated for speculative decoding with no measurable quality loss;
  Kitten currently runs q8_0 KV.
- **Slot save/restore for a warm repo capsule** — still unmeasured (experiment E1 from the earlier
  inference pass).

---

## Evaluation: stop trusting pass@1

[Beyond pass@1](https://arxiv.org/pdf/2603.29231) argues single-run metrics systematically
misrepresent agent reliability, and recommends multiple runs with variance and confidence intervals,
stratified failure-mode analysis, and reliability-engineering framing rather than a binary rate.

This is directly relevant to my own two-task measurement earlier today: **n=1 per task**. Task A
scoring 9/9 and Task B 13/13 is real evidence the harness produces correct code, but it is not a
reliability estimate, and I should not present it as one. Also relevant:
[AgentLens](https://arxiv.org/pdf/2605.12925) documents a "lucky pass" problem in SWE-agent
evaluation — agents passing for the wrong reason.

---

## What I would actually build next, in order

Ranked by (value on this hardware) ÷ (effort), given what already exists in the codebase.

1. **Distill-and-reuse across Ascent candidates** (PDR-style). Convert each finished/failed candidate
   into a bounded structured summary — hypothesis, what changed, which check failed — and condition
   the next attempt on it. Highest reported gains in the literature, and Kitten already has the
   candidate slate and receipts. Does not need more rollouts, which is what makes it affordable at
   20 tok/s.
2. **Sidecar step-critic over stored failed runs** (SRFT critic, without the fine-tuning). One cheap
   2B call per failed trajectory labelling steps good/unnecessary/mistake/recover. Immediate value as
   a failure card; later becomes the training label set. Fits the sidecar's proven competence
   profile: bounded, closed-label, externally checkable.
3. **A/B the schema constraint I just shipped.** Measure schema-constrained vs a well-written
   unconstrained prompt on sidecar job quality, per the 3.6–8.2× latency and content-degradation
   warning. I introduced this on strong evidence for *shape* and no evidence for *content*.
4. **Automatic decomposition from the compiled contract.** The Task Compiler emits typed
   deliverables and a verification contract; `taskGraph.ts` consumes exactly that shape. Wiring them
   turns compounding-error arithmetic in your favour.
5. **Speculative decoding / MTP.** Biggest single multiplier on wall-clock, entirely below the agent
   layer, and independent of everything above.
6. **Context Ledger with retention classes** — lowest urgency *for you specifically*, because at 8K
   you are far from the ceilings this literature studies. Revisit if `n_ctx` grows.

---

## Sources

- [Scaling Test-Time Compute for Agentic Coding](https://arxiv.org/abs/2604.16529)
- [Scaling Test-time Compute for LLM Agents](https://arxiv.org/abs/2506.12928)
- [Benchmark Test-Time Scaling of General LLM Agents](https://arxiv.org/html/2602.18998v1)
- [T1: Tool-integrated Verification for Test-time Compute Scaling in Small Language Models](https://arxiv.org/pdf/2504.04718)
- [Beyond Compaction: Structured Context Eviction for Long-Horizon Agents](https://arxiv.org/pdf/2606.11213)
- [CompactionRL](https://arxiv.org/pdf/2607.05378) · [Self-Compacting Language Model Agents](https://arxiv.org/pdf/2606.23525) · [Self-GC](https://arxiv.org/pdf/2607.00692)
- [Step Rejection Fine-Tuning (JetBrains)](https://blog.jetbrains.com/research/2026/06/step-rejection-fine-tuning/)
- [SWE-Gym](https://arxiv.org/pdf/2412.21139) · [SWE-smith](https://arxiv.org/pdf/2504.21798) · [Kimi-Dev](https://arxiv.org/pdf/2509.23045)
- [When Correct Isn't Usable: Structured Output Reliability in Small Language Models](https://arxiv.org/html/2605.02363v1)
- [Improving Symbolic Translation of Language Models for Logical Reasoning](https://arxiv.org/abs/2601.09446)
- [Beyond pass@1: A Reliability Science Framework for Long-Horizon LLM Agents](https://arxiv.org/pdf/2603.29231)
- [AgentLens: The Lucky Pass Problem in SWE-Agent Evaluation](https://arxiv.org/pdf/2605.12925)
- [Process Reward Models That Think](https://arxiv.org/abs/2504.16828)
- [XGrammar-2](https://dl.acm.org/doi/10.1145/3786335.3813124) · [NVIDIA: grammar-constrained bash generation](https://developer.nvidia.com/blog/improving-bash-generation-in-small-language-models-with-grammar-constrained-decoding/)
- [llama.cpp vs vLLM (Red Hat)](https://developers.redhat.com/articles/2026/06/15/llamacpp-vs-vllm-choosing-right-local-llm-inference-engine) · [Persistent Q4 KV cache for multi-agent edge inference](https://arxiv.org/html/2603.04428v1)

---

# Implementation status (2026-07-30)

Items 1–5 of the build order are implemented. 1025 tests green, typecheck clean, nothing committed.

## 1. Distill-and-reuse across Ascent candidates — DONE

`cheater-pi/src/core/distill.ts`, wired into the repair round in `ascent.ts`.

The repair round previously seeded from ONE failure — the first candidate that failed a worked
example, or a single error signature — and discarded everything else the round learned. Two
candidates failing for two different reasons meant the second reason was thrown away, so the repair
round could walk straight back into it.

Now every prior attempt is distilled into `{stance, finished, files written, failed commands, error
signature, ground-truth failure}` and rendered as evidence. Deterministic — no model call, so it
costs prompt tokens rather than a rollout. Failures are deduplicated by normalized shape, because an
agent that retries one broken command six times would otherwise crowd out the other candidate's
distinct failure entirely.

Framed as evidence, never instruction — the Task Compiler already demonstrated that a local model
builds whatever the prompt renders.

## 2. Sidecar step-critic over stored runs — DONE

New `critique_steps` sidecar job + `SidecarAssist.critiqueSteps`, persisted as `run.step_critique`.

Labels each step good / unnecessary / mistake / recover and reports `productiveRatio`. Kitten already
persisted every run — including failures — and never read them back; this makes a failed run data
instead of a dead end. The deterministic floor labels a step a mistake only when its own output shows
an error, because a critic that guesses would mask productive exploration as error and delete the
very signal SRFT exists to keep.

## 3. A/B of the schema constraint — DONE, and it reversed the decision

Measured `postflight_review` over the same diff:

| | valid | mean latency | warnings found |
|---|---|---|---|
| qwen3.5-2b constrained | 4/4 | 8175 ms | **0/4** |
| qwen3.5-2b unconstrained | 4/4 | 7020 ms | **2/4** |
| ornith-35b constrained | 3/3 | 25217 ms | 3/3 |
| ornith-35b unconstrained | 3/3 | 18255 ms | 3/3 |

**The prompt hint was the fix, not the grammar.** With the schema described in the prompt, both tiers
produce valid output without the constraint; the grammar adds 16–38% latency and on the 2B it
measurably emptied the content — it guaranteed the shape and cost findings. That matches "When
Correct Isn't Usable" (constrained 15–52% vs prompt optimization 84–87%).

`json_schema` is now opt-in and off by default. The closed-set enum grammar stays on: there the
answer is a single token and the constraint is nearly free.

Sample is small (n=7, one job type, two models) — treat it as a decision to revisit, not a law.

## 4. Automatic decomposition from the compiled contract — DONE

`src/core/taskCompiler/decompose.ts`. Turns a compiled contract into a `taskGraph` DAG: one bounded
worker per writable deliverable plus an integration node, each worker owning exactly one surface and
explicitly forbidden the others.

Deterministic on purpose — a model-authored plan is one more thing to verify, and a wrong split is
paid for by several bounded workers at ~20 tok/s. It **declines** for a single surface, a read-only
investigation, or an unresolved clarification, and caps fan-out at 4. The derived plan is asserted to
pass the existing `validateTaskPlan`, since a plan the controller rejects is worse than none.

## 5. Speculative decoding — IMPLEMENTED, UNMEASURED

`--spec-type ngram-mod` in `buildLaunchPlan`, on by default, switchable via `speculation: "off"`.

No draft model, so no VRAM cost — the reason it beats pairing a small model as a drafter on a card
with nothing spare. Speculative decoding is output-lossless (drafts are accepted only if they match
what the target model would have produced), so the only risk is throughput, never quality. That is
why this defaults on where the schema constraint defaults off.

**Not measured on this machine.** A/B needs a second server instance and there was 1.9 GB free of
31.7 GB with the 35B resident. To measure: stop the live server and compare tokens/s with and without
the flag on a realistic edit prompt.

## 6. Context Ledger — NOT DONE

Deliberately. At `n_ctx` 8192 you are far below the ~96–112K ceilings this literature studies.

---

# A variance result worth recording

Re-running the Task A bug fix (same defect, re-worded prompt) end to end through the full stack:
**7/8 on the hidden oracle**, where the earlier run scored 9/8→9/9. The model used `[...intervals]` —
a *shallow* copy — which fixes the reordering but leaves merged intervals aliasing the caller's inner
arrays.

Two honest readings, and both matter:

1. The second prompt said "reorders and mutates the caller array" where the first said "its inner
   arrays have been changed". The model did what the prompt emphasized. Prompt specificity moved the
   outcome.
2. Regardless of cause, this is a concrete demonstration of the point "Beyond pass@1" makes: a single
   run is not a reliability estimate. My earlier 9/9 and 13/13 were real evidence that the harness
   can produce correct code, and were never evidence of a success *rate*.

The right next measurement is n≥5 per task with variance reported, not another single run.
