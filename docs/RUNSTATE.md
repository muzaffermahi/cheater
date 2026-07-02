# Durable run state (`cheater-pi/src/runstate/`)

The 2026-07 harness upgrade. One principle: **keep every active agent's context small,
specific, and disposable.** No agent is trusted with a long thinking+implementation chain;
the harness coordinates tiny, well-briefed specialists through durable files.

## The run directory

Every `cheater_reliability_start` (with `runStateEnabled`, default on) births
`.cheater/runs/<planId>/`:

```
controller.md            # task, contract, decomposition, phase, status, next step
contract.json            # literal acceptance contract (deterministic extraction)
workspace-digest.md      # 200-600 word canonical state summary (derived, never hand-edited)
mutation-ledger.json     # every state change: who, what, why, validated?
validation-ledger.json   # every check: pass/fail, what it depended on, stale?
workers/<role>.md        # per-worker plan (generated from its capsule)
capsules/<role>-capsule.json  # the worker's ENTIRE context, persisted + size-measured
reports/<role>-report.md # compact worker report (files, commands, validation, next action)
guards/protected-artifacts.json
events.jsonl             # append-only run log (capsule sizes, staleness, protections)
```

A controller can be killed and respawned: `reconstructRunState(repoRoot, taskId)` +
`renderReincarnationBrief()` rebuild the plot from disk alone. Chat scrollback is never the
source of truth.

## The modules (all deterministic; no LLM calls)

| Module | Job |
| --- | --- |
| `contract.ts` | Extract the LITERAL terms (exact files, output paths, endpoints, ports, commands, symbols, columns, forbidden behavior) from the task text. `output.json` stays `output.json`. |
| `promptCapsule.ts` | The only door into a worker's context. Bounded fields, no parameter for transcripts/system prompts/logs. Target 1-4K tokens, warn >8K. `capsule_built` events log size per spawn. |
| `mutationLedger.ts` | Filesystem truth as entries + compact summary; prompts never carry raw logs. |
| `validationLedger.ts` | What was proven and whether it is STILL true: any later mutation of a dependency marks a pass stale. `mirrorsEvaluator` distinguishes exact-artifact checks from proxies. |
| `workspaceDigest.ts` | The 200-600 word state summary, re-derived from the ledgers after every report/command. |
| `phaseController.ts` | EXPLORE (0-30%) → IMPLEMENT (30-60%) → VALIDATE (60-90%) → RESERVE (90-100%) over an action/wall-clock budget. Monotonic; backward moves need a recorded override. RESERVE blocks risky new state changes. |
| `postSuccessGuard.ts` | After an evaluator-mirroring pass, the proven artifacts are protected: rm/reset/clean/regenerate over them is blocked; a later FAILING validation releases them for a targeted repair. |
| `riskMiddleware.ts` | ≤3 short situational hints: shallow validation (`/` probed, contract says `/api/health`), stale evidence, reserve-phase installs/refactors, protected-artifact mutation, scope drift, repeated actions, oversize capsules. |
| `rulePacks.ts` | 10 task-family packs (5-12 bullets), max 2 retrieved per capsule; harness scar-tissue lessons; `recordFailureAnalysis` appends general lessons to `.cheater/harness-evolution.md` (never task answers). |
| `runState.ts` | `TaskRunState` aggregate + active-run singleton; owns the invariants (mutation → staleness, mirroring pass → protection, capsule → size log). |

## Wiring into the live path

