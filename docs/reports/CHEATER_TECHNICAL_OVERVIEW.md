# Cheater technical overview

Date: 2026-06-23

This document explains what Cheater is, how it works, and what has been implemented during
the current development push.

## Short version

Cheater started as a Windows-friendly wrapper around Pi that injects useful "memories" from
previously solved bugs into a coding-agent session.

During this work, it became something larger: an evaluation harness for comparing ordinary
coding agents against memory-augmented coding agents on real bug-fix tasks.

The current purpose is not to claim a high SWE-bench score. The current purpose is to make
the measurement loop honest:

- run the same task under multiple agent variants;
- record all prompts, retrieved memories, tests, diffs, and outcomes;
- support retry after failure;
- avoid fake pass/fail results;
- avoid silent destructive Git operations;
- compare results with enough metadata to tell whether memory or retry actually helped.

## What "Cheater" means here

The name is slightly tongue-in-cheek. Cheater does not secretly call a stronger model. It
"cheats" only in the sense that it gives the agent local memory: examples of solved bugs
from a memory corpus.

At runtime Cheater can:

1. inspect the current repo/task/error;
2. build a retrieval query;
3. search local memory cards;
4. write an agent prompt containing task context plus retrieved analogies;
5. launch an agent or local Qwen tool loop;
6. run tests;
7. record artifacts;
8. optionally retry with the latest failure and current diff.

All retrieval is local token/BM25-style retrieval. The harness does not call external LLM
APIs during agent runs.

## Two modes of Cheater

### 1. Interactive wrapper mode

This is the original user-facing mode.

You run:

```powershell
cheater
```

or:

```powershell
cheater --task "Fix failing auth test" --error "Traceback..." --test-command "pytest"
```

Cheater creates a session under the target repo:

```text
.cheater/sessions/<timestamp>_<mode>/
  task.txt
  error.txt
  retrieval_query.txt
  memory_block.md
  initial_prompt.md
  pi_stdout.log
  agent_stdout.log
  test_stdout.log
  git_diff.patch
  session.json
  run_summary.json
```

This mode is useful for doing real work with a human in the loop.

### 2. Evaluation harness mode

This is what most of the recent implementation focused on.

You run:

```powershell
python run_eval.py --tasks eval_tasks.jsonl --variant qwen --isolate-worktrees
```

The evaluator runs prepared bug-fix tasks under controlled variants, stores artifacts, and
then `compare_eval_results.py` summarizes the outcomes.

This mode is useful for answering questions like:

- Does memory retrieval improve outcomes?
- Does retry improve outcomes?
- Does Qwen behave differently from Pi?
- Does BM25-filtered retrieval outperform legacy retrieval?
- Did the agent really pass the declared test command?
- Was the target repo dirty?
- Did a result become `unknown_no_tests` rather than a fake failure or fake success?

## Main implemented files

### `run_eval.py`

`run_eval.py` is the main local evaluation runner.

It reads task rows from JSONL and runs selected variants:

- `baseline_pi`
- `cheater_pi`
- `cheater_pi_retry`
- `baseline_qwen`
- `cheater_qwen`
- `cheater_qwen_retry`

Aliases:

- `both` / `pi`: Pi baseline, Pi memory, Pi memory+retry
- `qwen`: Qwen baseline, Qwen memory, Qwen memory+retry
- `all`: all six variants

Important behavior:

- supports dry runs;
- supports repeated trials;
- supports task selection by limit or task id;
- records full run artifacts;
- refuses unsafe dirty/revision-mismatched task repos unless explicitly allowed;
- can run each task/variant in an isolated disposable Git worktree;
- marks missing test commands as `unknown_no_tests`;
- records retrieval settings, memory IDs, memory scores, prompt hashes, status, test output,
  final diff, and attempt telemetry.

### `cheater_retry_controller.py`

`cheater_retry_controller.py` is the closed-loop orchestration layer.

It handles:

- prompt/session generation;
- initial attempt execution;
- test execution;
- retry attempt construction;
- saving per-attempt artifacts;
- preserving first-failure information;
- collecting final diffs;
- feeding latest failure output and existing diff into retry prompts.

Recent retry improvement:

- retry prompts now parse repo-local traceback frames from the latest failure;
- they attach bounded source windows around implicated lines;
- each source window includes path, SHA-256, traceback line, and numbered context;
- paths outside the repo and files above 2 MB are ignored.

