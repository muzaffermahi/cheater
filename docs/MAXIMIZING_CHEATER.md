# Maximizing Cheater: the full plan

Goal: **cheater + Qwen 3.6 35B A3B must feel like Claude Code / Codex.** The harness must
make a 3B-active-param MoE punch far above its weight.

This document is the synthesis of a full-repo analysis (every subsystem read, every claim
verified against source with file/line evidence) plus research on the exact target model and
on what actually makes Claude Code, Codex CLI, Aider, SWE-agent, OpenHands, and Agentless
work. No code has been changed. Everything below is a proposal.

---

## 1. The thesis

Three findings drive everything else:

1. **The architecture is right; the execution sabotages it.** Code-side enforcement
   (scope guard, loop governor, finish gate, code-graded commitlets, fresh workers) is
   exactly the right design for small models — Agentless, SWE-agent, and Claude Code's own
   hook system all confirm that the harness, not the model, must own control flow. But a
   dozen verified live bugs currently make the harness *punish correct work and reward
   lying*: the finish gate wedges permanently after one typo'd command, the loop governor
   terminal-blocks a third edit to the same file, every non-npm repo fails verification with
   a hardcoded `npm test`, mid-task follow-ups like "ok continue" get re-routed to
   "answer_only — do not edit files", and blueprint marks `verificationPassed=true` without
   running anything.

2. **The model's profile dictates the harness shape.** Qwen3.6-35B-A3B is near-frontier
   per-step (SWE-bench Verified 73.4, LiveCodeBench 80.4) but weak at multi-tool
   orchestration (MCPMark 37.0), suffers documented argument-looping without
   `preserve_thinking`, collapses its reasoning depth ~10x when tool definitions are
   attached, and fabricates increasingly beyond ~32K context (~1% at 32K → 5-10%+ past 64K).
   Conclusion: **few tools, short contexts, fresh workers, deterministic orchestration,
   thinking-mode planning separated from non-thinking execution.**

3. **Subtraction is the biggest feature.** Five overlapping orchestration layers (autopilot,
   blueprint, commitlet, mission, reliability), 40 model-facing tools, ~63 slash commands,
   ~97 config keys, 138 dead Python modules (~26k LOC), three verification stacks, three
   project-command detectors, two classifiers, a triple-injected system prompt, and three
   fake benchmarks. Every duplicate is context tax, tool-choice ambiguity, and drift risk
   for a model whose weakest skill is choosing between similar tools. The target end state
   is **one pipeline**: route → per-file commitlet plan → fresh-worker execute → code-graded
   verify → finish gate.

---

## 2. Target end state (what a user experiences)

```
$ cheater
Cheater v0.8 · qwen3.6-35b-a3b (moe35b profile) · autopilot+commitlet on
Just ask. /cheater for help, /status for state.

> fix the failing auth test

▶ repro: pytest tests/test_auth.py::test_login … FAILED (oracle recorded)
▶ commitlet 1/1 · src/auth/session.py · worker (fresh ctx, 9.8k tok)
▶ grading: diff guard ok · health 91 · focused verify … PASS (3.2s)
✔ Done — verified receipt:
   changed: src/auth/session.py (+7 −2)
   ran:     pytest tests/test_auth.py::test_login → exit 0
   gates:   scope ✓ health ✓ tests ✓ finish ✓
```

- One visible status line, not three stacking widgets.
- A deterministic completion receipt rendered from the ledger, never model prose.
- The model juggles **2 protocol tools**, not a 4+ tool chain it forgets.
- Verification runs automatically in the harness; the model only fixes what it's handed.
- Every guard block tells the model (and user) *what to do instead*.
- No commitlet ever runs `npm test` in a cargo repo.

---

## 3. P0 — Stop the self-sabotage (do these first)

These are verified live defects where the harness actively degrades a competent model.
All are S/M effort. Nothing else in this plan can be evaluated fairly until these land.

### 3.1 Don't re-route mid-task follow-ups (the "ok continue" bug)
`extension.ts:117-132` re-routes **every** interactive message with zero awareness of an
active plan, so "yes, go ahead" classifies unknown → answer_only and injects *"Do not edit
files"* mid-commitlet-chain. Small models obey it and abandon in-flight work — the single
worst trust-breaker in the product. Fix: if `defaultCommitletState`/`defaultBlueprintState`
has a pending/running plan, skip `routeAutopilot` and inject one line: *"Continue the active
plan (2/4); call cheater_commitlet_next when the current edit is done."*

### 3.2 Unwedge the finish gate (it currently trains the model to lie)
Any failed exploratory bash command latches a stage-less failure
(`extension.ts` `inferFailureClass` always returns at least `"unknown"` →
`sessionState.ts:207` `recordFailure`), `lifecycle.ts:364` only clears failures keyed by
stage, and `recordRecovery` (`lifecycle.ts:345`) has **zero live callers** — so one typo'd
command blocks the gate forever, even after verification passes. The only escape is the
untracked "verification was skipped" prose phrase, i.e. the gate teaches gate-evasion.
Fix: key failures by structural command fingerprint (port `anti_stall.py`'s flag-insensitive
`command_args_sig`), auto-supersede a latched failure when an equivalent command later
succeeds, let a fully-passing `cheater_verification_run` clear stage-less failures, and add
a tracked waiver (`/finish` override) recorded visibly in the ledger.

