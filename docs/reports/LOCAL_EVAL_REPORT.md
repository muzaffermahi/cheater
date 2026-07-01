# Local Qwen evaluation report

> Historical first matrix. The stricter successor with isolated worktrees, canonical prompt
> hashes, filtered semantic retrieval, and repaired retry measurement is documented in
> `FAIR_LOCAL_EVAL_REPORT.md`.

## Scope

This is a local harness calibration, not a SWE-bench score. It covers ten real historical
Pallets/itsdangerous regressions prepared as clean Git worktrees. Every configured test
was independently verified to fail at the prepared base commit and pass after applying
the corresponding upstream fix.

## Frozen configuration

- Model: `qwopus3.5-9b-coder` (local Qwen 3.5 9B coder, Q4_K_M)
- Endpoint: LM Studio on `http://127.0.0.1:1234/v1`
- Context: 8192 tokens
- Sampling: temperature 0, seed 0
- Agent budget: 8 tool turns per attempt
- Retrieval: current compact-memory lexical ranking, top 3
- Retry budget: one repair attempt after a failing test
- Test command: `python eval_regression.py` in each prepared worktree
- Repository policy: clean pinned base commit, explicit hard reset between runs, final restore

## Results

| Variant | Solved | Failed | Unknown |
| --- | ---: | ---: | ---: |
| `baseline_qwen` | 4 | 6 | 0 |
| `cheater_qwen` | 2 | 8 | 0 |
| `cheater_qwen_retry` | 3 | 7 | 0 |

Pairwise against baseline:

- Memory only: 0 improvements, 2 regressions, 8 unchanged.
- Memory plus retry: 0 improvements, 1 regression, 9 unchanged.
- Retry recovered `itsdangerous_secret_key_compat` after its first memory-augmented attempt failed.

The current retrieval is therefore not beneficial on this corpus. Retrieved memories were
often matched by exception vocabulary such as `AssertionError`, `TypeError`, or
`AttributeError` while describing unrelated mechanisms. No score claim should be made from
this narrow, single-project task set.

## Artifacts

- Baseline: `eval_runs_local_baseline/20260621_194858/`
- Memory: `eval_runs_local_memory/20260621_200057/`
- Memory plus retry: `eval_runs_local_memory_retry/20260621_200930/`
- Merged report: `eval_comparisons/qwen_local_10_matrix/summary.json`
- Human-readable matrix: `eval_comparisons/qwen_local_10_matrix/summary.md`
- Task-set validation: `eval_task_validation/20260621_190255/`

Each run contains prompts, retrieved memory IDs and scores, tool events, test output, Git
diffs, pre/post repository snapshots, retry queries, and restoration evidence.

## Harness findings

Two failures discovered during calibration were fixed before freezing the matrix:

1. Git subprocesses under the Windows sandbox needed a process-scoped `safe.directory` for
   the explicitly evaluated repo. No global Git trust setting is changed.
2. Whole-file writes caused the 9B model to reread source repeatedly. A hash-guarded
   `replace_text` tool now permits one exact surgical replacement and preserves Windows
   newline style. Repeated-read stagnation is detected and bounded.

## Next gate

Cached SWE-bench Verified metadata sampling, dry-run prompt generation, and prediction JSONL
export are verified. A real subset run still requires a separately authorized prepared
benchmark worktree at the exact metadata `base_commit`, followed by the official evaluator
for any score claim.
