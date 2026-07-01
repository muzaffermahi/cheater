# Live Path Changes

What this slice made product-live in the TypeScript/Pi path.

## 2026-07-02: one-shot reliability enforcement refactor

The reliability pieces documented below (ledger, loop governor, non-progress
detector, finish gate, verification runner) were all real TypeScript code, but
none of it was actually reachable on a live Pi session:

- `pi.on("before_user_message", ...)` is not a real Pi event, so autopilot
  routing (the only place the model was told to call `cheater_reliability_start`)
  never fired.
- `tool_call`/`tool_result` handlers read `event.path`/`event.args`/`event.params`,
  which don't exist on Pi's real `{toolName, toolCallId, input}` event shape, so
  the commitlet scope guard never blocked anything and the completion ledger
  never recorded a file change or command from a live session.
- The same observer ran on both `tool_call` and `tool_result`, double-counting
  every tool call against the loop-governor's per-packet budget.
- `cheater_commitlet_next` marked commitlets "passed" on the model's own
  `completedCommitletId`/`summary` say-so; the separate `cheater_commitlet_guard`
  / `cheater_commitlet_verify` tools that actually graded a commitlet were
  optional and easy to skip, and their results never reached the ledger the
  finish gate reads.
- The system prompt described three different, partially contradictory flows
  (Mission-Control-first, an autopilot-tool chain, a manual Reliability-Kernel
  chain) across 43 model-facing tools, none of which mentioned
  `cheater_reliability_start`, `cheater_finish_gate`, or `cheater_verification_run`.

Fixed in this slice:

| Change | Where |
|---|---|
| Routing moved from the nonexistent `before_user_message` to the real `input` event | `src/extension.ts` |
| `tool_call`/`tool_result` read Pi's real `event.input` shape; call-side and result-side observation split so a tool call is recorded exactly once | `src/extension.ts`, `src/reliability/sessionState.ts` |
| Loop-governor and non-progress warnings are appended to the tool's own result text, not just a TUI-only notification | `src/extension.ts` |
| Finish gate enforced structurally: `agent_end` queues one bounded follow-up (max 2 per interactive turn, skipped on abort/error) when work happened but verification evidence is missing | `src/extension.ts` |
| `cheater_commitlet_next` now runs diff guard, patch health, test audit, and focused verification in code before advancing, and feeds the result into the live ledger; `cheater_commitlet_plan`/`_guard`/`_verify`/`_finalize` and `cheater_autopilot_route` were removed as separate model-facing tools | `src/commitlet/tools.ts` |
| Fixed a latch bug where a passing verification re-run could never clear an earlier failure recorded under the same stage name | `src/reliability/lifecycle.ts` |
| `findFreePort`/`portInUse` made genuinely async (the previous sync try/catch never observed the async `"error"` event and always reported the port free); owned dev-server processes are now actually killed on stop instead of only having their status flag flipped | `src/reliability/verificationRunner.ts` |
| System prompt rewritten to the one real flow: `cheater_reliability_start` -> edit -> `cheater_commitlet_next` (auto-verifies) -> `cheater_verification_run` -> `cheater_finish_gate` | `src/prompts.ts`, `cheater-pi/prompts/cheater.md` |
| New `test/live-wiring.test.ts` exercises the full chain against Pi's real event shapes, and would fail again if any of the above regressed | `cheater-pi/test/live-wiring.test.ts` |

## Before this slice

| Capability | Status |
|---|---|
| Completion ledger | Python-only (`cheater/ledger.py`), not used by live Pi sessions |
| Non-progress detection | Python-only (`cheater/anti_stall.py`), not used by live Pi sessions |
| LoopGovernor | TS existed but only exercised by `/loop-report` with mock data |
| Finish gate | Did not exist in TS |
| Verification stage tracking | Python-only (`cheater/verification.py`), not used by live Pi sessions |
| Recovery capsule | Python-only (`cheater/lifecycle.py`), not used by live Pi sessions |
| Command/process ownership | Python-only (`cheater/lifecycle.py`), not used by live Pi sessions |
| Project command detection | `cheater_focus_test` hardcoded `npm test` fallback |
| Fresh worker | Blueprint path used real `sdkFreshAgentPacketRunner`; commitlet path returned a prompt to the same agent without marking it as simulated |
| Launcher gym delegation | Could recursively call itself; had fake `no.such.module` fallback; tried to run JS with Python |

## After this slice

