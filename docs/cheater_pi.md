# Cheater Pi Distribution

Cheater is a Pi wrapper and package.

Running `cheater` builds a Pi command that preloads:

- `cheater-pi/src/extension.ts`
- `cheater-pi/prompts/cheater.md`
- `cheater-pi/skills/`
- `cheater-pi/themes/cheater.json`

The wrapper uses Pi's normal resource flags:

- `--extension`
- `--skill`
- `--prompt-template`
- `--append-system-prompt`
- `--theme`

The TypeScript package also exposes an npm binary named `cheater`, so Windows
PowerShell can run the same wrapper after `npm link`.

## Runtime Contract

`cheater` must:

- launch Pi's TUI, not a standalone Cheater TUI
- load Cheater customization automatically
- keep Pi responsible for code reading, editing, shell tools, sessions, context,
  slash commands, and the agent loop
- handle missing Pi with a clear message
- preserve paths with spaces

## Extension Surface

Design rule: the model proposes intent; the harness owns state, permissions,
execution, context shape, and completion truth. The model-facing tool surface is
deliberately tiny, and **every registered tool appears in a tool mask** - there
is no hidden inventory that could confuse a small model if masking fails.

Model-facing tools (all of them):

- one-flow tools: `cheater_reliability_start`, `cheater_commitlet_next`,
  `cheater_commitlet_revert`, `cheater_finish_gate`, `cheater_verification_run`,
  `cheater_ledger_status`, `cheater_rollback_status`
- editing/lookup: `cheater_line_edit`, `cheater_memory_search`,
  `cheater_bug_memory_search`, `cheater_project_brief`

Autopilot routing itself is not a model-facing tool - it is injected
automatically by the extension's `input` hook on every normal message.

User commands: `/cheater`, `/autopilot-status`, `/reliability-status`,
`/commitlet-status`, `/commitlet-plan`, `/commitlet-health`,
`/commitlet-revert`, `/rollback-status`, `/constraint-graph`, `/bench-report`,
`/model-profile`, `/blueprint-show`, `/blueprint-cancel`, `/blueprint-docs`,
`/blueprint-memory`, `/gym*`, `/test`, `/map`, `/bug-memory`, `/remember`,
`/skills`, `/traces`, `/settings`, `/doctor`. Debug-only: `/commitlet-next`,
`/commitlet-debug`, `/autopilot-route`, `/autopilot-run`. Status commands render
directly from harness state - no command sends the model off to call a tool.

## Autopilot and Autonomous Blueprint

Normal code requests are routed automatically. A user can type `add a /hello
command` or `refactor the memory search`; Cheater routes before editing.

Routing modes:

- `answer_only`: explanation/orientation only, no edits.
- `vanilla_pi`: tiny fast-path edits with focused verification.
- `careful_repro`: bug fixes and test failures - reproduce first, then the flow.
- `blueprint_orchestrator`: complex feature/refactor/tooling/migration work.

Every code mode runs the SAME one flow: `cheater_reliability_start` plans
(using the internal Autonomous Blueprint engine for complex tasks), the model or
a fresh isolated worker edits the allowed files, `cheater_commitlet_next` grades
in code (diff guard, patch health, test audit, focused verification),
`cheater_verification_run` collects evidence, and `cheater_finish_gate` decides
completion from the ledgers - not from model prose.

Blueprint is an internal planning engine, not a model-driven flow: it creates a
compact preview, generates three candidates, scores them, decomposes the winner
into work packets, and feeds the commitlet plan. It has no model-facing tools.
For version-sensitive or exact-error tasks it can require official docs
evidence before dispatch (`blueprintOfficialDocsSearchEnabled`).

Durable run state (contract, digest, ledgers, capsules, phases, guards,
telemetry) is documented in [RUNSTATE.md](RUNSTATE.md).

## Cheater Gym

Cheater ships a local benchmark (`cheater gym ...`) with small Python + JS/TS
tasks and a scoring/learning layer. See [docs/gym.md](gym.md).

## Configuration

`.cheater/config.json` (or `~/.config/cheater/config.json`); everything has a
sensible default. Frequently used keys:

```
{
  "autopilotEnabled": true,
  "autopilotRouteAllCodeTasks": true,
  "blueprintModeEnabled": true,
  "blueprintOfficialDocsSearchEnabled": false,
  "commitletFreshWorkerDefault": false,
  "commitletCandidateSamples": 1,
  "experienceStoreEnabled": true,
  "cheatSheetEnabled": true,
  "runStateEnabled": true,
  "requireApprovalForHighRisk": false
}
```

## Compacted Bug Memory

`cheater_bug_memory_search` searches `data/cards/compacted.jsonl`, or the file
named by `CHEATER_BUG_MEMORY_PATH`.

Search is designed for:

- high relevance: weighted terms from bug type, symptom, root cause, fix
  pattern, key files, search keywords, and test signal
- low memory use: the full JSONL corpus is streamed into an on-disk index
- speed: subsequent searches read only query-term shards and fetch top cards by
  offset