- `cheater_reliability_start` → `beginTaskRun` (contract, controller.md, digest; budget from the plan's per-commitlet tool budgets).
- `buildCommitletExecutionPrompt` → builds + persists the capsule and appends the compact `CHEATER RUN STATE` block (phase, contract, ledger summaries, prior reports, rules).
- `gradeCommitlet` → records the focused verification into the validation ledger (pinned to touched files), files the worker report, refreshes the digest, updates controller.md.
- `cheater_verification_run` / harness auto-verify → mirror stages into the validation ledger; whole-workspace passes are staled by ANY later mutation.
- `extension.ts` `tool_call` → post-success guard can hard-block destructive commands; RESERVE can hard-block risky state changes; softer verdicts ride in-band on the tool result.
- `extension.ts` `tool_result` → mutations recorded (edits, shell fingerprint sweeps, installs) which stale dependent validations; risk hints attached (deduped).
- `cheater_finish_gate` + `agent_end` receipt → downgraded to BLOCKED/nudge when the only evidence is stale or proxy-only while the contract names exact targets.
- A genuinely new goal ends the previous run (its guard must not veto an unrelated task).

Config: `runStateEnabled` (default true), `runStateActionBudget` (default derived from plan).

Tests: `test/runstate.test.ts` (modules), `test/runstate-wiring.test.ts` (durable flow,
reincarnation, staleness end-to-end, capsule size logging).

## The Codex-shaped kernel layer (second pass)

Codex-inspired runtime ideas, adapted for 64-100K-context local models. The design rule:
**the model proposes intent; the harness owns state, permissions, execution, context shape,
and completion truth.** None of this added a model-facing tool - it is hidden machinery.

| Module | Job |
| --- | --- |
| `contextFragments.ts` | Context is typed state, not transcript soup: every capsule input is a fragment with a kind, a size cap, a freshness stamp, and an id recorded in capsule metadata. There is no fragment kind for transcripts, system prompts, or raw logs - `makeFragment` refuses poisoned content outright. |
| `worldState.ts` | `world-state.json`: the machine-readable twin of the digest. Workers get the DIFF since the last capsule, not the whole past. Its `status` field is how unfinished runs are found for session reincarnation. |
| `toolExposure.ts` | The exposure lattice. Roles map to tool subsets that only ever SHRINK the existing 8-tool worker set (worker_read/reviewer: 4 read tools; validator: read + bash, no edits). Workers can never see controller/spawn/retrieval tools; `violatesWorkerToolPolicy` enforces it at spawn. |
| `controlledExec.ts` | Bash as policy-managed mutation interface: commands are classified (test/install/dev_server/git_destructive/shell_edit/...), reserve blocks installs and destructive git, out-of-scope shell edits are blocked, long-running servers warn, and all output is head+tail capped before entering any capsule or report. |
| `hooks.ts` | The pre/post tool pipeline the extension hooks call: controlled-exec policy, phase budget, protected artifacts, **read-before-write** (overwriting an existing unread non-artifact file is blocked), **large-write** warnings, and post-execution folding of commands into typed validation evidence. Loop-governor verdicts bridge into durable risk events. |
| `recipes.ts` | The one CodeMode-lite recipe that earned its keep: `artifact_reread`. The finish gate runs it automatically before judging - it rereads the exact artifacts the contract names the way an evaluator would (JSON must parse, CSV headers must match contract columns, empty files fail) and records typed `exact_artifact` evidence. Bounded, loop-free, no writes, never a tool. (The speculative recipe library was deleted in the production-grade purge: unwired code is boilerplate.) |
| `workerSpawn.ts` | Explicit fork history: every worker gets a persisted `WorkerSpawnSpec` with `forkMode: "none"` as the only default. Inheriting parent history requires a config override AND a logged reason, and still writes a warning event. Workers cannot spawn workers. |
| `invariants.ts` | The spawn gate: capsule token limits (fail closed above 8K without override), poison markers, one narrow goal, allowed-files cap, contract/phase/validation presence, stale/protected warnings present when relevant, and worker tool policy. A failing capsule does not spawn - the controller is told to split or compress. |
| `sanitize.ts` | History-poison prevention: `<think>` blocks stripped, repeated lines collapsed, code dumps truncated, hard caps - applied to every worker report before it becomes durable state. |
| `validationLedger.ts` (extended) | Typed proof: `evaluator_mirror` / `exact_artifact` / `exact_endpoint` / `focused_test` / `proxy` / `shallow`. The finish gate requires a fresh exact-type pass when the contract names exact targets; proxy-only evidence blocks. |

**Session reincarnation** (extension `input` hook): a continuation message ("continue",
"go ahead") in a repo with an unfinished run resumes the most recent one - a <2K-char brief
built from durable files is injected, the run's ledgers/protections re-activate, and
`cheater_reliability_start` reuses the resumed run instead of orphaning it. A clearly new
goal never force-resumes (unfinished work is surfaced as a one-line notice). Multiple
unfinished runs: one resumes, the rest are listed by id only.

**Local telemetry** (no network, ever): per-run counters (blocked tool calls, guard/reserve
blocks, risk warnings, stale-validation events, invariant failures, loop events, capsule
count/max size) persisted in world-state.json and surfaced via `/reliability-status` and
`cheater_ledger_status`.

## Why this helps local models

- **Fewer visible tools**: read-only workers see 4 tools, editors 8, and nobody sees
  orchestration primitives - a small model's weakest skill is choosing between many tools.
- **Smaller prompts**: fragments are capped per kind; capsules over target are flagged, over
  the hard limit they do not spawn.
- **No inherited context**: fork-none by default, structurally - the capsule is the whole
  briefing, so a 64K model starts every job with room to work.
- **Less stale validation**: "tests passed" expires the moment a dependency mutates; the
  finish gate re-checks the exact artifacts itself.
- **Fewer loops**: phase budgets, loop bridging, and repeated-action hints converge runs
  instead of letting them orbit.
- **Fewer destructive late changes**: reserve mode and the post-success guard make the
  cheapest late-game move "stop and keep the win".
- **Better restart/resume**: killing the terminal costs a session, not the task.

Tests: `test/codex-kernel.test.ts`, `test/reincarnation.test.ts`.
