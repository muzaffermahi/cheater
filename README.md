# Cheater

Cheater is a **Pi-based coding agent distribution**.

The user workflow is one command:

```powershell
cheater
```

Run it inside a project folder. Cheater launches Pi's real TUI with Cheater's
extension, prompt, skills, slash commands, and theme already loaded.

Cheater is not a separate Python coding agent, not a separate Python TUI, and
not a prompt you paste into Pi. Pi owns the TUI, tool execution, editing,
context handling, session behavior, slash-command surface, and agent loop.

Cheater now routes normal requests automatically. Users should ask normally:

```text
add official docs search
fix this failing test
refactor the memory search
add a /hello command
```

Cheater is **autonomous by default**: one prompt runs to completion. There is
no approval step - a request like "build a whole app from scratch" plans and
builds in a single turn. Destructive intent (deleting files, dropping a
database, dependency/lockfile churn) is surfaced to the model as a caution it
proceeds through, not a stop. Set `"requireApprovalForHighRisk": true` to make
genuinely destructive requests pause and ask first.

The main session breathes up to ~90% of the model's real context window (set
`maxSessionContextTokens` to cap it lower). Only the small per-file worker
packets are deliberately tiny - the planner is never told to ration its work.

Autopilot classifies the request and then drives **one flow** for every
code-changing task:

```text
cheater_run   (closed loop: the harness drives the whole chain)
  -> route -> plan -> spawn bounded worker -> grade in code -> repair -> repeat
  -> final review -> finish gate -> deterministic receipt
```

or, when no real fresh-worker backend is available, the classic handoff flow:

```text
cheater_reliability_start -> edit only the allowed files -> cheater_commitlet_next
  (repeat) -> cheater_verification_run -> cheater_finish_gate
```

### Closed-loop execution

`cheater_run` lets Cheater drive the whole commitlet chain deterministically when
real fresh workers are available. The model edits only bounded worker packets; the
harness plans, grades, repairs, advances, verifies, and gates completion. If fresh
workers are unavailable, Cheater degrades honestly to simulated handoff mode
(returning the first worker prompt) instead of claiming it executed the task.

`cheater_reliability_start` routes, builds a commitlet plan with a rollback point,
and hands back a small single-file worker prompt. `cheater_commitlet_next` grades
each edit in code (diff guard, patch health, test audit, focused verification) - it
is not model say-so. `cheater_finish_gate` refuses to report "done" until the
completion ledger holds real verification evidence, and a deterministic receipt is
printed from that ledger. Users do not type `/blueprint` or `/commitlet`
before normal work.

## Install

From this repository:

```powershell
pip install -e .
cd cheater-pi
npm install
npm run build
npm link
```

After linking, open a new PowerShell window if PATH has not refreshed.

## Run

```powershell
cd C:\path\to\your\project
cheater
```

Useful wrapper commands:

```powershell
cheater --help
cheater --version
cheater --doctor
cheater --print-pi-command
cheater --debug
cheater --no-theme
cheater gym list                # Cheater Gym - local benchmark
cheater gym run <task_id>       # prepare a gym workspace
cheater gym report latest       # show latest gym report
cheater bench reliability run B # run the offline Reliability Mode benchmark
cheater bench reliability compare
```

### Model-facing tools (the one flow)

A weak model's worst skill is multi-tool orchestration, so Cheater masks the
`cheater_*` tool surface per phase. During execution the model sees only these:

| Tool | Purpose |
| --- | --- |
| `cheater_run` | Closed loop: plan, spawn workers, grade, repair, review, gate, receipt - all in one deterministic call |
| `cheater_reliability_start` | Route, plan commitlets, take a rollback point, return the first single-file worker prompt |
| `cheater_commitlet_next` | Grade the current edit in code (guard/health/audit/verify), then prepare the next commitlet or run the final review |
| `cheater_line_edit` | Apply a bounded, stale-safe line/range edit |
| `cheater_verification_run` | Detect and run the project's dev/test/score commands and feed the ledger |
| `cheater_finish_gate` | Block "done" until the ledger holds verification evidence (or a tracked waiver) |
| `cheater_bug_memory_search` | Search the compacted solved-bug corpus on a failure |
| `cheater_ledger_status` / `cheater_rollback_status` / `cheater_commitlet_revert` | Inspect progress and recover |

