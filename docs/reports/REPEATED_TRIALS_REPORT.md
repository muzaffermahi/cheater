# Repeated paired-trial measurement milestone

## Outcome

`run_eval.py --trials N` now repeats every selected task/variant in an independent detached
worktree. Trial indices are stored in each result and appended to variant labels only when
`N > 1`, preserving existing single-trial artifact names.

Real repeated runs require disposable worktrees or explicitly authorized reset mode. Every
trial therefore begins from the same task commit, captures its own prompt hash, patch, tests,
and repository lifecycle, and cannot contaminate the next trial.

## Comparison semantics

`compare_eval_results.py` pairs baseline trial 1 only with candidate trial 1, and so on. It
does not form a cross-product across trials. Reports now include:

- exact variant/trial counts;
- configuration-level solve rates and Wilson 95% intervals;
- tasks with mixed outcomes across repeated trials;
- tasks whose prompt hashes drift across trials;
- paired improvements, regressions, and unchanged task-trials;
- paired effect size and exact McNemar p-value;
- prompt-equivalence counts and no-memory prompt mismatches.
- identical-prompt outcome divergences, including the stricter subset where no memory or
  successful retry intervention occurred.

These statistics quantify uncertainty; they do not turn a narrow local corpus into an
official benchmark.

## Verification

The lifecycle smoke at `repeated_trial_smoke_runs/20260622_214717/` used two tasks, all three
Qwen configurations, two trials, isolated worktrees, and `--preflight-only`:

- 12 result artifacts were created;
- six exact trial-labeled variants collapsed into three configurations;
- pairwise reporting produced two matched trials per candidate, not four cross-pairs;
- all three configurations had zero prompt-drift tasks;
- both candidate comparisons had zero no-memory prompt mismatches;
- all prepared source repositories remained clean;
- no model completion was sent and no solve outcome was claimed.

The next expensive measurement is a multi-trial real Qwen run. The existing 7/10, 7/10,
9/10 matrix remains a one-trial calibration until that run is complete.

## Real two-trial probe

`C:\Users\LENOVO\Desktop\cheater_real_repeated_probe\20260622_214914\` ran
`itsdangerous_string_expiry` twice through all three configurations:

| Configuration | Solved trials | Wilson 95% |
| --- | ---: | ---: |
| `baseline_qwen` | 1/2 | 9.5%-90.5% |
| `cheater_qwen__bm25_filtered` | 2/2 | 34.2%-100% |
| `cheater_qwen_retry__bm25_filtered` | 2/2 | 34.2%-100% |

All six initial prompts had the same SHA-256 and no memory was retrieved. Baseline trial 2
failed while the nominal memory arm passed, so the apparent memory improvement is labeled
an identical-prompt, no-intervention divergence: runtime variance, not a Cheater gain.

Both retry trials failed their first attempt and passed their second. The retry comparison's
one improvement over baseline is therefore intervention-backed, although two trials are far
too few for a stable rate (exact paired McNemar p=1.0). All six worktrees cleaned up and the
source repo remained clean.

This probe justifies a future full repeated matrix as a measurement exercise. It does not
justify replacing the frozen one-trial result or claiming that memory improved performance.
