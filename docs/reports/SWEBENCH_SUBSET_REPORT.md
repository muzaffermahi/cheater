# SWE-bench subset engineering report

Date: 2026-06-22

## Scope and scoring boundary

This report covers one prepared SWE-bench Verified instance as a local harness
engineering exercise. It is not an official SWE-bench evaluation and contains no
benchmark score. Every exported run has `official_evaluation_run: false`.

Instance: `astropy__astropy-12907`

- Repository: `astropy/astropy`
- Pinned base commit: `d16bfe05a744909de4b27f5875fe0d4ed41ce607`
- Prepared worktree: `local_bench_repos/astropy`
- Local smoke: `swebench_smoke_astropy_12907.py`
- Isolated Python environment: `local_bench_envs/astropy12907`

The historical checkout cannot import its compiled extension modules directly on this
Windows host. The smoke test therefore imports an installed compatible Astropy runtime
and loads the checkout's exact `astropy/modeling/separable.py`. This is useful local
repair evidence, but it is not a substitute for the official container evaluator.

## Calibration

The pinned base checkout fails the nested-CompoundModel assertion with 2 mismatched
elements out of 16. A separate validation worktree at historical fix commit
`2f1bfd254` passes the same smoke test. The agent worktree was not modified during this
calibration.

## Baseline Qwen result

Canonical run: `bench_runs/20260622_020929`

- Variant: memory-off local Qwen baseline
- Model: `qwopus3.5-9b-coder`
- Response budget: 4096 tokens
- Retry count: 0
- Preflight: confirmed failing
- Agent status: `qwen_stalled`
- Authoritative post-test: failed
- Exported patch: empty
- Changed files: none
- Repository after run: clean at the pinned base commit
- Official score: not computed

The prediction is still exported in SWE-bench-compatible JSONL form and is labeled
`baseline-qwen-local:qwopus3.5-9b-coder`. An empty patch is the honest prediction for
this run.

Measured adapter telemetry:

- 5 assistant turns
- 2 repository tool events (`list_files`, `read_file`)
- 38,691 reasoning characters
- 3 response-length exhaustions
- 2 forced-tool requests
- 0 edit tool calls

An earlier canonical comparison run without reasoning checkpoints is
`bench_runs/20260622_020057`. It produced the same outcome with 40,328 reasoning
characters. Bounded checkpoint continuity stopped the model from restarting its trace,
but did not make it cross the analysis-to-action boundary on this instance.

## Harness changes prompted by the run

- Reasoning-only responses are never classified as successful completion.
- A nonempty response with `finish_reason=length` is also incomplete.
- The next recovery turn requests a tool and carries a self-contained task reminder.
- A bounded tail of the model's analysis is carried forward as a checkpoint.
- `--qwen-max-tokens` is configurable and recorded.
- `--no-memory` creates an explicit baseline arm and does not load the memory database.
- Prediction model names distinguish baseline and memory-augmented runs.
- Benchmark summaries record reasoning size, visible output size, length exhaustions,
  forced-tool requests, and tool-event counts.
- `--qwen-action-rescue` enables one opt-in compact action phase, reuses the same safe
  tools, records an `action_rescue` event, and gives the prediction a distinct label.

## Gate 7 action-rescue ablation

Canonical rescue run: `bench_runs/20260622_022432`

The rescue arm used the same model, task, 4096-token response budget, memory-off setting,
and zero retries as the canonical baseline. Only `--qwen-action-rescue` changed. The
prediction label is
`baseline-qwen-action-rescue-local:qwopus3.5-9b-coder`.

| Metric | Baseline | Action rescue |
| --- | ---: | ---: |
| Wall time | 404 s | 968 s |
| Assistant turns | 5 | 15 |
| Tool events | 2 | 7 |
| Reasoning characters | 38,691 | 92,438 |
| Length exhaustions | 3 | 8 |
| Edit tool calls | 0 | 2 |
| Exported patch | empty | one file / one line |
| Local smoke | failed | failed |

The rescue crossed the analysis-to-action boundary, made a hash-guarded edit, ran the
configured test, observed exit code 1, and attempted another edit. Its final one-line
patch changed `_coord_matrix`; it was not the historical patch and the authoritative
post-run smoke still failed. The run is therefore recorded as `failed_local_test`, not a
partial solve. Its prediction remains useful negative evidence for later ablations.

After preserving the diff and prediction, the exact agent-generated line was reverted
with a textual patch. No Git reset or checkout was used. The clean-filter hash matches
`HEAD`, the index has no staged diff, and the prepared worktree is clean at the pinned
base commit.

## Next Gate 7 target

The action-rescue mechanism improved edit/action rate but regressed latency and did not
improve solve rate on this instance. The next ablation should be failure-aware
localization after the first rescue test: when the observed failure is unchanged, the
harness should ask a compact critic to challenge whether the edited function is on the
failing path before permitting another edit. It should also test an earlier rescue
trigger so three full reasoning overflows are not paid before the compact phase. Both
changes need separate labels and the same authoritative test boundary.

## Failure-critic and evidence-budget ablations

Interrupted evidence-budget run: `bench_runs/20260622_025903`

This run enabled action rescue, failure critic, and an evidence-turn budget of 5. The
evidence budget activated at turn 5 and the compact phase reached an edit attempt. The
Windows process then exited with `0x40010004`; LM Studio's server was stopped and its
model unloaded. The new incomplete-run auditor finalized the artifact as
`aborted_runtime` with `local_test_passed: null`, `test_exit_code: null`, and
`outcome_definitive: false`. It is not counted as either solved or failed.

Completed failure-critic run: `bench_runs/20260622_140955`

- Prediction label:
  `baseline-qwen-action-rescue-failure-critic-evidence-5-local:qwopus3.5-9b-coder`
- Total turn budget: 15
- Response budget: 4096 tokens
- Memories: disabled
- Retries: 0
- Action rescues: 1
- Failure critics: 1
- Unchanged-failure detections: 1
- Assistant turns: 15
- Tool events: 9
- Reasoning characters: 87,083
- Length exhaustions: 6
- Authoritative local smoke: failed
- Official score: not computed

The agent made one `_coord_matrix` edit and called the configured test. Its failure
signature exactly matched preflight. The critic then exposed only `read_file`,
`search_text`, and `git_diff` for one turn; Qwen selected `read_file`. Editing tools were
restored afterward, but the model exhausted the remaining budget without moving its
hypothesis away from `_coord_matrix`. The final candidate patch failed and was exported
as negative evidence. The exact generated patch was then reverted textually, and the
prepared repo is clean at the pinned base commit.

The critic therefore improved repair-loop discipline but did not improve solve rate on
this instance. The next target is turn allocation and hypothesis quality: trigger the
compact phase early enough to leave room for a post-critic edit and test, and make the
critic explicitly compare the failed patch's execution-path hypothesis with callers or
matrix-assembly code rather than simply rereading the same file. This must remain a
separate ablation; increasing raw reasoning tokens is not supported by the evidence.

Memory ranking remains a second target because the frozen ten-task local matrix showed
memory regression: baseline Qwen solved 4/10, memory Qwen 2/10, and memory plus retry
3/10. No claim beyond those local task outcomes is warranted.