`cheater_project_brief`, `cheater_focus_test`, and `cheater_diff_safety_check`
were deliberately removed from the execution surface: the env block, the automatic
diff guard, and `cheater_verification_run` already provide them, so re-exposing
them only added tool-choice noise.

### Status and inspection commands

| Command | Purpose |
| --- | --- |
| `/cheater` | Show Cheater status and command help |
| `/autopilot-status` | Show the latest automatic routing decision |
| `/reliability-status` | Show Reliability Mode status |
| `/commitlet-status` / `/commitlet-plan` | Show the active commitlet chain |
| `/commitlet-verify` / `/commitlet-revert` / `/commitlet-health` | Verify, revert, or inspect a commitlet |
| `/rollback-status` | Show rollback snapshots; pass `cleanup` to remove old snapshots |
| `/health-report` / `/constraint-graph` / `/bench-report` | Kernel health, repo constraint facts, benchmark report |
| `/loop-report` / `/model-profile` | Loop Governor diagnostics, local-model packet settings |
| `/test` / `/map` / `/bug-memory` / `/remember` | Focused test, repo overview, bug-memory search, save a note |
| `/skills` / `/settings` / `/doctor` | Skills, settings, in-session diagnostics |

### Advanced / opt-in surfaces

Blueprint planning powers `cheater_reliability_start` internally; its inspection
commands (`/blueprint-show`, `/blueprint-cancel`, `/blueprint-docs`,
`/blueprint-memory`) stay available. The **Gym** local benchmark (`/gym*`)
stays on for measuring Cheater against vanilla Pi.

Debug-only commands remain for Cheater development: `/commitlet-next`,
`/commitlet-debug`, `/autopilot-route`, and `/autopilot-run`.

## Pi Discovery

Cheater resolves Pi in this order:

1. `CHEATER_PI_COMMAND`
2. `CHEATER_PI_PATH`
3. `CHEATER_REAL_PI_COMMAND`
4. `pi` on PATH, skipping stale Cheater shims
5. the npm global Pi shim under `%APPDATA%\npm`

If Pi is missing, `cheater --doctor` prints a clear failure and installation
hint instead of a Python traceback.

## Config

Cheater reads JSON config from:

```text
~/.config/cheater/config.json
.cheater/config.json
```

Project config overrides global config. Supported keys:

