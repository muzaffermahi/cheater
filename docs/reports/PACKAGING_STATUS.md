# Cheater eval harness packaging status

Date: 2026-06-23

This is a compact handoff for the current closed-loop evaluator state. It is not
an official SWE-bench score and does not claim a new frozen benchmark result.

## What is packaged

- `run_eval.py`: local eval runner for baseline, memory, retry, Pi, and local Qwen arms.
- `compare_eval_results.py`: honest result comparison with custom configuration pairings.
- `cheater_retry_controller.py`: closed-loop attempt/retry orchestration and artifact capture.
- `qwen_local_agent.py`: loopback-only local Qwen tool-loop adapter.
- `eval_tasks.example.jsonl`: minimal example task format.
- `eval_tasks.jsonl`: 10 local ItsDangerous bug-fix tasks.
- `MEMORY_ABLATION_REPORT.md`: compact-vs-raw memory prompt ablation notes.
- `RETRY_FOCUS_PILOT_REPORT.md`: retry source-context/focus pilot notes.
- `eval_comparisons/retry_focus_pilot/summary.md`: machine-generated pilot comparison summary.
- `eval_comparisons/retry_focus_pilot/summary.json`: machine-readable pilot comparison summary.

## Verification run

Last local verification in this workspace:

```powershell
python -m unittest discover -s tests -v
python -m py_compile qwen_local_agent.py cheater_retry_controller.py run_eval.py compare_eval_results.py tests\test_eval_harness.py
python run_eval.py --help
python compare_eval_results.py --help
python run_eval.py --tasks eval_tasks.example.jsonl --variant both --limit 1 --dry-run
cheater doctor
cheater --bench swebench_verified --sample 2
```

Observed result: all commands completed successfully. The test suite ran 53 tests and passed.

## Local task set audit

`eval_tasks.jsonl` currently contains 10 tasks. Each referenced local task repository was
audited clean and at its declared `base_commit` on 2026-06-23.

## Current evidence-backed result

The strongest frozen local matrix result remains the prior ten-task fair run:

- `baseline_qwen`: 7/10
- `cheater_qwen__bm25_filtered`: 7/10
- `cheater_qwen_retry__bm25_filtered`: 9/10

Do not treat this as an official benchmark score.

The latest retry pilot is deliberately narrower:

- original retry control on `itsdangerous_string_expiry`: 0/2
- retry with source-context windows: 1/2
- retry with source-context windows plus focused policy: 1/2

Interpretation: source-context packaging is worth keeping; focused retry policy remains an
opt-in ablation, not a proven improvement.

## Recommended next step

Stop adding features until one packaging run is repeated end-to-end:

```powershell
python run_eval.py --tasks eval_tasks.jsonl --variant qwen --trials 2 --isolate-worktrees --retrieval-strategy bm25_filtered --retrieval-query-mode semantic --qwen-max-turns 8 --output eval_runs\packaged_qwen_matrix
python compare_eval_results.py eval_runs\packaged_qwen_matrix\<RUN_ID> --output eval_comparisons\packaged_qwen_matrix
```

Only after that repeat is archived should the SWE-bench prepared-repo path be exercised.
