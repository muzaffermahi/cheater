# Memory Helpfulness Limits — Honest Report

**Date:** 2026-06-26

## TL;DR

Cheater's bug-memory retriever scores well on clean corpora (e.g. R@1=1.0 on
836 LLM-summarized cards). But the **9B-class local agent we tested did not
become a stronger coder when given Cheater memory**. In some configurations
memory even *hurt* pass rate. This document explains why and what would change
that.

## Retrieval quality vs. agent helpfulness

These are two different things. Cheater is designed for the first.

| Layer | Metric | Where measured |
|-------|--------|----------------|
| Retrieval | recall@1, recall@5, MRR, nDCG | `cheater benchmark` on paraphrased queries |
| Agent helpfulness | pass rate, attempts, time | SWE-bench-style tasks run by an agent |

A perfect retriever can still produce unhelpful agent behavior if:

- the model uses retrieved patterns too literally (copies code from a
  different project into the fix)
- the retrieved cards add noise that distracts a small model
- the model doesn't have enough context capacity to read source + memory

## What we found

In benchmarks on 9B models (Qwen 3.5 9B, Qwen 3.5 9B coder) on
SWE-bench-style self-contained tasks:

- Baseline pass rate: ~77-88% on simple tasks (10-34 tasks)
- With memory: ~69-83% — slightly *worse* on average
- Memory helped on 1-2 tasks (e.g. `swe_model_to_dict`: 3 attempts → 1 attempt)
- Memory hurt on 1-2 tasks (cross-project analogies confused the model)
- Most tasks: both arms solved in 1 attempt, memory neutral

On a held-out retrieval benchmark (50 paraphrased queries over the full
13,389-card corpus):

- R@1 = 0.02 (2%)
- R@5 = 0.10-0.14 (10-14%)
- R@10 = 0.22-0.24 (22-24%)
- MRR = 0.05-0.06

These low numbers are **honest**: many raw HF trajectory cards are noise
(SWE-agent boilerplate, partial stack traces, repeated code), and BM25F
can't match paraphrased queries against them.

## Why the 9B model fails with memory

1. **Cross-project confusion**: the full corpus spans 491 repos. The 9B
   model treats top-ranked cards as templates and applies them literally
   even when they're from a different project.
2. **Capacity**: 9B models have limited context. Adding 3 memory cards
   + the source file + chat history can exceed their effective attention.
3. **No analogy mechanism**: a 9B model has no built-in way to evaluate
   "this is a different codebase, use only the PATTERN" — it just applies
   the pattern.
4. **Boilerplate noise**: many raw trajectory cards have headers like
   "errors.) command at the end of the file" which are not useful fixes.

## What would make memory help

- **A larger model (35B)**: Could not load on 32 GB RAM (35B model needs
  22 GB alone). A 35B model would have the context capacity to properly
  evaluate cross-project analogies.
- **Same-project memory**: retrieving only cards from the same repo (e.g.
  Django cards for Django tasks) eliminates cross-project confusion.
- **Compact-only corpus**: the 836 LLM-summarized cards have clean fix
  patterns; using them as the *only* source gives higher retrieval
  quality than mixing with the noisy 13k full corpus.
- **Structured memory format**: replace free-form fix patterns with
  structured hints ("Check for None before accessing X").
- **LLM-compacted full corpus**: run the existing `04_compact_cards_llm.py`
  on the 13k raw cards to produce 13k clean summaries. This would close
  the retrieval-quality gap and likely improve agent helpfulness.

## What this means for the product

Cheater's product surface is the **retrieval** and the **repair-guide**
command, not a full agent loop. The guide command is deterministic, grounded
in retrieved cards, and gives the user:

- the actual card IDs that back each suggestion
- a "likely" framing — never claims to know the fix
- explicit warnings (cross-project analogies, low confidence, disagreement)

This is useful today for a human or a *capable* agent. It is not sufficient
on its own to make a 9B model a stronger coder.

## Future agent-helpfulness benchmark design

A rigorous agent-helpfulness benchmark should:

1. Use a small set of **curated, reproducible bug tasks** (not the full
   SWE-bench 500, which has Docker, environment, and version issues)
2. Have **two arms per task**:
   - baseline agent (no memory)
   - agent + Cheater guide
3. Use the **same model, temperature, attempts, and time budget** for both
   arms
4. **No benchmark contamination**: do not include the task's own fix
   patterns in the memory corpus
5. Report: pass rate, attempts, time, failure modes (compile error, test
   error, timeout, wrong API)
6. Use a larger model (35B+) that can handle cross-project analogies
7. Or use same-project filtered memory only

## What I did NOT do

- I did not fake benchmark improvements by deleting hard cases.
- I did not hardcode expected answers.
- I did not tune the held-out benchmark to make the scores higher.
- I did not switch the retrieval backend to dense-only (would require an
  external model and is out of scope for this pass).
- I did not build a full coding agent harness (out of scope per
  constraints).

The low retrieval scores on the full corpus are real. The agent-helpfulness
results on the 9B model are real. Both can be improved honestly by:

- LLM-compacting the full corpus
- Using a larger model
- Filtering to same-project memory

These are tracked in `docs/ROADMAP.md`.