| Capability | Status | Location |
|---|---|---|
| Completion ledger | **Product-live** in TS | `src/reliability/lifecycle.ts` `CompletionLedger` |
| Non-progress detection | **Product-live** in TS | `src/reliability/lifecycle.ts` `NonProgressDetector` |
| LoopGovernor | **Product-live**, wired into `tool_call` hook | `src/reliability/sessionState.ts`, `src/extension.ts` |
| Finish gate | **Product-live** as `cheater_finish_gate` tool | `src/commitlet/tools.ts` |
| Verification stage tracking | **Product-live** in TS | `src/reliability/lifecycle.ts`, `src/reliability/verificationRunner.ts` |
| Recovery capsule | **Product-live** in TS | `src/reliability/lifecycle.ts` `makeRecoveryCapsule` |
| Command/process ownership | **Product-live** in TS | `src/reliability/lifecycle.ts` `ProcessRegistry` |
| Project command detection | **Product-live**, replaces universal `npm test` | `src/reliability/projectCommands.ts` |
| Fresh worker | **Explicit**: simulated mode is marked; real mode available via `spawnFreshWorker=true` | `src/commitlet/executor.ts`, `src/commitlet/tools.ts` |
| Launcher gym delegation | **Fixed**: no recursion, no fake fallbacks | `cheater/pi_launcher.py` |

## New TypeScript modules

- `src/reliability/lifecycle.ts` — CompletionLedger, ProcessRegistry, NonProgressDetector, finish gate, recovery capsule, workspace signature, failure classification
- `src/reliability/projectCommands.ts` — project command detection from package.json, pyproject.toml, Cargo.toml, go.mod, Makefile, lockfiles
- `src/reliability/verificationRunner.ts` — runnable verification I/O: port selection, owned services, workspace identity probe, smoke/focused/full/scoring, artifact collection, service stop
- `src/reliability/sessionState.ts` — per-session lifecycle state bridging the live Pi `tool_call`/`tool_result` hooks to the LoopGovernor + NonProgressDetector + CompletionLedger

## New TypeScript tools

- `cheater_finish_gate` — blocks finishing without verification evidence
- `cheater_verification_run` — runs the full verification I/O pipeline and feeds the ledger
- `cheater_ledger_status` — shows the live completion ledger

## Wired into the live Pi session

`extension.ts` now feeds the `tool_call` and `tool_result` hooks into `liveSessionState`, which:
1. Records tool calls in the LoopGovernor's tool records
2. Runs the NonProgressDetector on every tool call
3. Notifies the user and can block terminal stall events
4. Records file changes and commands in the CompletionLedger

`cheater_reliability_start` now:
1. Resets and initializes the live session ledger
2. Sets the packet ID for the LoopGovernor
3. Returns `freshWorkerMode: "simulated"` or `"real"` explicitly

## Python lifecycle status

The Python lifecycle modules (`cheater/lifecycle.py`, `cheater/ledger.py`, `cheater/anti_stall.py`, `cheater/verification.py`) are now **legacy/internal only**. They are not on the live product path (the Pi TypeScript extension is). They remain for:
- Offline benchmark variants (A-E) in `cheater bench reliability`
- Legacy Python test coverage
- Reference implementations that the TS ports were based on

The concepts are now **bridged** into the live path via the TypeScript ports, not via a Python bridge process.

## Fresh-worker isolation enforcement

| Path | Mode | Isolation |
|---|---|---|
| Blueprint (`cheater_blueprint_next_packet`) | Real | `sdkFreshAgentPacketRunner` creates a real isolated `createAgentSession` with its own context, settings, and session file |
| Commitlet (`cheater_reliability_start`) default | Simulated | Prompt returned to the current agent session; explicitly marked `freshWorkerMode: simulated` |
| Commitlet with `spawnFreshWorker=true` | Real | `spawnFreshWorkerForCommitlet` calls `sdkFreshAgentPacketRunner` to create a real isolated session |

The simulated mode is now **explicitly marked** in the prompt text and the tool result details. Users and the model can see which mode is active.

## Verification I/O

`cheater_verification_run` provides:

1. **Project command detection**: detects dev/test/lint/build/score commands from package.json scripts, pyproject.toml, Cargo.toml, go.mod, Makefile, and lockfiles
2. **Clean port selection**: `findFreePort` scans 4321-9100 for a free port
3. **Owned services**: dev servers are registered in `ProcessRegistry` with port, pid, health endpoint, and workspace signature
4. **Workspace identity proof**: `servedWorkspaceProbe` hook compares the served workspace signature to the current workspace signature
5. **Smoke/focused/full/scoring checks**: each stage runs the detected command and records the result
6. **Artifact collection**: writes a verification manifest to `.cheater/artifacts/`
7. **Service stop**: `stop_all_running` stops only harness-owned processes
8. **Ledger feeding**: all stages are recorded in the CompletionLedger

## Tests

- TypeScript: 271 tests pass, including `test/live-wiring.test.ts` (new, exercises
  the live path against Pi's real event shapes) and the updated
  `product-lifecycle.test.ts`, `commitlet-kernel.test.ts`, and
  `autopilot-blueprint-integration.test.ts`.
- Python: not touched by this slice; see the last recorded count in git history
  if needed - the legacy suite is out of scope for the live-path refactor.
