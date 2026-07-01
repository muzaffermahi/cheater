# Retrieval ablation report

Date: 2026-06-22

## Scope

This report evaluates memory retrieval only. No LLM was called for the retrieval
comparison, and no agent solve-rate or benchmark-score claim is made.

Corpus: `data/compact_bug_cards.jsonl` (836 cards)

Canonical comparison artifact: `retrieval_comparisons/20260622_145338`

## Offline cross-field protocol

Each card is queried using its title, error signature, and symptoms. Candidate scoring
cannot use those fields or `search_text`; it sees only root cause, fix pattern, patch
essence, framework, bug type, and changed files. Recovering the source card therefore
measures symptom-to-fix coherence rather than trivial same-field lookup.

This is an internal retrieval sanity check. It is not downstream task relevance and is
not an SWE-bench metric.

| Strategy | R@1 | R@3 | R@10 | MRR |
| --- | ---: | ---: | ---: | ---: |
| Legacy weighted overlap | 0.555 | 0.695 | 0.823 | 0.647 |
| BM25F | 0.908 | 0.963 | 0.983 | 0.937 |

BM25F is deterministic, dependency-free, field-weighted, IDF-aware, and length
normalized. Legacy remains the default so historical runs are not silently relabeled.

## Confidence filter calibration

The `bm25_filtered` strategy requires:

- at least two matched high-IDF query anchors; and
- a top-versus-runner-up BM25 score margin of at least 5.

On the 836-card holdout, margin 5 produced 97.6% precision among accepted top results at
85.4% coverage. The filter returns at most one memory and records its score, runner-up,
margin, anchors, matched terms, coverage, thresholds, and accept/reject reason.

These thresholds are calibrated only on cross-field card recovery. They remain an
ablation setting, not a universal relevance guarantee.

## Ten-task prompt-only comparison

Legacy artifact: `retrieval_ablation_runs/legacy_fixed/20260622_144831`

Filtered artifact: `retrieval_ablation_runs/bm25_filtered_labeled/20260622_145116`

Comparison: `retrieval_ablation_runs/comparison`

Both arms contain ten complete dry-run results and zero agent errors.

| Strategy | Tasks with memories | Total memories attached |
| --- | ---: | ---: |
| Legacy | 10/10 | 30 |
| BM25 filtered | 1/10 | 1 |

There are no exact ItsDangerous cards in the corpus. One strong cross-project analogy was
manually reviewed and annotated:

- task: `itsdangerous_future_timestamp`
- memory: `pydantic__pydantic-1605`
- rationale: both root cause and fix concern negative timestamp handling
- limitation: this is an analogous fix, not the exact historical ItsDangerous patch

On that one labeled task, legacy misses the reviewed memory in its top five, while raw
and filtered BM25 rank it first. No weaker candidate was labeled merely to improve the
metric.

Non-legacy local-eval variants receive explicit labels such as
`cheater_qwen__bm25_filtered`, and benchmark prediction names include
`cheater-qwen-bm25-filtered`. This prevents result-merging collisions with legacy runs.

## Windows reliability fix

The first legacy dry run encountered a card containing a control/non-ASCII character and
raised a Windows console `charmap` encoding error. Memory previews now escape characters
that the active console encoding cannot represent while preserving full UTF-8 text in
artifacts. The rerun completed all ten tasks.

## Next measurement

The next expensive step is a real ten-task Qwen arm using `bm25_filtered`, compared with
the frozen baseline and legacy-memory matrices. It should run in disposable worktrees or
with separately authorized restoration. Until that run exists, the evidence supports
improved retrieval coherence and noise reduction only—not improved coding-agent solve
rate.
