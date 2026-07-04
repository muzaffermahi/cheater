# Live Execution Path

Internal note proving what is actually product-live when a user runs `cheater`.

## What happens when `cheater` starts

1. `cheater` (console script) -> `cheater.__main__:main` -> `cheater.pi_launcher:main`.
2. `pi_launcher.main` resolves the Pi executable and runs:
   `subprocess.run([pi, --extension, cheater-pi/src/extension.ts, --skill, ..., --prompt-template, ..., --name, Cheater])`.
3. Pi owns the TUI, the agent loop, tool execution, editing, context, sessions,
   and the slash-command runtime. Cheater only contributes an extension, prompt,
   skills, commands, tools, and theme.

The Python process exits into a Pi subprocess. No Python agent loop runs.

## Is the Python AgentLoop ever used?

No - and as of the 2026-07 cleanup it no longer exists. The legacy Python agent
(agent loop, TUI, arena, retrieval stack, `cheater/legacy/`) was deleted; the
Python package now contains only the launcher surface: `cheater/__init__.py`,
`cheater/__main__.py`, and `cheater/pi_launcher.py` (stdlib-only).

The live product path is the TypeScript Pi extension at `cheater-pi/src/extension.ts`.

## TypeScript tools/commands registered in a real Pi session

`extension.ts` registers, gated by config:

- `registerCheaterCommands` / `registerCheaterTools`
  - tools: `cheater_project_brief`, `cheater_line_edit`, `cheater_memory_search`,
    `cheater_bug_memory_search`.
- `registerAutopilotCommands` (there is no `registerAutopilotTools` - autopilot routing is
  harness-level, hung off the `input` event below, not a tool the model calls)
- `registerBlueprintCommands` (inspection commands only; blueprint has NO model-facing tools -
  planning runs inside `cheater_reliability_start`)
- `registerCommitletCommands` / `registerCommitletTools`
  - tools: `cheater_run` (the deterministic closed-loop executor: the harness
    plans, spawns bounded workers, grades, repairs, finalizes, and gates in one
    call - see `commitlet/closedLoop.ts`; the shared grading/finish kernel lives
    in `commitlet/kernel.ts`), `cheater_reliability_start`, `cheater_commitlet_next` (grades the
    running commitlet in code - diff guard, patch health, test audit, focused
    verification - then prepares the next one or runs the final review),
    `cheater_finish_gate`, `cheater_verification_run`, `cheater_ledger_status`,
    `cheater_commitlet_revert`, `cheater_rollback_status`.
- `registerGymCommands`
- `registerReliabilityCommands` (`/reliability-status`, `/model-profile`)

Invariant (pinned by `autopilot-blueprint-integration.test.ts`): **every registered
`cheater_*` tool appears in a tool mask.** There is no registered-but-never-visible
inventory left to leak if masking degrades.

Pi lifecycle hooks used by the extension:

- `session_start` -> set title/status/startup card.
- `input` -> autopilot routing on interactive messages, and resets per-turn
  reliability state (loop governor, non-progress detector, finish-gate nudge
  budget). **Not** `before_user_message` - see the correction below.
- `before_agent_start` -> system prompt + context cap compaction.
- `tool_call` -> commitlet scope guard, blueprint planner tool block, and the
  loop governor (can block a repeating action before it runs).
- `tool_result` -> records file changes/commands into the completion ledger,
  runs the non-progress detector, and appends any reliability warning to the
  tool's own result text so the model actually sees it.
