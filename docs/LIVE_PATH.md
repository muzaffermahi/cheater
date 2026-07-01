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

No. `cheater/pi_launcher.py` (the only console entry point) never imports
`cheater.agent_loop.AgentLoop`. The grep below confirms `AgentLoop` is referenced
only in legacy/internal modules (`agent_cli`, `arena`, `tui_textual`,
`tui/adapters`, `example_cli`, `bench_cli`), none of which are on the live path.

```
grep -rn "AgentLoop" cheater/pi_launcher.py   # 0 matches
```

The live product path is the TypeScript Pi extension at `cheater-pi/src/extension.ts`.

## TypeScript tools/commands registered in a real Pi session

`extension.ts` registers, gated by config:

- `registerCheaterCommands` / `registerCheaterTools`
  - tools: `cheater_project_brief`, `cheater_focus_test`, `cheater_diff_safety_check`,
    `cheater_line_edit`, `cheater_memory_search`, `cheater_bug_memory_search`,
    `cheater_skill_search`
- `registerAutopilotCommands` / `registerAutopilotTools`
- `registerBlueprintCommands` / `registerBlueprintTools`
- `registerCommitletCommands` / `registerCommitletTools`
  - tools: `cheater_reliability_start`, `cheater_commitlet_next` (grades the
    running commitlet in code - diff guard, patch health, test audit, focused
    verification - then prepares the next one or runs the final review),
    `cheater_finish_gate`, `cheater_verification_run`, `cheater_ledger_status`,
    `cheater_commitlet_revert`, `cheater_rollback_status`, `cheater_health_report`,
    `cheater_constraint_graph`, `cheater_bench_report`.
    `cheater_commitlet_plan`, `cheater_commitlet_guard`, `cheater_commitlet_verify`,
    `cheater_commitlet_finalize`, and `cheater_autopilot_route` were removed: the
    first is a duplicate of `cheater_reliability_start`, the guard/verify/finalize
    steps are now inlined into `cheater_commitlet_next` instead of being separate
    tools the model could skip or call out of order, and routing moved to the
    harness (the `input` hook below) instead of a tool the model had to remember.
- `registerMissionCommands` / `registerMissionTools`
- `registerGymCommands`
- `registerReliabilityCommands` (`/reliability-status`, `/model-profile`, `/loop-report`)

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
