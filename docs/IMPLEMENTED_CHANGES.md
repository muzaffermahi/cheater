# Maximizing Cheater — implementation log

Tracks what from [MAXIMIZING_CHEATER.md](MAXIMIZING_CHEATER.md) is now implemented in the
live TypeScript/Pi path. Build is clean and **279 tests pass** (was 271; 8 new).

## Landed

### Wave 1 — stop the self-sabotage (complete)
- **3.1 Mid-task routing guard** — `extension.ts` input hook no longer re-routes a follow-up
  ("ok continue") when a commitlet plan is active; it injects a short "continue the active
  plan" directive instead of the old answer_only "do not edit files" contradiction.
- **3.2 Finish-gate wedge** — `lifecycle.ts` `recordCommandResult` latches command failures
  by structural fingerprint and auto-supersedes them when an equivalent command later
  succeeds; a passing real test stage clears stray exploratory failures; `cheater_finish_gate`
  gained a tracked `waiver` param replacing the untracked "verification skipped" escape.
- **3.3 Loop-governor recalibration** — budgets raised (`maxTotalToolCallsPerPacket` 14→40,
  `samePatchLimit` 1→3, `sameFileReadLimit` 2→4, etc.) and commands are keyed by a
  flag/number-insensitive fingerprint so `pytest -v` and `pytest -q` count as one family.
  Text-repetition detection (`observeAssistantText`) is now wired via the real `message_end`
  event.
- **3.4 Project-command registry** — fixed the `npm run vitest run` / always-truthy
  `test:unit` bugs; added a cached `loadProjectCommands` (`.cheater/commands.json`, mtime
  invalidation); the commitlet planner now uses the detected command instead of a hardcoded
  `npm test` (command-less "manual review" step when nothing is detected).
- **3.5 Stop fabricating** — blueprint no longer sets `verificationPassed` from `status`;
  `commitlet/state.ts` records honest observed results (real `filesChanged`/`diffLines`) via
  a new result-override path in `gradeCommitlet`; the final review now scores the real
  accumulated per-commitlet diff instead of `''`.
- **3.6 Single-source config-aware prompt** — one `buildSystemPrompt(config)` in `prompts.ts`
  (omits disabled-subsystem rules and the false "an autopilot decision is attached" promise;
  dropped the dev-governance paragraph); `--append-system-prompt` removed from the launcher;
  `cheater.md` reduced to a minimal identity note so there is one copy of the flow rules.
- **3.7 Autopilot header diet** — `buildAutopilotInstruction` emits only imperative directives
  (no mode/discipline/`confidence:` telemetry) and the transform puts the user goal first.
- **6.3 Guard recipes** — every guard/health/test-audit/scope block now carries a "-> do this
  instead" remediation line.
- **6.7 Webapp verification** — smoke stage polls readiness (`curl --retry-connrefused`)
  instead of racing server startup; fixed the manifest field that wrote the workspace
  signature into `userGoal`.

### Wave 3 / UX — punch above weight (high-leverage subset)
- **3.8 Mode-scoped tool masking** — `applyToolMask` uses `ctx.setActiveTools` to show ~answer/
  planner/execute-scoped cheater tool subsets; Pi-native tools are never touched.
- **3.9 Harness-run verification** — `agent_end` runs the detected focused test itself
  (bounded) and records the stage, only nudging the model on failure (config `autoVerifyOnFinish`).
- **5.1 Fresh-worker default** — `commitletFreshWorkerDefault` config drives real isolation
  instead of a model-supplied parameter (default off for offline safety; set true with a live
  backend).
- **5.2 Failure compressor** — ported `failure_compressor.py` to `reliability/failureCompressor.ts`
  (pytest/jest/vitest/tsc/node), wired into `commitlet/verification.ts` and the verification
  runner so repair prompts carry a structured `expected/got/top-file/NEXT` card.
- **5.3 Post-edit syntax gate** — `reliability/diagnostics.ts` runs cheap per-file checks
  (`node --check`, `py_compile`, `JSON.parse`) on every edit and appends parse errors in-band.
- **5.8 Git ground-truth** — shell edits (sed/echo/git apply) are recorded into the ledger via
  a per-turn `git status` baseline, closing the structured-edit-tool bypass.
- **5.9 Grader precision** — health assertion-removal gated to test files; test-audit skip/only
  matched as call syntax; single-file formatting churn demoted to a warning; `approveLargeDeletion`
  override added on `cheater_commitlet_next`.
- **5.11 Environment block** — platform+shell (PowerShell note on Windows), git branch/status,
  and detected commands injected at `before_agent_start`.
- **5.13 Sampling honesty** — removed advisory `maxOutputTokens` noise from packet prompts;
  `/doctor` now prints recommended HF-card sampling values and validates config JSON.
- **5.17 @-file references** — `@path` tokens resolve to bounded excerpts and seed autopilot
  `likelyFiles`.
- **6.2 Completion receipt** — a code-generated receipt (files/commands/verified stages) is
  rendered from the ledger at `agent_end` when the finish gate is satisfied.
- Removed dead `cheater_skill_search` (ignored its own query; Pi surfaces skills natively).

### Second high-ROI batch
- **5.5 Symbol-slice snippets** — `reliability/symbolSlice.ts` extracts the actual target
  function/class (name overlaps the task/failure terms) into the worker prompt instead of the
  first 40 lines of imports; repair commitlets seed the terms from the observed failure.
- **5.4 Exemplars** — one canonical worked commitlet cycle is injected into the system prompt
  (research: a worked example beats prose rules for small models).
- **5.7 Git-safe rollback** — snapshots/restores raw bytes (no binary corruption), records
  which files pre-existed and **deletes files created during a commitlet on revert**, and a
  failed repair now reverts to the original pre-edit state (repairs carry the original's
  rollback point) instead of leaving broken code while reporting "reverted".
- **5.10 Working-set capsule** — a `session_compact` hook re-injects goal + plan + files +
  last verification so the model does not drift after compaction.
- **6.4 Async verification** — the agent_end auto-verify now uses async `spawn` (not blocking
  `spawnSync`), so it no longer freezes the extension host for up to 90s.
- **Repro timeout bug** — `mission/repro.ts` timeout detection was inverted (required the
  error to be *absent*), so spawnSync timeouts were never detected; fixed to check
  `error.code === "ETIMEDOUT"`.

## Deliberately skipped (low ROI for model experience, per the "only high-leverage" rule)
- **Wave 2 mass subtraction** (4.1 blueprint collapse, 4.2 mission shrink, 4.3/4.4 merges,
  4.9 config diet, 4.10 fake-benchmark deletion, 4.11 knip gate, 4.12 docs prune). **3.8 tool
  masking already removed these tools from the model's view**, so the remaining benefit is
  code-health/maintenance, not how Qwen performs — high test-surgery risk for low model-facing
  return. Worth doing later as careful hygiene, not now.
- **5.14 plan/act split** — high-value for this model but L-effort with uncertain
  backend/Pi payload mapping; needs the gym signal (below) to validate first.
- **5.15 best-of-N**, **5.16 tokenizer counts**, **5.18 memory precision**, **5.12 /init**
  (env block already injects the key facts every turn), **6.1/6.5/6.6/6.8 UX polish** —
  medium/low ROI relative to the correctness and context wins already landed.
- **§7 gym rebuild** — important for *measuring* future changes, but it improves the eval
  loop, not the live model experience; a larger standalone effort.
