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

Autopilot decides whether Pi should answer directly, use a fast path, use
Mission Control, or create an internal Autonomous Blueprint. Users do not need
to type `/blueprint` before normal work.

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

Inside the Pi TUI, Cheater adds:

| Command | Purpose |
| --- | --- |
| `/cheater` | Show Cheater status and command help |
| `/autopilot-status` | Show the latest automatic routing decision |
| `/blueprint-show` | Inspect the current internal blueprint |
| `/blueprint-review` | Run final blueprint review manually |
| `/blueprint-cancel` | Cancel the current blueprint run |
| `/blueprint-force <goal>` | Force blueprint mode manually |
| `/blueprint-docs <query>` | Search configured local/official docs facts |
| `/blueprint-memory` | Show blueprint planning memories |
| `/reliability-status` | Show Reliability Mode status |
| `/loop-report` | Show Loop Governor diagnostics |
| `/model-profile` | Show local-model packet settings |
| `/commitlet-status` | Show Reliability Kernel commitlet status |
| `/commitlet-plan` | Show the active commitlet chain |
| `/commitlet-revert` | Revert current or named commitlet if safe |
| `/commitlet-verify` | Run focused verification for a commitlet |
| `/commitlet-health` | Show latest health/final-review result |
| `/rollback-status` | Show rollback snapshots; pass `cleanup` to remove old snapshots |
| `/health-report` | Show latest Reliability Kernel health report |
| `/constraint-graph` | Show compact repo constraint graph facts |
| `/bench-report` | Show latest local reliability benchmark report |
| `/mission` | Start a Cheater Mission Control flow |
| `/fix` | Shortcut: start a bug_fix mission |
| `/orient` | Show or refresh project orientation |
| `/repro` | Run the repro gate |
| `/evidence` | Gather an evidence packet |
| `/playbook` | Show the playbook for the active mission |
| `/verify` | Run the oracle stack |
| `/learn` | Propose or persist learning |
| `/delta-bench` | Show Cheater delta-benchmark report |
| `/gym` | Cheater Gym help and status |
| `/gym-list` | List Cheater Gym tasks |
| `/gym-run <id>` | Prepare a Gym workspace and prompt |
| `/gym-run-suite` | Run a small Gym suite |
| `/gym-report` | Show the latest Gym report |
| `/gym-delta <id>` | Show Cheater vs vanilla delta |
| `/gym-learn` | Show learning suggestions from past runs |
| `/gym-clean` | Remove Gym workspaces and reports |
| `/test` | Infer or run a focused test command |
| `/map` | Ask Pi for a compact repo overview |
| `/bug-memory` | Search compacted solved-bug memories directly |
| `/remember` | Save a project note under `.cheater/memory` |
| `/skills` | List Cheater skills loaded by the package |
| `/traces` / `/history` | Show recent session/history guidance |
| `/settings` | Show Cheater wrapper/package settings |
| `/doctor` | Run in-session Cheater diagnostics |

Debug-only commands remain available for Cheater development and incident
inspection: `/blueprint-candidates`, `/blueprint-step`, `/blueprint-debug`,
`/blueprint-quality-repair`, `/commitlet-next`, `/commitlet-finalize`, and `/commitlet-debug`. Normal coding
requests should go through Autopilot instead of manual packet or commitlet
driving.

Cheater also registers small helper tools:

| Tool | Purpose |
| --- | --- |
| `cheater_project_brief` | Compact repo status and top-level shape |
| `cheater_focus_test` | Suggest a narrow test command |
| `cheater_diff_safety_check` | Flag risky diff categories |
| `cheater_memory_search` | Search Cheater project notes |
| `cheater_bug_memory_search` | Search compacted solved-bug memories with a low-RAM on-disk index |
| `cheater_skill_search` | List packaged Cheater skills |
| `cheater_autopilot_route` | Route normal requests before code changes |
| `cheater_blueprint_create` | Create an internal blueprint plan |
| `cheater_blueprint_next_packet` | Return the next sequential packet prompt |
| `cheater_blueprint_review` | Run final blueprint review |
| `cheater_blueprint_docs` | Gather local/official docs facts |
| `cheater_commitlet_plan` | Create the Reliability Kernel commitlet chain |
| `cheater_commitlet_next` | Prepare rollback and fresh-call prompt for the next commitlet |
| `cheater_commitlet_guard` | Run diff guard, patch health, and test audit |
| `cheater_commitlet_verify` | Run focused verification and create one repair commitlet on failure |
| `cheater_commitlet_finalize` | Run final commitlet review and local telemetry |
| `cheater_commitlet_revert` | Restore allowed-file snapshots for a commitlet |
| `cheater_rollback_status` | Inspect/cleanup commitlet rollback snapshots |
| `cheater_health_report` | Show latest patch-health/final-review report |
| `cheater_constraint_graph` | Build compact graph facts for active files |
| `cheater_bench_report` | Show latest local reliability benchmark report |

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
and test-failure requests route to Mission Control first. High-risk actions
such as dependency or lockfile changes, file deletion, broad refactors, or
unclear architecture changes require user approval.

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
* A lightweight Repo Constraint Graph tracks symbols/imports/exports,
  command/tool registrations, config keys, tests, and small queryable facts.
* Impact propagation derives extra checks for signature/import/config/command/
  tool/dependency/test/doc changes.
* Planning and feedback retrieval are bounded and use the existing disagreement
  gate so memories/docs cannot override local source or tests.
* Docs facts are local/official-only and online search is disabled by default.
* Final review and local-only telemetry run after commitlet chains.

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