The goal is to stop the model from wasting retry turns rediscovering where the failure is.

### `qwen_local_agent.py`

`qwen_local_agent.py` is a local Qwen tool-loop adapter.

It talks only to a loopback OpenAI-compatible endpoint, for example LM Studio:

```text
http://127.0.0.1:1234/v1
```

It is intentionally not an external API integration.

The adapter exposes safe repo tools to the local model, such as:

- list/search/read;
- replace/write with hash checks;
- run tests;
- inspect git diff.

It also records Qwen event telemetry:

- assistant turns;
- tool events;
- tool counts;
- reasoning characters;
- visible output characters;
- length exhaustion;
- forced tool requests;
- action rescues;
- failure critics.

Recent experimental option:

```powershell
--qwen-retry-focus
```

This affects Qwen retry attempts only. It removes broad repository listing, requires an
immediate tool action, and after too many evidence-only turns restricts the model to edit,
test, and diff tools. In the pilot, this did not improve outcomes beyond source-context
retry packaging, so it remains opt-in.

### `compare_eval_results.py`

`compare_eval_results.py` reads evaluation artifact folders and produces summaries.

It does not treat dry runs, unavailable runs, refused runs, or unknown results as passes or
failures.

It reports:

- task/variant status;
- solved/failed/unknown counts;
- Wilson intervals;
- memory usage counts;
- prompt hashes;
- prompt drift;
- no-memory prompt mismatches;
- no-intervention divergences;
- bug-type stratification;
- paired-trial aggregates;
- exact McNemar p-values for paired comparisons;
- custom configuration pairings through `--pair-config`.

This script is important because the project is trying to avoid fooling itself.

### `eval_tasks.jsonl`

`eval_tasks.jsonl` is the local task set.

It currently contains 10 local ItsDangerous bug-fix tasks.

Each task row contains fields like:

- repo;
- task;
- error/failing output;
- test command;
- expected files;
- notes;
- base commit;
- optional bug type;
- optional known relevant memory IDs.

The repos were audited clean and pinned to their declared base commits on 2026-06-23.

### `eval_tasks.example.jsonl`

This is a minimal example file showing the task format without requiring a real repo.

It is used by the acceptance dry-run command:

```powershell
python run_eval.py --tasks eval_tasks.example.jsonl --variant both --limit 1 --dry-run
```

### `MEMORY_ABLATION_REPORT.md`

This report documents prompt-only memory ablations.

It compared context cost, not solve rate, across:

- compact top-1 memories;
- compact top-3 memories;
- compact top-1 with patches;
- raw solved-trajectory cards.

Result:

- compact cards are much cheaper in prompt bytes;
- raw cards use far more context;
- patch inclusion can cost more than retrieving more compact cards;
- no quality claim was made because these were dry runs.

### `RETRY_FOCUS_PILOT_REPORT.md`

This report documents the latest narrow retry experiment on the remaining failed local task,
`itsdangerous_string_expiry`.

Observed pilot:

- original retry control: 0/2;
- retry with source-context windows: 1/2;
- retry with source-context windows plus focused policy: 1/2.

Interpretation:

- source-context packaging looks worth keeping;
- focused retry policy has no measured benefit yet;
- this is not a benchmark score;
- this is not enough evidence to update the frozen local matrix result.

### `PACKAGING_STATUS.md`

This is the compact handoff file.

It lists:

- packaged files;
- verification commands;
- local task audit;
- current evidence-backed result;
- recommended next step.

## Evaluation flow

The local eval loop is:

1. Load task row from JSONL.
2. Resolve repo path.
3. Check Git state and optional base commit.
4. If not dry-run, run preflight test unless skipped.
5. If no test command exists, mark `unknown_no_tests`.
6. Build retrieval query.
7. Retrieve memory cards, unless baseline disables memory.
8. Generate prompt and artifacts.
9. Run selected agent backend.
10. Run test command.
11. Save result and diff.
12. If retry variant failed, build retry prompt from latest failure and current diff.
13. Run retry attempt.
14. Run test command again.
15. Save final status.
16. Compare results.

## Agent variants

### Baseline variants

Baseline variants do not receive retrieved memories.

They answer the question:

> How well does the agent do without Cheater memory?

### Cheater memory variants

Memory variants receive retrieved solved-bug analogies.