```json
{
  "piCommand": "C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd",
  "provider": "openai",
  "model": "gpt-5.2-codex",
  "themeEnabled": true,
  "defaultTestCommand": "pytest -q",
  "memoryEnabled": true,
  "skillsEnabled": true,
  "debug": false,
  "showStartupCard": true,
  "reliabilityModeEnabled": true,
  "autopilotEnabled": true,
  "autopilotRouteAllCodeTasks": true,
  "requireApprovalForHighRisk": false,
  "maxSessionContextTokens": null,
  "freshCallPacketsEnabled": true,
  "packetOneFilePerWorkerEnabled": true,
  "packetMaxFilesToTouch": 1,
  "packetContextBudgetTokens9B": 10000,
  "packetContextBudgetTokensMoE": 20000,
  "packetHardContextCeilingTokens9B": 12000,
  "packetHardContextCeilingTokensMoE": 24000,
  "loopGovernorEnabled": true,
  "maxLoopBreaksPerPacket": 2,
  "maxToolCallsTinyPacket": 3,
  "maxToolCallsNormalPacket": 6,
  "maxToolCallsHardPacket": 10,
  "maxTotalToolCallsPerPacket": 14,
  "sameFileReadLimit": 2,
  "sameFailedCommandLimit": 1,
  "sameSearchQueryLimit": 2,
  "samePatchLimit": 1,
  "stopSentinelsEnabled": true,
  "jsonStopSentinel": "@@END_JSON@@",
  "patchStopSentinel": "@@END_PATCH@@",
  "reviewStopSentinel": "@@END_REVIEW@@",
  "blueprintModeEnabled": true,
  "blueprintAutoForComplexTasks": true,
  "blueprintUseFastPath": true,
  "blueprintCandidateCount": 3,
  "blueprintShowInternalPlanSummary": true,
  "blueprintRequireApproval": "high_risk_only",
  "blueprintMaxPackets": 8,
  "blueprintMaxCallsPerPacket": 1,
  "blueprintMaxDebugRounds": 3,
  "blueprintReplanAfterFailedDebug": true,
  "blueprintMemoryEnabled": true,
  "blueprintOfficialDocsSearchEnabled": false,
  "blueprintDocsProvider": "local",
  "searxngBaseUrl": "",
  "blueprintMaxDocsFacts": 5,
  "blueprintFetchDocsPages": false,
  "benchmarkEnabled": true,
  "benchmarkDefaultTaskLimit": 10,
  "commitletModeEnabled": true,
  "commitletAutoForCodeTasks": true,
  "commitletCandidateSamples": 1,
  "experienceStoreEnabled": true,
  "cheatSheetEnabled": true,
  "postEditImportGateEnabled": true,
  "rollbackRequired": true,
  "maxFilesTouchedDefault": 3,
  "maxDiffLinesDefault": 180,
  "maxModelCallsPerCommitlet": 1,
  "repairAttemptsPerCommitlet": 1,
  "healthScoreThreshold": 75,
  "hardRejectHealthThreshold": 50,
  "allowDependencyEditsByDefault": false,
  "allowLockfileEditsByDefault": false,
  "allowTestEditsByDefault": false,
  "finalReviewEnabled": true,
  "autoCleanupLowRiskHealthIssues": true,
  "telemetryEnabled": true,
  "telemetryLocalOnly": true,
  "retrievalMaxPlanningFacts": 3,
  "retrievalMaxFeedbackFacts": 5
}
```

Config is optional. Defaults should be enough for normal use.

## Autonomous Blueprint

Autonomous Blueprint is an internal planning layer for complex code tasks.
Autopilot creates a preview, generates three candidates (minimal,
architecture-clean, and test/safety-first), scores them, selects one, decomposes
it into sequential packets, and asks Pi to execute those packets with narrow
context. Final review runs automatically through the blueprint tooling.

Tiny edits use the fast path and can escalate to Blueprint after failure. Bug
and test-failure requests are steered to reproduce and gather evidence before
editing, then run the same commitlet flow. High-risk actions such as dependency or lockfile
changes, file deletion, broad refactors, or unclear architecture changes require
user approval.

Official docs scouting is local-only by default. If enabled, it uses official
allowlisted domains or a configured SearXNG instance with site filters; broad
web search, blogs, forums, Reddit, and StackOverflow are not used by default.

## Reliability Kernel

Reliability Kernel is on by default for local-model safety. It keeps Cheater as
a Pi wrapper while adding deterministic guardrails around Pi:

* Autopilot routes normal messages automatically.
* Every code-changing task uses at least single-commitlet discipline unless
  disabled.
* Tiny tasks become one commitlet; complex tasks become commitlet chains.
* Blueprint can still create previews/candidates/packets, but those packets are
  converted into commitlets before execution.
* Each commitlet has a tiny spec/oracle, rollback point, allowed/forbidden file
  scope, focused verification, diff budget, health budget, and final review.
* Each file change gets its own fresh worker by default. If another file is
  needed, the worker must stop and hand off so Cheater can summon a new worker
  with fresh context.
* Each file-change packet includes only the goal, current task, one target file, compact
  context, up to three previous-state bullets, acceptance criteria, and a stop
  sentinel.
* Loop Governor detects repeated text, repeated file reads, repeated failed
  commands, repeated searches, repeated patches, and no-progress inspection.
* Diff Guard blocks forbidden files, dependency/lockfile edits, generated
  artifacts, test edits without permission, broad diffs, and unrelated churn.