### 3.3 Recalibrate the loop governor (it blocks normal work)
`samePatchLimit=1` keyed on **file path alone** (`blueprint/config.ts:100`,
`sessionState.ts`) makes a third edit to one file a terminal block; `sameFileReadLimit=2`
punishes chunked reads of a big file; the 14-call budget applies to the whole interactive
turn. This is the biggest "harness feels worse than raw Pi" source. Fix: port the
structural fingerprints from legacy `cheater/anti_stall.py` (flag-insensitive command sigs,
line-number/timestamp-insensitive test and error fingerprints, patch identity =
(file, normalized content hash)), raise budgets to ~40 calls/turn, patch limit 3, and
reserve terminal blocks for *byte-identical* repetition. Also wire the never-called
`observeAssistantText` (message_end) — text repetition is the classic A3B degeneration mode.

### 3.4 One probed project-command registry (kill the `npm test` hardcode)
`commitlet/planner.ts:98/246` hardcodes `npm test` as default verification → in any non-npm
repo every commitlet fails verification, spawns a doomed repair, and **reverts correct
work**. Meanwhile `reliability/projectCommands.ts` exists but has its own bugs (`:108` emits
the nonexistent `npm run vitest run`; `:109/:114` `run('test:unit')` is always truthy so it
recommends scripts that don't exist), and `mission/orientation.ts` is a third divergent
scanner. Fix: one detector that parses manifests, checks binaries exist, probes each
command once per session, caches to `.cheater/commands.json` with mtime invalidation — and
**every** consumer (commitlet grading, verificationRunner, packets) reads only this registry.

### 3.5 Stop fabricating verification and diff stats
- `blueprint/state.ts:42` sets `verificationPassed: status === 'done'` — never runs anything.
- `commitlet/state.ts:31-35` records `filesChanged = expectedFilesTouched` (fabricated).
- `finalizePlan` calls the final review with `diffText=''` so it reviews nothing.
The finish gate and reviewer grade partly invented data — corrupted feedback is worse than
none. Fix: a packet is `done` only when its verification command exits 0 in code; record
*observed* diffs (the new `diffUtil.ts` already computes them); pass the real accumulated
diff to final review.

### 3.6 Single-source, config-aware system prompt (kill the triple injection)
`launcher.ts:73-77` passes `prompts/cheater.md` as **both** `--prompt-template` and
`--append-system-prompt`, then `extension.ts:150` appends the drifted near-duplicate
`CHEATER_SYSTEM_PROMPT` plus `cheaterCapPrompt` (whose blueprint-planner prohibitions reach
every session, including plain Q&A). A3B-class models are notoriously bad at reconciling two
drifted rulebooks; this wastes ~40% of the instruction budget per request. Fix: one
`buildSystemPrompt(config, modelProfile)` in `prompts.ts`, injected once at
`before_agent_start`, emitting only sections for enabled subsystems (no autopilot promise
when autopilot is off, no planner prohibitions unless a blueprint is active). Delete the
"Cheater must remain solely a Pi wrapper" repo-governance paragraph (model-facing noise).
Add a test asserting every tool name cited in the prompt is actually registered.

### 3.7 Autopilot header diet: 3 imperative lines, telemetry to the TUI
`router.ts:44-81` prepends ~8-12 lines of mode/discipline/risk/`confidence: 0.62`/reason
metadata **before** the user request — routing telemetry gets positional primacy over the
goal, and fabricated confidence numbers are exactly the authoritative-looking noise a small
model parrots. Fix: model sees only the imperative tool script + the user request; the full
decision stays in the existing widget and `/autopilot-status`.

### 3.8 Mode-scoped tool menus: ~40 tools → ~8 visible
40 `cheater_*` tools register unconditionally (7 core + 14 mission + 10 commitlet +
9 blueprint). Qwen3.6's weakest benchmark is multi-tool orchestration; overlapping entry
points (`cheater_oracle_stack` vs `cheater_verification_run`) are precisely the wrong-tool
trap, and every schema is per-request context tax. Pi exposes
`ctx.setActiveTools(toolNames)`/`getActiveTools()` (`extensions/types.d.ts:893`), so this
needs no hacks: default set = `cheater_reliability_start`, `cheater_commitlet_next`,
`cheater_verification_run`, `cheater_finish_gate`, `cheater_line_edit`,
`cheater_bug_memory_search` (+ Pi natives); expose subsystem tools only while their mode is
active; debug tools behind `config.debug`. Bonus: fewer tool schemas also preserves Qwen's
thinking depth (tool definitions suppress its reasoning ~10x).

### 3.9 Harness-run verification at agent_end (don't nudge — do it)
Today `agent_end` (`extension.ts:225-249`) sends up to 2 followUp nudges asking the model to
please call `cheater_verification_run` — the whole gate rests on a 3B-active model chaining
a meta-tool it forgets. Verification is deterministic code; run the focused/cheap stage
automatically in the harness when the ledger shows unverified changes, record stages into
the ledger, and only message the model **when it fails**, carrying the compressed failure.
Fold the finish-gate verdict into `cheater_commitlet_next`'s final-review payload. This cuts
the protocol chain the model must remember from 4 tools to 2 and saves 1-3 full local
inference roundtrips per request. (Prerequisite: async spawn — see 6.4 — so the hook doesn't
freeze the extension host.)

### 3.10 First-run onboarding + defaults audit for the local-Qwen persona
On first `session_start` with no `.cheater/`, run the probed command registry + orientation
once, write `.cheater/project.json`, and show a one-time card ("detected: cargo test ·
profile: moe35b"). Defaults audit: `gymEnabled=false` (dev tooling; its suite can't even run
live), `missionControlEnabled=false` until its playbook bug is fixed (it stacks 13 tools + 9
commands on the model for a flow the router barely uses), loop-governor thresholds relaxed
per 3.3, autopilot/commitlet/verification stay on. Make `doctor` report config parse errors
(currently swallowed silently) — and keep the prompt/tool inventories consistent with
whatever is disabled.

---

## 4. P0/P1 — Subtraction: one pipeline, one truth

The consolidation program. Each item deletes a competing mechanism so the one live path
gets all the investment.

### 4.1 Collapse Blueprint into the commitlet lifecycle (P0, L)
Blueprint's planning theater is decorative and provably broken: `candidateScorer.ts`
penalizes every candidate for its own guardrail strings (`BASE_FORBIDDEN` "standalone TUI"
text matches the scorer's own regexes over `JSON.stringify`), so **all candidates always
self-invalidate**, selection always falls back to candidate-C, and the displayed
`confidence ~0.33` is a constant. `checker.ts` is a rubber-stamp; `qualityGate`/`reviewer`
overlap commitlet's graders. Delete: A/B/C candidate generation, `candidateScorer.ts`,
`checker.ts`, `qualityGate.ts`/`qualityRepair.ts`, blueprint `reviewer.ts`, the
blueprint↔commitlet round-trip adapters, `webScout.ts` (739 lines never wired to a
provider). Keep the parts that work and fold them in: `perFilePackets` splitting,
`packetPrompt.ts` rendering, `worker.ts` `sdkFreshAgentPacketRunner` (the real fresh-worker
engine), `constraintGraph` facts. Result: **one tool protocol** instead of two competing
ones (`blueprint_create/next_packet` vs `reliability_start/commitlet_next`).

### 4.2 Shrink Mission Control to a repro gate inside the main chain (P0, M)
Mission's flagship is broken: `playbookFor(bug_fix, false)` returns the `no_op` playbook for
every bug-fix mission (`playbooks.ts:160-163`; mission start always passes `repro=null`),
`bugWorker.ts` fabricates `reproduced:true` (`mission/tools.ts:231`), and `oracles.ts` is a
third verification stack. The one mechanism nothing else has is `repro.ts`'s
reproduce/alreadyPassing/environmentFailure trichotomy. Keep exactly that (plus the
bug-memory write path in `learn.ts`), run it **in code** inside `cheater_reliability_start`
when the routed task is bug-shaped, and delete the other 13 mission tools, 9 commands,
mission classifier, store, and bench. See also 5.6 (repro enforcement).

### 4.3 One verification stack (P0, M)
Merge `commitlet/verification.ts` `runFocusedVerification`, `mission/oracles.ts`, and
blueprint per-packet verification into `reliability/verificationRunner.ts` as the single
executor all graders call, feeding one `CompletionLedger` with one failure-classification
scheme. One verifier = the repair prompt a small model receives always has the same compact
shape.

### 4.4 One classifier, no double routing (P1, M)
Delete `mission/classifier.ts` (parallel regex taxonomy) and `orientation.ts`'s command
scanning (see 3.4). And stop the double classification: `cheater_reliability_start`
currently **re-routes the model's paraphrased `userGoal`** (`commitlet/tools.ts:173`), so
the executed plan can differ from the routing the user was shown. Fix: the tool reads the
harness-side `AutopilotState` singleton — the plan binds to the original message with zero
model involvement.

### 4.5 Collapse routing to two modes (P0, S)
`vanilla_pi` funnels into the same commitlet pipeline anyway; `mission_control` differs by
one unenforced sentence (becomes the code-side repro gate). Keep `answer_only` and
`execute`. Delete the unreachable `fast_path` discipline, the never-populated escalation
inputs (`previousFastPathFailed`, `repeatedFailure`), and `inferRepoHints` (computed, read
nowhere).

### 4.6 Excise the legacy Python tree (P1, M)
138 modules, ~25.9k LOC, dead per `docs/LIVE_PATH.md`. Port the two genuinely unported gems
first — `failure_compressor.py` (structured failure digests, see 5.2) and `anti_stall.py`'s
structural fingerprints (see 3.3) — then delete everything except `pi_launcher.py`
(until 4.7 kills that too). Also delete both TUIs, ~20 `*_cli.py`, arena/bench/distiller.

### 4.7 One launcher (P1, S)
`pi_launcher.py` and `launcher.ts` are full parallel implementations that already diverged
(Python honors `CHEATER_REAL_PI_COMMAND` and checks the theme file exists; TS doesn't; TS
always points `--extension` at `src/` even when packaged). Replace the pip entry with a
~15-line shim that execs the TS CLI, or drop pip entirely. A deterministic environment is a
precondition for any reliability tuning to hold.

### 4.8 Command surface: ~63 → ~10 (P1, S/M)
Merge the 8+ read-only status commands (`/reliability-status`, `/commitlet-status`,
`/commitlet-plan`, `/commitlet-health`, `/rollback-status`, `/health-report`,
`/autopilot-status`, `/blueprint-show`) into one sectioned `/status`. Delete pure aliases
(`/traces`+`/history` both print an entry count), dead surfaces (`/skills`,
`cheater_skill_search` — ignores its own query param), `/loop-report` (hardcoded mock data),
and every command that just `sendUserMessage`s a prompt begging the model to call a tool —
**rewire those to call the underlying functions directly** (`gradeCommitlet`,
`revertRollbackPoint`, `runFocusedVerification` are all directly callable; each re-prompt
is a wasted local-inference roundtrip and an improvisation opportunity). Gate the rest
behind `config.debug`. Generate `startupCard`/`PUBLIC_COMMAND_NAMES`/help from the actual
registration list (they're already stale hand-copies) with a drift test.

### 4.9 Config diet: ~97 keys → ~15 + a preset (P1, M)
Six commitlet knobs are declared and never read (`repairAttemptsPerCommitlet`,
`rollbackRequired`, `finalReviewEnabled`, `commitletAutoForCodeTasks`,
`allowTestEditsByDefault`, `retrievalMax*`). ~18 blueprint keys die with 4.1. Replace the
seven per-limit loop-governor knobs with `loopGovernor: strict|normal|off`. Derive packet
budgets from `modelProfile`. Every surviving key must be provably consumed — silent no-op
keys make tuning experiments produce false conclusions.

### 4.10 Delete the three fake benchmarks (P1, S)
`reliability/bench.ts` hardcodes `toolCalls` 8-vs-4 and `diffLines` 24-vs-6 (variants B-E
cannot lose by construction); mission delta-bench success is a model-supplied boolean;
`blueprint/evalHarness.ts` scores a regex `mockModelStub` against asymmetric rubrics where
`graph_intelligence` wins by definition. These generate evidence-shaped reports that could
justify bad tuning. Gym becomes the only benchmark home (see §7).

### 4.11 Dead-code sweep + no-dead-exports CI gate (P2, S)
`commitlet/memory.ts` (imported nowhere — but wire `retrieveCommitletFeedbackFacts` into
repair prompts first, see 5.2), `commitlet/impact.ts`/`blueprint/impact.ts` near-duplicates,
`cheaterPromptAppend`, `skills.ts` hardcoded registry, mission dead exports, two always-ok
doctor checks. Add `knip`/`ts-prune` to `npm test` so the consolidated pipeline cannot
silently regrow — dead layers re-entered the live path through casual imports before.

### 4.12 Prune docs to the shipped product (P2, S)
Delete `docs/reports/` (17-19 pre-fix reports crediting a reliability layer that never ran)
and the tombstone docs (`AGENT_ARCHITECTURE.md`, `AGENT_LOOP.md`, `context_optimizer.md`,
`distillation.md`, `arena.md`, `traces.md`) once the Python tree is gone. Fold
`LIVE_PATH*.md` into one `ARCHITECTURE.md`. Generate tool/command inventories from
registration code — stale docs are how contradictory instructions leak back into prompts
(the `/fix` contradiction came from exactly this).

---

## 5. P1 — Punch-above-weight: small-model maximization

The features that buy back capability the model lacks. Ordered by leverage.

### 5.1 Real fresh workers by default (the Claude Code subagent pattern)
`cheater_reliability_start`/`cheater_commitlet_next` default to
`freshWorkerMode: "simulated"` — the packet prompt is appended into the orchestrator's own
session unless the model remembers to pass `spawnFreshWorker=true`
(`commitlet/tools.ts:231,312`). So the advertised context isolation is **fiction by
default**, and the orchestrator context grows with every commitlet, drifting past the ~32K
reliable zone exactly when precision matters. The real path
(`spawnFreshWorkerForCommitlet` → `sdkFreshAgentPacketRunner` + immediate code grading)
already exists and is tested. Flip the default via config (not a model-supplied parameter —
remove that entirely), return only the graded 1-line summary + diff stats to the
orchestrator, and wire workers into the live loop governor (they currently bypass
`sessionState`). Budget for the sentinel false-failure mode and doubled per-commitlet
latency; this also reduces the urgency of all compaction work.

### 5.2 Port `failure_compressor.py` → TS as the single error-feedback formatter
Raw test logs are the #1 context killer for a 3B-active model — one verbose pytest run can
eat a third of the reliable zone and bury the assertion. The legacy compressor
deterministically parses pytest/jest/tsc/tracebacks into
`{failingTest, errorType, expected, got, topStackFiles, nextActionHint}`. Port it to
`reliability/failureCompressor.ts` and make it the **only** failure renderer: the
`tool_result` hook for any bash output over ~2k chars (full log to `.cheater/logs` with a
pointer line), `verificationRunner` stage failures, `commitlet/verification.ts`
`compressFailure` (currently a blunt 8-line/600-char truncation), repair-commitlet prompts,
and finish-gate notices. Always end with one imperative next-action line — the format weak
instruction-followers act on best. Also wire the dead `retrieveCommitletFeedbackFacts` into
repair prompts so a repair worker gets failure history, not just the fresh failure.

### 5.3 Post-edit syntax gate (SWE-agent's single biggest ACI win)
After any edit tool result, run the cheapest applicable per-file check — `node --check`,
`python -m py_compile`, `JSON.parse`, TS syntax-only diagnostics — and append ≤8 compressed
diagnostic lines **to the edit's own tool result** (the channel the model actually reads).
A file that fails to parse blocks `cheater_commitlet_next` from grading until fixed.
SWE-agent measured lint-before-accept as one of the largest single wins (3.8%→12.5% era);
small models introduce syntax errors constantly but fix them near-perfectly when told
immediately and in-band. Keep it per-file and fast — no repo-wide `tsc --noEmit` inside a
synchronous hook.

### 5.4 Few-shot exemplar library (one worked example beats five rules)
No exemplars exist anywhere in the prompt stack; it's all prose rules, and the one-file rule
is restated ~5x per worker prompt. Create `src/prompts/exemplars.ts`: compact worked
transcripts (~30-40 lines) of (a) one correct commitlet cycle, (b) one correct answer_only
turn, (c) one correct `BLOCKED_NEXT_FILE` handoff, (d) one correct edit block. Inject
exactly **one**, selected by taskKind + model class. Research (arXiv 2605.26731) and Claude
Code's own prompt confirm small models gain disproportionately from worked examples;
replace the 5x rule restatements with the single demonstration. Exemplars must only cite
tools that are unmasked (coordinate with 3.8).

### 5.5 Symbol-slice snippets instead of head-of-file excerpts
`commitlet/executor.ts:86-90` `compactSnippet` sends the **first 40 lines/800 chars** of
each allowed file — usually the import block — and `packetPrompt.ts` caps at 900-1400 chars
from the file head. A 3B-active model holds roughly one function in working memory; give it
the actual target: locate the function/class whose name overlaps the commitlet
title/spec/failure terms (regex-symbol fallback is fine; no tree-sitter required), slice
that span plus one-line signatures of direct callers/callees. On repair commitlets, seed
the slice from the compressed failure's stack files + line numbers instead of reusing the
original excerpt. This converts the densest prompt channel from decoration into target
material.

### 5.6 Enforce repro-before-patch in the tool_call hook
When the route is bug-shaped, block edit tools until the ledger contains a repro record:
the failing command reproduced (reuse `mission/repro.ts`'s trichotomy), `alreadyPassing`
(short-circuit to no_change_needed — the only no-op detector in the codebase), or an
explicit user waiver. Store the exact failing command + expected/got on the plan as **the
oracle**: the finish gate then requires that same command to pass, and the diff guard
blocks edits to the oracle test file for the whole plan (structurally preventing
edit-the-test-to-match cheating). Fix the inverted timeout detection at `repro.ts:70`
(`Boolean(result.error) === false` can never be true on spawnSync timeout) and delete
`bugWorker`'s fabricated `reproduced:true`. "Make this exact command pass" is the tightest
possible goal spec for a small model.

### 5.7 Git-based checkpoints and rollback (replace file-copy snapshots)
`rollback.ts` reads/writes snapshots as utf8 text (corrupts binaries), skips files with no
snapshot entry (files created mid-commitlet survive revert), and the failed-repair path
reverts the repair's own snapshot taken from the **already-broken** tree
(`tools.ts:126-129` + `planner.ts:83`) — so "reverted" reports are false and every retry
starts from a poisoned world-state. Replace with git plumbing via a temporary index
(`GIT_INDEX_FILE` + `write-tree`/`read-tree` — never touch the user's real index): baseline
tree at plan start, pre-edit tree per commitlet, whole-chain unwind when final review
fails, `/rewind`-style restore. Keep file-copy as fallback for non-git dirs. Trustworthy
whole-tree undo is what makes aggressive deterministic gates tolerable.

### 5.8 Ground-truth change tracking via git status after bash
`EDIT_TOOLS` sets in `extension.ts:28` and `sessionState.ts:17` only see structured edit
tools (and they disagree with each other), so edits made via `sed`/`echo`/`git apply` —
exactly the fallback small models use when structured edits fail — bypass the scope guard,
the ledger, and grading. After each bash `tool_result` (and the currently-unhooked
`user_bash` event), diff `git status --porcelain` against a per-turn baseline and feed
changed paths into the ledger + scope guard. Also fixes: manual user-run test commands can
count as verification evidence. And fix the scope guard's `endsWith('/'+file)` suffix
matching (an edit to `any/other/README.md` passes when only root `README.md` is allowed).

### 5.9 Precision pass on the graders: keep blockers, demote noise
Verified false-positive sources that revert correct work: `health.ts` assertion-delta
blocker runs on **all** diffs (deleting a README line containing "should" hard-blocks);
`testAudit.ts:14`'s `\b(skip|only|todo)\b` matches words inside added test titles (switch
to call-syntax: `.only(`, `.skip(`, `xit(`); `guard.ts:25` blocks any 20 moved normalized
lines as churn (demote to warning for single-file diffs); `guard.ts:85`'s "requires
explicit approval" has **no approval mechanism anywhere** (add a documented override
parameter on `cheater_commitlet_next`). And per 6.3: every remaining hard block must carry
a "do this instead" line. An unexplained block on a correct edit is indistinguishable from
a real failure to a small model and reliably triggers retry spirals.

### 5.10 Working-set capsule re-injected every turn and after compaction
The `CompletionLedger` tracks changedFiles/commands/verification stages but that state only
reaches the model via the bounded agent_end nudge, and compaction survival rests on prose
instructions the summarizer may ignore. Render a ~10-line capsule — goal, active commitlet
+ allowedFiles, files touched with status, last verification result, next expected tool —
appended to the transformed message each turn and re-injected after **any** compaction
(hook Pi's real `session_compact` events, not just the extension's own `ctx.compact()`).
Periodic goal restatement into fresh context is the documented mitigation for coherence
collapse in long small-model trajectories.

### 5.11 Environment block: platform, shell, git state, verified commands
Pi's base prompt appends only date and cwd. On the owner's actual platform (Windows 11 +
PowerShell) the model emits bash-isms constantly. Inject ~10 lines at `before_agent_start`:
platform + shell semantics note, current git branch + short status (actually shell out —
`compactGitStatus` in `tools.ts:31-39` is a placeholder that never runs git), and the
probed commands from the registry (3.4). Cheapest whole-failure-class elimination
available (~200 tokens).

### 5.12 Real project brief, generated deterministically (`/init` → `AGENTS.md`)
`cheater_project_brief` returns a directory listing plus the literal placeholder string
"git repository detected; use Pi's bash tool for detailed status". Pi natively auto-loads
`AGENTS.md`/`CLAUDE.md` from cwd/ancestors — so don't build an injector; build the
**deterministic `/init` generator**: languages/frameworks, verified commands (from 3.4),
package manager, entrypoints, top-level shape — written to `AGENTS.md`, user notes
preserved on regeneration. Small models re-derive project facts through repeated
ls/read/grep every session; a 30-line always-loaded brief deletes that whole discovery
phase.

### 5.13 Sampling profiles + `preserve_thinking` actually applied
`modelProfile.ts` computes temperature/topP/penalties that are consumed **nowhere** — they
exist only as advisory prompt text (delete those lines; also the unenforced
`maxOutputTokens=700`, which is below the documented threshold where truncation corrupts
tool-call arguments). Two implementation routes, in order of preference:
1. Pi's experimental `before_provider_request` event "can replace the payload"
   (`types.d.ts:487-491`) — inject `temperature`/`top_p`/`presence_penalty` and
   `chat_template_kwargs: {enable_thinking, preserve_thinking: true}` for OpenAI-compatible
   local backends. Validate against the real LM Studio/llama.cpp request shape first;
   provider-fragile.
2. Fallback: server-side config (llama.cpp flags / LM Studio per-model defaults) + a
   `/doctor` check that prints the HF-card values to set.
The HF-card profiles matter: temp 0.6/top_p 0.95/presence 0.0 for coding-act; temp
0.7/top_p 0.8/**presence 1.5** for non-thinking turns (load-bearing against repetition);
`preserve_thinking=true` fixes the documented argument-looping failure. SDK workers accept
`thinkingLevel` via `CreateAgentSessionOptions`.

### 5.14 Plan/act request split (thinking planner, non-thinking workers)
Open Qwen issue #89: attaching tool definitions collapses thinking from ~3000-5000 to
~300-500 tokens — a trained-in behavior. Structure the pipeline to match: planning-quality
steps (goal decomposition, final-review reasoning) run as **tool-less** nested sessions
(`createAgentSession` with `tools: []`, `thinkingLevel` high), parsed harness-side;
edit packets run tool-attached, non-thinking, with the coding sampling profile. This buys
back the deep reasoning the model suppresses when tools are present, and matches how its
agentic RL was aligned. Sequence after §7 provides a measurement signal.

### 5.15 Best-of-N commitlet sampling, verifier as selector (sequential resample)
CodeMonkeys/S* show sample-and-verify buys back pass-rate a weak model lacks — and cheater
already owns a deterministic, non-gameable selector (`gradeCommitlet` + focused
verification). Implement as **sequential resample-on-fail**: on verification failure,
revert (via 5.7) and dispatch a fresh worker from the same packet, stop at first passer,
`commitletBestOfN` default 1 (suggest 2-3 for local). Sequential because workers edit the
real working tree; N=3 parallel would also triple wall-clock on a local box. Only after
the graders are trustworthy (5.9) — otherwise you select against guard false positives.

### 5.16 Context budgets that are honest
- Drop the compaction trigger to the ~24-32K reliable zone (config), not near the nominal
  window — Qwen3.6 fabrication climbs from ~1% at 32K to 5-10%+ past 64K, and unpatched
  llama.cpp has a repetition-loop hard wall near ~80K.
- Truncate oversized tool results at write time in the `tool_result` hook (elision marker +
  disk pointer) — the cheap-first layer; 5.2 covers the biggest case (test logs).
- Real tokenizer counts at the 3-4 budget chokepoints (`trimToBudget`, packet briefs, cap
  math) via `@huggingface/transformers` AutoTokenizer with the Qwen tokenizer cached
  locally; llama.cpp `/tokenize` optional; chars/4 as final fallback. A 15-25% estimation
  error at a 12-20K budget is thousands of tokens of silent overflow or waste.
- Rank constraint facts by goal overlap instead of `slice(0,4)` positional truncation
  (`executor.ts:30`); with 8 fact slots per worker prompt, each irrelevant fact wastes 12%
  of the densest evidence channel.
- Later: labeled context-pack sections with per-section caps and a visible
  "dropped MEMORY(2), clipped FILE-SLICE(40%)" accounting line (port the
  `context_pack.py` design) — after slices/facts/tokenizer land.

### 5.17 @-file references
Detect `@relative/path` in the input hook, resolve via the existing `safeRepoPath`, append
a bounded excerpt under a delimited reference block, and feed resolved paths into
`AutopilotInput.likelyFiles` (currently never populated) + commitlet `allowedFiles`
seeding. Lets the user do the localization the small model is worst at.

### 5.18 Memory retrieval: precision over recall
`blueprint/memory.ts:20` is substring matching over unbounded JSONL sorted by self-assessed
confidence; failed plans are stored indistinguishably from successes. Don't build a new
engine — `bug-memory.ts` already implements a proper TF-IDF/BM25-style sharded index.
Extend it to serve plan memory and evidence, and add what's genuinely missing: an
`outcome` field written at finish-gate time (verified/reverted/failed) that demotes failed
entries, recency decay, dedup-on-write, and a hard 3-card cap each rendered with a
one-line why-matched reason. Small models over-trust injected memories; retrieval
precision is safety-critical.

---

## 6. P1 — UX: make it feel like Claude Code

### 6.1 One persistent status line
Three uncoordinated aboveEditor widgets (`cheater-startup`, `cheater-autopilot`,
`cheater-lifecycle`) stack today. One `cheater-status` widget from one reducer over the
session state: `▶ commitlet 2/4 · src/router.ts · verify: pending · ctx 38%`. Routing
detail moves behind `/status`. Deterministic harness state, not model narration.

### 6.2 Deterministic completion receipt
When `ledgerAllowsFinish` returns ALLOWED, render a completion card **from the ledger**:
files changed (real diffs), commands run with exit codes, verification stages, repair/
revert events — zero LLM involvement. When BLOCKED: the specific latched reason and the
one action that clears it. Qwen-class models hallucinate completion summaries; a
code-generated receipt is the strongest "trustworthy autonomy" signal available, nearly
free (`toHuman()` already exists in `lifecycle.ts:386`).

### 6.3 Every guard block gets a recipe
Guard failures are terse single sentences with no remediation ("Broad formatting-only churn
detected"). Add a `guardCode → {userLine, modelDirective}` table across `guard.ts`,
`health.ts`, `testAudit.ts`, and the scope guard: e.g. *"Edit only src/foo.ts for this
commitlet. To change another file, finish this commitlet and call cheater_commitlet_next."*
Small models cannot infer recovery from a bare rejection — they retry into the loop
governor. Explicit positive replacement instructions are the documented fix.

### 6.4 Non-blocking verification with live progress
`commitlet/verification.ts:25` and `verificationRunner.ts:120` use `spawnSync`, freezing
the extension host for up to 120s with zero feedback — the TUI appears hung at exactly the
moment the harness does its most valuable work. Async spawn, stream
`verify: pytest -k auth · 14s` into the status widget, support abort. Prerequisite for 3.9.

### 6.5 Startup card diet
4 lines: version + model (+ detected profile class), active modes, one hint. Generated from
the real (post-collapse) registration list with a drift test. A calm card reads like Claude
Code instead of a debug console.

### 6.6 Session persistence and resume
`liveSessionState`/`defaultCommitletState`/`defaultBlueprintState` are volatile module
singletons that bleed across Pi session switches and lose everything on crash — and local
runs crash more (llama.cpp state overflow, OOM). Persist minimal state
(`.cheater/session-state.json`: plan id, commitlet statuses, ledger summary, last goal) on
transitions; hook the real `session_before_switch`/`fork` events (state-bleed is a
documented gap); on `session_start` with an unfinished plan, show a resume card. Pi already
ships `--continue`/`--resume` and the launchers forward passthrough args — only the cheater
state layer is missing.

### 6.7 Webapp verification correctness
`runSmoke` curls immediately after spawn (races server startup → spurious failures the
model cannot fix), `servedWorkspaceProbe` has no default implementation (the flagship
stale-workspace stage never runs outside tests), and the manifest writes the workspace
signature into the `userGoal` field (`verificationRunner.ts:372`). Add bounded readiness
polling, a default probe (marker file), fix the field mixup. Harness-caused false failures
are the fastest way to destroy the model's trust in the loop.

### 6.8 Bash risk classifier (later)
Allow/ask/deny for bash: allowlist read-only + registry commands, `ctx.ui.confirm()` for
destructive patterns (rm, git push, npm install, checkout --), hard-deny repo escapes.
P2 on a single-user local box, but it's what makes granting broad autonomy feel safe.

---

## 7. P1 — Evals: make improvement measurable (the Gym rebuild)

Nothing above can be *tuned* without a gradient signal, and today there is none:

- `extension.ts:96-101` registers gym without a `runAgent` hook, so `/gym-run-suite` is
  **unreachable live**.
- `gym/commands.ts:117-122` snapshots the baseline **after** the run, so every diff
  compares the workspace to itself.
- Grading is `RunHookOutcome` self-report — it measures the model's willingness to claim
  success, the exact behavior the harness exists to neutralize.
- 10 of 25 zoo tasks contain no bug (the "fix" target already passes).

Rebuild in three steps:
1. **Pre-flight**: run each task's `focusedTestCommand` on the pristine workspace; the task
   is invalid unless it fails. (Also becomes the shared repro-gate implementation insight.)
2. **Ground-truth grading**: execute focused/full commands via the verification runner
   post-run; delete self-reported `focusedTestsPassed`/`reproduced`.
3. **Headless driver**: spawn a real Pi session against the configured Qwen endpoint per
   task (`createAgentSession` gives the in-process path), with pass@3, token count, turn
   count, wall-clock, loop-governor events, and guard false-positive columns in the report.

Then use it: A/B every contested default (loop budgets, worker isolation, best-of-N,
exemplars on/off, thinking split) per model class. The research is unambiguous that
mid-tier models show the largest performance swings from harness choices — this is where
the "punch above its weight" claim gets proven or falsified.

---

## 8. Inference-stack playbook (docs + doctor checks, not code)

Ship this as documentation plus `/doctor` validations — the harness can't fix a
misconfigured server, but it can detect and name every one of these:

| Setting | Recommendation | Why |
|---|---|---|
| Runtime | vLLM + FP8 (hosted) / llama.cpp or LM Studio with Unsloth dynamic quants (local) | best current support for the hybrid GatedDeltaNet arch |
| Quant | UD-Q4_K_XL minimum; UD-Q6_K_XL for tool-heavy work | Q4 tool-call instability reports; Q6/Q8 more stable |
| Context | Native 262K, **YaRN off**; treat ≤32K as the reliability zone | YaRN taxes short-input quality; fabrication climbs past 32K |
| llama.cpp | patched/nightly build (GatedDeltaNet state-overflow repetition wall ~80K); avoid CUDA 13.2 | documented hard failure modes |
| Sampling (act) | temp 0.6 · top_p 0.95 · top_k 20 · presence 0.0 | HF-card coding profile |
| Sampling (non-thinking) | temp 0.7 · top_p 0.8 · presence **1.5** | presence 1.5 is load-bearing against repetition |
| `preserve_thinking` | **on** for multi-turn agent sessions | fixes documented argument-looping; budget its 50-100K/15-20-turn cost via compaction |
| Thinking mode | per-request via chat-template kwargs (no /think soft switch) | plan=thinking, act=non-thinking |
| max_tokens | 8K+ (not 700) | low caps truncate/corrupt tool-call arguments |
| Speculative | MTP (`--spec-type draft-mtp`, vLLM `method: mtp`) | ~2x decode speed; latency compounds per agent turn |
| Tool parsing | server-side parser (`qwen3_xml` / `qwen3_coder` — verify per version); treat HTTP 500 on prose-before-tool_call as retryable | known llama.cpp grammar-parser failure |

`/doctor` should print: detected backend, quant, context length, whether
`preserve_thinking` is on, sampling params vs the recommended profile, and the max_tokens
check.

---

## 9. Do NOT build (ideas examined and rejected)

- **Grammar/GBNF-constrained decoding through Pi** — no per-request grammar surface exists
  in Pi's session/extension API; would require a parallel raw-HTTP inference path,
  contradicting the wrapper architecture. Sentinel + one-repair + code-side grading
  already covers the failure class. (Server-side structured output remains a fine
  *inference-stack* option if Pi ever exposes it.)
- **Aider-style fuzzy patch application engine** — no model-emitted patch is ever
  machine-applied in this architecture; edits flow through Pi's native edit tool. The one
  feasible slice: whitespace/indentation-tolerant matching for `cheater_line_edit`'s
  `expectedText` guard (currently exact `.includes()`), plus edit-format guidance in
  packet prompts.
- **Full tree-sitter + PageRank repo map now** — L-effort new layer; Aider documents weak
  models get overwhelmed by repo maps. First: ranked, budgeted, clearly-delimited facts on
  the existing regex graph (5.16). Revisit only if gym evals show localization is still
  the bottleneck.
- **Byte-stable-prefix micro-optimization** — premise mostly wrong: the cap prompt is
  already byte-stable within a session, history is append-only, and compaction breaks the
  cache anyway. (The prompt *collapse* in 3.6 is still worth it for token/consistency
  reasons.)
- **Model-selected playbooks/skills** — `playbookFor` selection is deterministic harness
  code; moving that choice onto a 3B-active model is a regression. Same for a custom
  skills-on-demand scanner: Pi already implements progressive skill disclosure natively.
- **Auto-decompose escalation rung** — a new deterministic planning layer between two
  mechanisms that already exist (repair commitlet, revert-and-stop). Ship the structured
  blocked report (what was tried, failure classes, 2-3 options) instead.
- **OpenHands-style full event-log rearchitecture** — double-counts the subtraction work.
  Descoped to: record observed (not fabricated) data, key state per Pi session, hook the
  session lifecycle events.
- **Thinking-trace pruning on a turn schedule** — requires history rewriting Pi doesn't
  expose. Revisit if Pi grows a history-editing API.

---

## 10. Sequencing

**Wave 1 — Stop the sabotage (all S/M; days not weeks).**
3.1 mid-task re-routing · 3.2 finish-gate wedge · 3.3 loop-governor recalibration ·
3.4 command registry · 3.5 fabricated verification · 3.6 prompt collapse · 3.7 header diet
· 6.3 guard recipes · 6.7 webapp verification fixes.
*Exit criterion: a competent model doing normal work never gets blocked, reverted, or
contradicted by the harness.*

**Wave 2 — Subtraction.**
4.1 blueprint collapse · 4.2 mission shrink · 4.3 one verifier · 4.5 two routing modes ·
3.8 tool masking · 4.8 command collapse · 4.4 one classifier · 4.10 fake benchmarks ·
4.6/4.7 Python tree + launcher · 4.9 config diet · 4.11 CI gate.
*Exit criterion: one pipeline, ~8 tools, ~10 commands, one prompt, every config key
consumed.*

**Wave 3 — Punch above weight.**
5.1 fresh workers default · 5.2 failure compressor · 5.3 post-edit syntax gate ·
3.9 harness-run verification (+6.4 async) · 5.6 repro/oracle gate · 5.7 git rollback ·
5.8 git ground truth · 5.4 exemplars · 5.5 symbol slices · 5.11 env block · 5.12 /init ·
5.16 honest budgets · 5.10 working-set capsule.

**Wave 4 — Measure, then tune.**
§7 gym rebuild → A/B: 5.13 sampling/preserve_thinking · 5.14 plan/act split ·
5.15 best-of-N · 5.18 memory precision · defaults per model class.

**Continuous:** 6.1 status line · 6.2 receipt · 6.5 startup card · 6.6 resume ·
4.12 docs prune.

---

## 11. Why this makes Qwen feel like Claude Code

Claude Code's feel decomposes into five properties, and every wave maps onto them:

1. **It never lies about what happened** → code-run verification, real diffs, deterministic
   receipt, unwedgeable-but-honest finish gate (3.5, 3.9, 5.6, 6.2).
2. **It never fights you** → no mid-task contradictions, no false blocks, recipes on every
   refusal, trustworthy undo (3.1, 3.3, 5.9, 6.3, 5.7).
3. **It stays coherent for hours** → fresh workers, small contexts, working-set capsule,
   goal restatement, resume (5.1, 5.10, 5.16, 6.6).
4. **The model always knows exactly what to do next** → one pipeline, ~8 tools, one prompt,
   one exemplar, structured failures with a next-action line (§4, 5.2, 5.4).
5. **It's visibly alive** → status line, live verification ticker, instant deterministic
   routing feedback (6.1, 6.4).

The deep principle, confirmed by both the research (Agentless, SWE-agent ACI, harness-
sensitivity studies) and this codebase's own history: **for a 3B-active model, put
judgment in the harness and let the model do the one thing it's near-frontier at —
writing a small, correct diff for a well-specified, well-localized task.** Everything in
this plan either removes a place where the model had to exercise judgment it doesn't have,
or tightens the specification and feedback for the diff it's about to write.