- `agent_end` -> the finish gate: if this turn changed files or ran commands
  and verification evidence is still missing, queues one bounded follow-up
  message (`cheater_finish_gate`'s check) asking the model to verify or say
  explicitly that it didn't. Bounded to 2 per interactive turn; skipped on
  abort/error.

## Correction: this wiring did not actually run before the July 2026 refactor

Everything above describes the **current, fixed** state. Until the refactor
that added `test/live-wiring.test.ts`, this file was inaccurate in three ways
that made the entire reliability layer inert on a real Pi session, even though
every unit test passed:

1. `extension.ts` registered `pi.on("before_user_message", ...)`.
   **`before_user_message` is not a Pi extension event.** Pi's `on()` silently
   stores unknown event names and never calls them, so autopilot routing never
   reached the model - the only place a normal message was ever told to call
   `cheater_reliability_start` was dead code. Fixed by moving routing to the
   real `input` event.
2. Pi's `tool_call`/`tool_result` events carry arguments as `event.input`
   (`{toolName, toolCallId, input}`). `extension.ts` read
   `event.path`/`event.args?.path`/`event.params?.path`, all of which were
   always `undefined` on a real event. This meant the commitlet scope guard
   never blocked an out-of-scope edit, and the completion ledger never
   recorded a single file change or command from a live session - so
   `cheater_finish_gate` was unpassable for a well-behaved model, since
   nothing had populated the evidence it checks for.
3. The same combined observer ran on both `tool_call` and `tool_result` for
   the same logical action, double-counting every tool call. Because tool
   values also collapsed to bare tool names ("read", "bash"), this would have
   false-terminal-blocked any real session after roughly 7 tool calls, had the
   event shape bug above not already made the whole hook inert.

See `docs/LIVE_PATH_CHANGES.md` for the fix and the tests that would fail if
any of these three regressed.

## Correction: a second wiring pass found and fixed (2026-07-02)

A cross-module audit against `node_modules/@earendil-works/pi-coding-agent`'s
own type declarations found and fixed six more live-path defects, all now
covered by tests:

1. **The entire tool mask was a no-op.** `applyToolMask` called
   `ctx.getActiveTools()`/`ctx.setActiveTools()`, but those methods exist only
   on the `pi` (`ExtensionAPI`) object, never on the per-event `ctx`. Every
   phase (`answer_only`/`planner`/`execute`) silently exposed the full
   `cheater_*` tool surface regardless of mode. Fixed by masking off `pi`.
2. **Planner isolation depended on the loop governor being on.** The
   `tool_call` handler returned early when `loopGovernorEnabled === false`,
   before the (separately configured) blueprint-planner file-tool block ran -
   disabling the loop governor silently also disabled planner/worker
   isolation. Fixed by moving the planner block first and unconditional.
3. **Completion ledger state leaked across unrelated turns.** A
   failed/unverified code turn's ledger (stale files, unresolved failures, old
   goal) survived into the next turn if that turn was a pure question,
   dragging the finish gate into nagging about a task the user was not asking
   about. Fixed by resetting the ledger with the new goal whenever the `input`
   handler detects a genuinely new goal (not a continuation of an active
   plan).
4. **Bash edits to an already-dirty file were invisible to the ledger.**
   `gitBaseline` was a plain membership set; a file dirty from a prior turn
   was "in the baseline" forever, so a bash/sed edit to it in a later turn
   never registered as a file change. Fixed by fingerprinting (mtime+size)
   instead of membership.
5. **The autopilot classifier misrouted commands that open with an
   explanation verb.** `"Explain why X is failing and fix it"` scored
   `explanation_only` (start-anchored pattern) over `bug_fix`/`test_failure`
   on a same-score tie, injecting "do not edit files" into an explicit fix
   request. Fixed by skipping `explanation_only` whenever the message also
   contains a code-mutation verb anywhere.
6. **Generic bug-fix/feature requests picked a file by guessing a literal
   filename that only happened to match Cheater's own repo** (`src/commands.ts`,
   `src/tools.ts`, `src/config.ts`), so on any other project the single most
   common routing path (`single_commitlet`, no blueprint) shipped a worker
   packet with the placeholder `allowedFiles: ["(select one target file after
   inspection)"]` - which `executor.ts` then filters out entirely, producing
   zero code and zero repo facts in the packet. Fixed by scanning the actual
   target repo's source and matching goal terms against real
   symbols/exports/registrations (`selectSingleFileForGoal`), falling back to
   the placeholder only when nothing matches.