* Patch Health Score uses deterministic heuristics for diff size, duplication,
  complexity, large functions, TODO/HACK/FIXME, broad catches, and assertion
  changes.
* Low-risk final-review health blockers create a scoped cleanup commitlet
  automatically when `autoCleanupLowRiskHealthIssues` is enabled.
* Test Quality Auditor catches removed assertions, skipped tests, weak/mock-only
  tests, and unexplained golden-output changes.
* Edit Rescue (ported from Cline's replace_in_file matchers): when an exact-match
  edit fails, the harness finds the line-trimmed or block-anchor near-match and
  hands back the exact on-disk text to retry with - the #1 small-model edit
  failure becomes a one-step recovery. cheater_line_edit's staleness check is
  whitespace-tolerant for the same reason.
* Focus Chain (ported from Cline's task_progress): a harness-derived checklist of
  the whole plan ([x]/[>]/[ ]/[!] per commitlet) is re-shown at every commitlet
  handoff, after compaction, and in finish-gate nudges - so a small model never
  finishes item 2 of 6 and declares victory.
* Identical-call guard (ported from Cline): the exact same tool with the exact
  same canonicalized args warns in-band on the 3rd consecutive call and blocks on
  the 6th; hard stops use preserved-state semantics ("plan, rollbacks, and ledger
  are intact - send a new instruction to resume").
* Project rules: `.cheater/rules.md` or `.clinerules` (bounded) ride into every
  session's environment block.
* Stray-file hygiene: files a failed resample attempt creates OUTSIDE its allowed
  scope are removed between attempts and before applying the winner (git repos).
* Import Gate checks every successful edit's imports (repo files resolve,
  named symbols are actually exported, npm packages are installed) and
  reports problems in-band on the edit's own result - the single most common
  small-model failure (a hallucinated import) is caught immediately instead
  of surfacing three tool calls later as a failed test. Disable with
  `postEditImportGateEnabled: false`.
* A lightweight Repo Constraint Graph tracks symbols/imports/exports,
  command/tool registrations, config keys, tests, and small queryable facts,
  and now also targets a real file for a generic bug-fix/feature request by
  matching goal terms against actual repo symbols - not a guessed filename.
* Impact propagation derives extra checks for signature/import/config/command/
  tool/dependency/test/doc changes.
* Planning and feedback retrieval are bounded and use the existing disagreement
  gate so memories/docs cannot override local source or tests.
* Docs facts are local/official-only and online search is disabled by default.
* Final review and local-only telemetry run after commitlet chains.

### Verified resampling (local-native best-of-N)

API-oriented harnesses are sample-frugal because tokens cost money. Local
tokens are nearly free, and a small model's pass@N on a bounded one-file
commitlet approaches a frontier model's pass@1 - if something deterministic
picks the winner. With `"commitletCandidateSamples": 3`, each real-worker
commitlet runs up to three **independent** fresh workers from the clean
rollback snapshot. The harness scores every candidate in code (diff guard,
patch health, focused verification), accepts the first verified pass, and
otherwise leaves the best-ranked candidate applied so the bounded repair
starts from the strongest attempt. Attempts are independent on purpose:
small models are poisoned by failure context, so fresh resamples beat
feedback loops. Resample attempts after the first also carry a distinct
approach stance (smallest fix / root-cause fix / clean rewrite) so repeated
samples are not just re-rolls of the same prompt. The default of 1 keeps
single-attempt behavior.

Real fresh workers (their own isolated context per file change) turn on
automatically the moment one has actually spawned successfully in the current
process - no config needed. This is evidence-based, not a guess: Cheater does
not infer "a model backend is probably configured" from disk state (that
produced false positives in offline/test contexts); it only upgrades after a
real `createAgentSession` call has succeeded. Set `commitletFreshWorkerDefault`
explicitly (`true`/`false`) to override this in either direction.

### Experience store (bug memory that writes itself)

Static bug corpora hold someone else's bugs, and the model has to remember to
search them. The experience store fixes both: cards are written **only by the
harness, only on a verified fail->pass transition** (a repair commitlet passes
the verification its original failed, or auto-verify passes after an observed
failure). Each card keys a normalized failure fingerprint (paths, line
numbers, and literals stripped) to the diff that verifiably fixed it. Recall
happens through the Cheat Layer below - no tool call, no recall skill
required. Local-only JSONL under `.cheater/experience/`; disable with
`"experienceStoreEnabled": false`.

### The Cheat Layer (harness-owned evidence injection)

The model never decides when to search, how to search, what to trust, or
where the result goes. When a commitlet fails verification (or auto-verify
fails), the harness:

1. **classifies** the failure deterministically (import error, missing
   dependency, library API error, syntax, assertion, runtime) and extracts
   the package/symbol it names;
2. **retrieves** compact evidence through one cascade, in trust order:
   the verified experience store (high confidence - proven fail->pass in
   this repo), the **installed-API oracle** (high - when the failure names
   a library symbol, the harness reads the ACTUAL signatures/exports of
   the locally installed version from node_modules type declarations or a
   bounded `python -c "import inspect, ..."` probe: "installed
   fakepkg@2.3.4 has no sendGreeting; the real exports are greet, Client,
   hello" - an environment fact, fully offline), the compacted bug corpus
   (medium - someone else's verified bugs, analogies only, gated by a
   relevance check so a lexical search can never inject noise), the target
   repo's own docs (low), and official docs/web **only when online search
   is explicitly enabled**;
3. **compresses** the result into at most 3 tiny evidence cards (observed
   cause hypothesis, suggested fix pattern, source, confidence, exact
   verification command when known) - the whole sheet is capped at ~1.3KB;
4. **injects** the rendered sheet in-band: into the repair commitlet's
   `observedFailure` (which every repair worker and every resampling
   attempt receives inside its packet), into the grade message the
   orchestrating session reads, and into auto-verify failure notices.

An unclassifiable failure with no verified experience match produces **no
sheet at all** - noisy evidence is worse for a small model than none. Every
card is explicitly framed as a hypothesis: the sheet's own footer says the
verifier decides, and nothing in the Cheat Layer can satisfy the finish
gate. A huge unindexed bug corpus is skipped rather than stalling a grade on
an index build. Disable with `"cheatSheetEnabled": false`.

Offline benchmark commands:

```powershell
cheater bench reliability run B 10
cheater bench reliability report
cheater bench reliability compare
```

Benchmark variants:

| Variant | Meaning |
| --- | --- |
| A | baseline behavior |
| B | fresh-call + Loop Governor + sentinels |
| C | B + commitlet/rollback/diff guard |
| D | C + spec forge + focused verification + test audit |
| E | D + repo constraint graph + impact propagation + retrieval gate |

Blueprint eval summaries also report local-worker readiness fields:
`localReady`, `promptFit`, `oneFile`, `handoff`, and `packetChars`. These are
not solve-rate claims. They check whether the actual fresh-call packet for a
Qwen/9B-class worker is bounded, single-file scoped, verification-backed, and
forced to end with a handoff/sentinel.

## Compacted Bug Memories

Cheater uses the LLM-compacted corpus at `data/cards/compacted.jsonl` through
the Pi tool `cheater_bug_memory_search`.

The first search builds a sharded on-disk lexical index under:

```text
.cheater/cache/bug-memory-index/
```

After that, searches read only the shards for the query terms and fetch only the
top matching cards. The full 119 MB corpus is not loaded into RAM.

Override the corpus path with:

```powershell
$env:CHEATER_BUG_MEMORY_PATH = "C:\path\to\compacted.jsonl"
```

## Development

Python wrapper checks:

```powershell
python -m cheater --help
python -m cheater --doctor
python -m cheater --print-pi-command
pytest tests/test_cli_commands.py -q
```

TypeScript package checks:

```powershell
cd cheater-pi
npm install
npm run build
npm test
```

See [docs/cheater_pi.md](docs/cheater_pi.md) for implementation details,
[docs/gym.md](docs/gym.md) for the local benchmark, and
[docs/migration.md](docs/migration.md) for what changed from the old
Python agent/TUI architecture.
