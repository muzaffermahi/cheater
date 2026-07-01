# Cheater Gym

Cheater Gym is a local benchmark and self-improvement system for Cheater.
It creates small, disposable repos with known bugs, runs Cheater Mission
Control on them, scores the result, records traces, and turns failures and
successes into memory/skill/anti-pattern suggestions.

It is **not** a new TUI, not a new agent, and not a replacement for Pi.
It is a Pi-native benchmark and learning layer that lives inside the
existing Cheater extension.

## Why

There is no trusted "big project" we can benchmark on every day. So we
built a small local gym that:

* ships 25 tiny reproducible tasks in two languages (Python + JS/TS),
* runs them in temp workspaces,
* measures whether Cheater Mission Control actually helps the model,
* converts the run results into bug-memory, anti-pattern, and skill
  suggestions that the user can accept or reject.

## What is in the box

* **25 zoo tasks** under `cheater-pi/src/gym/zoo.ts`:
  18 Python tasks (import error, off-by-one, async, regex, JSON, cache,
  datetime, type conversion, fixture scope, test state leak, ...), 6
  JavaScript tasks (export, promise not awaited, path, JSON, sort, env
  config), and 1 TypeScript task (type error).
* **Fixture support** under `.cheater/gym/tasks/<id>/repo/` for tasks
  that need a real on-disk repo instead of inline files.
* **A runner** that creates a temp workspace, snapshots a baseline, runs
  Mission Control against the task, collects the diff, and scores it.
* **A scorer** with explicit penalties for editing tests, editing
  dependencies/lockfiles, huge diffs, missing reproduction, and missing
  evidence.
* **Reports**: machine-readable JSON + human-readable Markdown.
* **Learning pipeline** that turns each run into a `bug_memory`,
  `anti_pattern`, or `skill_improvement` suggestion. Suggestions are
  never auto-saved; the user must accept them.
* **Delta mode** that compares Cheater Mission Control to vanilla Pi.
  When the vanilla run is not available the report is generated
  honestly, saying "vanilla mode not available".
* **Default concurrency = 1** to stay safe on 16 GB RAM machines.

## CLI

```powershell
cheater gym list              # list available tasks
cheater gym show <id>         # show one task card
cheater gym run <id>          # prepare workspace + prompt
cheater gym report [latest]   # show the latest report
cheater gym clean             # remove workspaces + reports
cheater gym help              # list subcommands
```

The CLI prepares the workspace and prints the exact Mission Control
prompt that should be sent into Pi. It does not run the model itself,
because Pi owns the agent loop.

## Inside the TUI

`cheater` exposes the same flow as slash commands. Inside Pi:

```
/gym                # help + status
/gym-list           # list tasks
/gym-run <id>       # prepare a workspace, send Mission Control prompt
/gym-run-suite      # run a small suite (mocked or real)
/gym-report         # show the latest report
/gym-delta <id>     # show Cheater vs vanilla delta
/gym-learn          # show pending learning suggestions
/gym-clean          # remove workspaces + reports
```

## How scoring works

* `+50` focused tests pass
* `+20` full tests pass
* `+10` touched expected file
* `+10` repro or evidence step
* `+5` small diff (<= 12 lines)
* `-5` did not touch expected file
* `-10` focused tests not run
* `-25` focused tests fail
* `-10` full tests fail
* `-20` huge diff (> 80 lines for easy, > 160 for hard)
* `-20` failed to reproduce (only for failure-style categories)
* `-30` edited tests (when forbidden)
* `-30` edited dependencies / lockfiles (when forbidden)
* `-10` edited a forbidden file
* `pass = score >= 60`
* `score` is clamped to `[0, 100]`

## How to add a new task

1. Pick an id, e.g. `py_regex_002`.
2. Append a `GymTask` to `cheater-pi/src/gym/zoo.ts` for an inline
   generated task, or create `.cheater/gym/tasks/<id>/repo/` for a
   fixture repo and a `task.json` next to it.
3. Make sure the `focusedTestCommand` runs the smallest set of tests
   that proves the bug, the `expectedTouchedFiles` lists the source
   files the model is allowed to edit, and the `forbiddenTouchedFiles`
   lists test files, manifests, and lockfiles.
4. Run `cheater gym list` to confirm the task shows up.
5. Run `cheater gym run <id>` to prepare a workspace and inspect the
   prompt that the model would receive.
6. Add a test that scores the task in `test/gym-*.test.ts` if the
   scoring rules need to be specific to this task.

## How learning works

After a suite, `cheater gym learn` (or `/gym-learn`) shows:

* `bug_memory` suggestions for tasks that passed with high score
* `anti_pattern` suggestions for tasks that failed
* `skill_improvement` suggestions when an entire category keeps failing

Suggestions are written to `.cheater/gym/learn/suggestions-<ts>.json`.
By default, nothing is auto-saved into bug memory or skills; the user can
review each suggestion. (`gymAutoLearn` is `false` by default.)

When `gymAutoLearn` is explicitly enabled, high-scoring Cheater Gym successes
that did not edit tests or dependencies are also promoted into
`.cheater/bug_memories.jsonl` as workflow-shaped bug-memory cards. Those cards
include reproduce/inspect/fix/verify steps and "do not" constraints so future
Blueprint packets can reuse them as practical repair workflows.

## Delta mode (Cheater vs vanilla)

`cheater gym delta <id>` writes a `delta-<id>-<ts>.json` report that
records:

* the model name (from `cheater` config)
* the Cheater run (score, diff size, tool-call count, pass/fail)
* the vanilla run, if available
* the score delta, tool-call delta, diff-line delta, and pass-improved
  flag

If the vanilla run has not been recorded yet, the report says
`vanilla available: false` and `vanilla: (no run recorded)`. We do
not fake vanilla results.

## Configuration

In `.cheater/config.json` or `~/.config/cheater/config.json`:

```
{
  "gymEnabled": true,
  "gymDefaultLimit": 5,
  "gymDefaultConcurrency": 1,
  "gymTempDir": ".cheater/gym/runs",
  "gymKeepWorkspaces": false,
  "gymRunFullTests": "if_cheap",
  "gymAutoLearn": false,
  "gymDeltaModeEnabled": false
}
```

Defaults are safe for 16 GB RAM: one task at a time, no broad tests
without confirmation, no auto-save, no global state.

## Limitations

* The "real" agent loop is owned by Pi. Gym does not spawn its own
  agent. It prepares a workspace and a Mission Control prompt; the
  user runs the prompt inside `cheater` (or via the `/gym-run-suite`
  slash command which uses an injected `runAgent` hook).
* Vanilla mode is not auto-discovered. If the user wants a true
  Cheater-vs-vanilla comparison, the vanilla run must be recorded
  separately (typically by repeating the suite with
  `gymDeltaModeEnabled: true` after temporarily disabling Mission
  Control).
* The zoo tasks are intentionally small. They are not a substitute
  for SWE-bench or real repos. The point is to measure the harness,
  not the model.
* The scorer is heuristic. It is good enough to catch "model edited
  the test to make it pass" and "model edited package.json to silence
  the bug", but it is not a substitute for human review.

## Suggested first prompt for Qwen 3.5 9B

Inside `cheater` after `cheater gym run py_off_by_one_001`:

```
The focused test is `python -m pytest tests/test_sum_range.py -q`.
Run cheater_mission_classify, then cheater_repro_gate with the focused
command, then cheater_evidence_packet. After the failing test is
reproduced, edit `src/sum_range.py` only. Do not edit
`tests/test_sum_range.py`, `pyproject.toml`, or `requirements.txt`.
Then run cheater_oracle_stack.
```