Also fixed in the same pass: fresh workers never inherited the parent
session's model (silently resolved a different model via global defaults);
`buildCommitletExecutionPrompt` never forwarded the model name so
`modelClass` was always `"unknown"`, dropping the model-specific operating
rules; a packet's verification command was stated as a bare fact with no
instruction to actually run it; the packet told the worker "Use Pi native
tools only" while the surrounding commitlet block told it to use
`cheater_line_edit`; and a commitlet's target file's code was embedded twice
in one packet (a symbol-aware slice plus a duplicate raw head excerpt).

## Correction: the 2026-07 production-grade purge

An audit found that 28 of 39 registered `cheater_*` tools appeared in NO tool
mask - permanently invisible dead surface that would flood a small model with
choices only in the exact failure case (mask no-op) where extra choices hurt
most. Additionally, several slash commands (`/health-report`,
`/constraint-graph`, `/bench-report`) sent the model off to call tools that
were masked away - the same "approval black hole" shape fixed in the sixth
pass. Deleted outright rather than hidden:

- the entire Mission Control subsystem (`src/mission/`, 15 tools, ~12 commands;
  its `scanOrientation` scanner - the one piece the live path used - moved to
  `blueprint/orientation.ts`); the `mission_control` routing mode was renamed
  `careful_repro` (same behavior: reproduce first, then the one flow)
- all 9 `cheater_blueprint_*` model tools plus the packet-dispatch debug
  commands (`/blueprint-step`, `/blueprint-force`, `/blueprint-review`,
  `/blueprint-approve`, `/blueprint-candidates`, `/blueprint-debug`,
  `/blueprint-quality-repair`, `/blueprint-eval`) and their orphaned engines
  (`evalHarness.ts`, `qualityRepair.ts`, `reviewer.ts`, `blueprint/impact.ts`)
- never-masked tools `cheater_focus_test`, `cheater_diff_safety_check`,
  `cheater_health_report`, `cheater_constraint_graph`, `cheater_bench_report`
  (`/commitlet-health`, `/constraint-graph`, `/bench-report` now render
  directly from harness state - zero model turns)
- `/loop-report` (printed hardcoded mock data) and `/health-report` (duplicate
  of `/commitlet-health`)
- the gym benchmark prompt still instructed eval models to call deleted
  mission tools (`cheater_mission_classify -> cheater_repro_gate -> ...`) -
  rewritten to the real one flow; `commitlet/spec.ts` seeded bug specs with
  "Use Mission Control repro/evidence output" - rewritten

## Did lifecycle/anti-stall affect real Pi sessions before this slice?

No. Before this slice:

- `LoopGovernor` (TS) existed but was only exercised by the `/loop-report`
  command with hardcoded mock data. The `tool_call` hook did not feed it.
- The Python modules `cheater/lifecycle.py`, `cheater/ledger.py`,
  `cheater/anti_stall.py`, `cheater/verification.py` (CompletionLedger,
  ProcessRegistry, StallDetector, VerificationMachine) were rich but only
  referenced by the legacy Python `AgentLoop`, which is not on the live path.
- The TS commitlet state (`commitlet/state.ts`) tracked the current plan but
  had no completion ledger, no finish gate, and no verification stage tracking.
- `cheater_reliability_start` created plan state but produced no ledger and
  could not block a finish attempt that lacked verification evidence.

## What this slice makes product-live

See `docs/LIVE_PATH_CHANGES.md` for the after-state. In short, the lifecycle
concepts (completion ledger, non-progress detection, finish gate, verification
stage tracking, recovery capsule, owned-service metadata) are now ported to
TypeScript in `cheater-pi/src/reliability/lifecycle.ts` and wired into the live
`tool_call` hook and the `cheater_reliability_start` / `cheater_finish_gate`
tools.

## How to re-prove this

```
cd cheater-pi && npm test
```

`test/live-wiring.test.ts` asserts every event name the extension registers is
a real Pi event, exercises the full one-shot chain (`cheater_reliability_start`
-> a real-shaped `tool_call`/`tool_result` edit -> `cheater_commitlet_next` ->
`cheater_finish_gate`) against Pi's actual event shapes, and asserts the
`agent_end` finish-gate nudge fires/stops/resets correctly.
`product-lifecycle.test.ts` covers the lifecycle primitives (ledger, detector,
verification runner) in isolation.
