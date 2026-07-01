# Fair local Qwen evaluation report

## Scope

This is a ten-task local ItsDangerous calibration, not a SWE-bench score. Every result has
an independently failing preflight, a real post-agent test outcome, a captured patch, and
a disposable-worktree lifecycle record.

## Frozen configuration

- Model: `qwopus3.5-9b-coder` (local Qwen 3.5 9B coder)
- Endpoint: loopback LM Studio at `http://127.0.0.1:1234/v1`
- Sampling: temperature 0, seed 0
- Agent budget: 8 tool turns and 4096 response tokens per attempt
- Retrieval: BM25 filtered, semantic query, top 3, minimum 2 anchors, score margin 5
- Memory patches: excluded
- Retry budget: one new repair attempt using the latest failed test and existing diff
- Repository policy: one detached Cheater-owned worktree per task/variant arm

## Definitive results

| Variant | Solved | Failed | Unknown |
| --- | ---: | ---: | ---: |
| `baseline_qwen` | 7 | 3 | 0 |
| `cheater_qwen__bm25_filtered` | 7 | 3 | 0 |
| `cheater_qwen_retry__bm25_filtered` | 9 | 1 | 0 |

Memory-only was neutral: 0 improvements, 0 regressions, 10 unchanged. The confidence filter
attached one manually reviewed analogy (`pydantic__pydantic-1605`) to the future-timestamp
task; that task passed in every arm with the same patch. The other nine baseline/memory
prompt pairs were byte-identical and the comparison reports zero no-memory prompt mismatches.

Retry improved two tasks with no regressions:

- `itsdangerous_none_salt`: test sequence `[1, 0]`
- `itsdangerous_invalid_base64_error`: test sequence `[1, 0]`
- `itsdangerous_string_expiry`: test sequence `[1, 1]` in the frozen matrix

The gain is therefore attributable to closed-loop repair, not memory retrieval.

## Integrity evidence

- 30/30 results have definitive Boolean outcomes.
- 30/30 preflights were confirmed failing before agent execution.
- 30/30 generated worktrees were removed without cleanup errors.
- All ten prepared source repositories remained clean.
- Baseline versus memory: 9/10 identical prompt hashes; the only differing pair contains
  the retrieved memory.
- Strategy-suffixed variants participate in pairwise comparisons instead of disappearing
  from the denominator.

Machine-readable and Markdown summaries are under
`eval_comparisons/qwen_fair_semantic_matrix/`.

## Important variance warning

This is one trial per arm. A targeted follow-up ran `itsdangerous_string_expiry` with the
same initial prompt SHA-256 (`4b7b27b55e1b1142c9aaa4d6e338fe830aebe79d2df6ede892cc6baceb7c103f`)
and the same seed-zero settings, but passed where the frozen run failed. Local inference is
therefore not deterministic enough for single-trial differences to be treated as stable
rates. Native repeated paired trials and uncertainty reporting are now implemented and
documented in `REPEATED_TRIALS_REPORT.md`; this frozen matrix itself remains one trial.

## Harness defects found during this milestone

- Qwen previously ignored `auto_send=False`; prompt-only runs could secretly execute.
- Linked worktree `.git` files broke repository-wide search instead of being skipped.
- Absolute arm paths and volatile signature bytes made nominally equivalent prompts differ.
- Strategy-suffixed variants were omitted from pairwise comparisons.
- Runtime tracebacks polluted retrieval while being absent from the coding prompt.
- Retry prompts omitted both the latest post-edit failure and the current patch.

Each defect now has regression coverage. No official benchmark score is claimed.
