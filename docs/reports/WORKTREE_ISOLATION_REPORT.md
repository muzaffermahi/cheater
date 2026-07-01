# Disposable worktree isolation milestone

## Outcome

`run_eval.py --isolate-worktrees` now runs every task/variant arm in a fresh detached Git
worktree at the requested task commit. The prepared source checkout is read-only from the
evaluator's perspective. Each arm records its source snapshot, target commit, generated
worktree path, cleanup result, final source snapshot, and any cleanup error.

Destructive reset mode remains available only behind its existing explicit authorization.
It cannot be combined with isolation mode. `--keep-worktrees` is the explicit escape hatch
for retaining generated worktrees.

## Verification

- Full suite: 33 tests passed on 2026-06-22.
- Regression tests dirty both tracked and untracked files in a generated arm, remove it,
  and prove the source commit, contents, and Git status are unchanged.
- The full runner wiring is tested, including task-path substitution, lifecycle telemetry,
  patch-arm cleanup, and source-state preservation.
- Local lifecycle smoke: `isolation_smoke_runs/20260622_200129/`.
- Smoke outcome: `not_run_no_auto_send`, no test exit code, no agent execution, generated
  worktree removed, no cleanup error, source commit and status unchanged.

The smoke also exposed and fixed an honesty bug: `--no-auto-send` previously allowed the
test command to run after prompt generation. It now exits with an unknown/not-run outcome
and cannot contribute a pass or failure to comparisons.

## Next experiment

The harness can now run a real Qwen solve-rate ablation without resetting prepared repos:

```powershell
python run_eval.py --tasks eval_tasks.jsonl --variant qwen --limit 10 `
  --isolate-worktrees --retrieval-strategy bm25_filtered `
  --output C:\cheater-qwen-isolated
```

That experiment is a local task-set measurement, not an official SWE-bench score.
