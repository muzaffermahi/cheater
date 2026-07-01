# Retry localization and focus pilot

Date: 2026-06-23

## Question

The frozen ten-task matrix solved 9/10 with one retry. Its remaining failure,
`itsdangerous_string_expiry`, repeatedly spent an eight-turn retry budget rediscovering the
repository instead of correcting a partial edit. This pilot asks whether better failure
localization or a more constrained action policy helps.

This is one local task, not a benchmark score or a stable solve-rate estimate.

## Changes

- Retry prompts now parse repo-local traceback frames and attach up to two bounded source
  windows around the implicated lines.
- Each window records its relative path, current SHA-256, traceback line, and numbered
  display context. Paths escaping the repository and files above 2 MB are ignored.
- `--qwen-retry-focus` is opt-in. It removes repository-wide listing, requires an immediate
  tool action, and activates the existing bounded action phase after two evidence-only
  turns. During that phase only edit, test, and diff tools are exposed.
- `compare_eval_results.py --pair-config REFERENCE=CANDIDATE` pairs arbitrary exact
  configurations by task and equal trial number, then reports paired delta and exact
  McNemar p-value.
- Attempt artifacts now separate the pre-agent and post-agent diff. Per-attempt Qwen tool
  and rescue metrics are recorded for future runs.

## Final controlled probe

Both arms used the same local model, seed zero, temperature zero, BM25-filtered semantic
retrieval, no retrieved memories, one retry, isolated worktrees, and an eight-turn budget.
There were two trials per arm.

| configuration | source windows | focused policy | solved |
| --- | --- | --- | ---: |
| original retry control | no | no | 0/2 |
| source-context control | yes | no | 1/2 |
| source-context + focused policy | yes | yes | 1/2 |

Pairing original control against source-context control produced one improvement, zero
regressions, and one unchanged trial. The paired delta is +50%, but the exact McNemar
p-value is 1.0 because there is only one discordant pair.

Pairing source-context control against focused policy produced zero improvements, zero
regressions, and two unchanged trials. Focus therefore has no measured outcome benefit in
this pilot and remains opt-in.

The successful patch normalized a numeric string into local variable `exp`, then correctly
used that normalized value in the expiry comparison. The declared regression command
returned exit code 0. Both final arms produced this result in trial 2; trial 1 failed in
both.

Machine-readable and Markdown summaries are under
`eval_comparisons/retry_focus_pilot/`.

## Negative iterations retained as evidence

Before source-window injection, progressively tighter focus variants all scored 0/2:

- focus without bounded rescue: 0/2;
- focus with rescue after two evidence turns: 0/2;
- rescue with action-only tools: 0/2.

The traces showed that removing `list_files` alone merely shifted wasted turns into repeated
searches. Constraining tools alone did not supply the missing localization. This is why the
source-window change, rather than focused policy, is the useful default improvement.

## Interpretation and next gate

The evidence is deliberately weak: one task, two trials, and known local-inference
nondeterminism. It is enough to retain deterministic source-window packaging and reject a
claim that focus improves outcomes. It is not enough to change the frozen 9/10 result or
claim a general gain.

The next valid test is a repeated, isolated run over all first-attempt failures (at least
`none_salt`, `invalid_base64_error`, and `string_expiry`) comparing retry with and without
source windows under a frozen model budget. Focus should remain a separate arm.