They answer:

> Does retrieved memory help compared with the same backend without memory?

### Cheater retry variants

Retry variants first run like memory variants. If the test still fails, the harness builds a
second prompt using:

- original task;
- latest test failure;
- current diff;
- retrieved memory;
- source windows from traceback frames, where available.

They answer:

> Does closed-loop repair help after an initial failed attempt?

## Git and safety model

Safety is a major part of the implementation.

The evaluator:

- detects dirty task repos;
- records pre-run Git hash/status;
- refuses base commit mismatches;
- records final diffs;
- does not silently reset repositories;
- supports destructive reset only behind explicit flags;
- prefers isolated disposable Git worktrees for repeated trials.

This is why many commands use:

```powershell
--isolate-worktrees
```

That option lets each task/variant run in a separate worktree so the prepared source repo is
not mutated.

## Memory retrieval

Cheater supports retrieval strategies:

- `legacy`;
- `bm25`;
- `bm25_filtered`.

It also supports retrieval query modes:

- `runtime`: include preflight traceback in retrieval query;
- `semantic`: use task and declared error for retrieval while still putting preflight
  evidence in the agent prompt.

Each run records:

- retrieval query;
- retrieved memory IDs;
- scores;
- corpus path;
- corpus format;
- top-k;
- whether patches were included;
- reviewed relevance labels when supplied.

## Benchmark/SWE-bench support

Cheater has preliminary SWE-bench subset support, but it is intentionally conservative.

Implemented behavior includes:

- load cached SWE-bench Lite/Verified metadata;
- sample tasks;
- generate dry-run prompts;
- run on prepared repos when supplied;
- export prediction JSONL;
- refuse to claim official scores without the official evaluator.

Acceptance smoke:

```powershell
cheater --bench swebench_verified --sample 2
```

This samples cached metadata and prints tasks. It does not download or clone large assets.

## Current evidence-backed result

The strongest frozen local matrix result remains:

- `baseline_qwen`: 7/10
- `cheater_qwen__bm25_filtered`: 7/10
- `cheater_qwen_retry__bm25_filtered`: 9/10

This means:

- memory alone was neutral in that run;
- retry added two solved tasks over baseline;
- this is local evidence, not an official SWE-bench score.

The latest retry pilot should be treated separately:

- it tested one task;
- it had two trials per arm;
- it supports source-context retry packaging;
- it does not prove a broad solve-rate gain.

## What I was trying to do most recently

The recent work was no longer about adding shiny features. It was about closing the loop:

1. Build an evaluator that can run baseline vs memory vs memory+retry.
2. Make the evaluator honest about pass/fail/unknown.
3. Make it safe around Git state.
4. Make memory retrieval auditable.
5. Add local Qwen support without external APIs.
6. Add repeated trials and paired comparison.
7. Investigate why the remaining retry failure wasted turns.
8. Add source-context retry packaging.
9. Verify the whole thing with tests and acceptance commands.
10. Package the current state so future work can run from a stable checkpoint.

The immediate next recommended action is not another feature. It is to repeat one clean,
end-to-end packaged Qwen matrix and archive the artifacts.

Suggested command:

```powershell
python run_eval.py --tasks eval_tasks.jsonl --variant qwen --trials 2 --isolate-worktrees --retrieval-strategy bm25_filtered --retrieval-query-mode semantic --qwen-max-turns 8 --output eval_runs\packaged_qwen_matrix
```

Then compare:

```powershell
python compare_eval_results.py eval_runs\packaged_qwen_matrix\<RUN_ID> --output eval_comparisons\packaged_qwen_matrix
```

Only after that repeat is archived should the SWE-bench prepared-repo path be exercised.

## Verification status

Last verified in this workspace:

```powershell
python -m unittest discover -s tests -v
python -m py_compile qwen_local_agent.py cheater_retry_controller.py run_eval.py compare_eval_results.py tests\test_eval_harness.py
python run_eval.py --help
python compare_eval_results.py --help
python run_eval.py --tasks eval_tasks.example.jsonl --variant both --limit 1 --dry-run
cheater doctor
cheater --bench swebench_verified --sample 2
```

Observed result:

- all commands completed successfully;
- the test suite ran 53 tests and passed;
- `cheater doctor` warned that the Cheater project folder itself is not a Git worktree,
  which is expected for this workspace.

