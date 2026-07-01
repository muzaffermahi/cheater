# Cheater Pi Distribution

Cheater is now a Pi wrapper and package.

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

- launch Pi's TUI, not the old Python TUI
- load Cheater customization automatically
- keep Pi responsible for code reading, editing, shell tools, sessions, context,
  slash commands, and the agent loop
- handle missing Pi with a clear message
- preserve paths with spaces

## Extension Surface

The Cheater extension adds:

- startup Cheater status widget
- Cheater system-prompt guidance (with Mission Control)
- automatic Autopilot routing for normal user requests
- Autonomous Blueprint tools for internal multi-step planning and review
- `/cheater`, `/autopilot-status`, `/blueprint-show`, `/blueprint-review`,
  `/blueprint-cancel`, `/blueprint-force`, `/blueprint-docs`,
  `/blueprint-memory`, `/mission`, `/mission-status`, `/mission-cancel`, `/mission-save`,
  `/fix`, `/orient`, `/orientation`, `/repro`, `/evidence`, `/playbook`,
  `/verify`, `/learn`, `/delta-bench`, `/gym`, `/gym-list`, `/gym-run`,
  `/gym-run-suite`, `/gym-report`, `/gym-delta`, `/gym-learn`, `/gym-clean`,
  `/test`, `/map`, `/remember`, `/skills`, `/traces`, `/history`, `/settings`,
  and `/doctor`
- debug-only inspection commands: `/blueprint-candidates`, `/blueprint-step`,
  `/blueprint-debug`, `/commitlet-next`, `/commitlet-finalize`, and
  `/commitlet-debug`
- helper tools for project briefs, focused tests, diff safety, memory search,
  compacted bug-memory search, and skill search
- mission tools: `cheater_mission_classify`, `cheater_mission_start`,
  `cheater_mission_status`, `cheater_mission_cancel`, `cheater_orientation_scan`,
  `cheater_orientation_show`, `cheater_orientation_update`,
  `cheater_repro_gate`, `cheater_evidence_packet`, `cheater_playbook_show`,
  `cheater_oracle_stack`, `cheater_mission_learn`, `cheater_delta_bench`
- autopilot/blueprint tools: `cheater_autopilot_route`,
  `cheater_blueprint_create`, `cheater_blueprint_next_packet`,
  `cheater_blueprint_review`, `cheater_blueprint_candidates`,
  `cheater_blueprint_docs`

These additions are intentionally small. They steer Pi rather than replacing it.

## Autopilot and Autonomous Blueprint

Normal code requests are routed automatically. A user can type `add a /hello
command` or `refactor the memory search`; Cheater should route before editing
without requiring `/blueprint`.

Routing modes:

- `answer_only`: explanation/orientation only, no edits.
- `vanilla_pi`: tiny fast-path edits with focused verification.
- `mission_control`: bug fixes and test failures with repro/evidence flow.
- `blueprint_orchestrator`: complex feature/refactor/tooling/migration work.

Blueprint mode creates a compact preview, generates three candidates, scores
them for completeness, feasibility, edge cases, efficiency, and repo fit, then
selects one internally. It decomposes the selected plan into sequential work
packets and hands those packet prompts to Pi. Cheater does not implement a
standalone agent loop, shell runner, code editor, or TUI.

For version-sensitive, migration, exact-error, or user-requested web-search
tasks, Blueprint records `evidenceRequired=true` in the artifact. If no
official docs or web evidence is attached, the quality gate blocks packet
dispatch instead of letting a local model guess at external APIs.

When the quality gate finds blockers or weak plan structure, it also emits
`Remediate:` actions in the Blueprint artifact and final review result. These
actions are intentionally concrete, such as adding packet-local repo facts,
attaching official docs evidence, splitting oversized packets, or adding a
focused verification command. The debug command `/blueprint-quality-repair`
renders the same actions as a planner-only repair draft.

Debug commands such as `/blueprint-show`, `/blueprint-candidates`, and
`/blueprint-step` exist for inspection and override only. They are not the
primary workflow.

## Cheater Gym

Cheater ships a local benchmark (`cheater gym ...`) with 25 small
tasks (Python + JS/TS) and a scoring/learning layer. See
[docs/gym.md](gym.md) for the full design.

## Mission Control

Mission Control is a Pi-native harness layer that turns vague coding requests
into disciplined workflows. It is enabled by default and configured via
`.cheater/config.json` (or `~/.config/cheater/config.json`):

```
{
  "missionControlEnabled": true,
  "reproRequiredBeforePatch": true,
  "allowNoOpSuccess": true,
  "onlineEvidenceEnabled": false,
  "offlineStackOverflowEnabled": false,
  "autoSaveLearning": false,
  "oracleRunBroadTests": "ask",
  "maxEvidenceItems": 5,
  "maxMissionRawLogChars": 12000,
  "autopilotEnabled": true,
  "autopilotRouteAllCodeTasks": true,
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
  "blueprintFetchDocsPages": false
}
```

Mission Control's internal flow for bug/test tasks:

1. `/mission <goal>` or `/fix <failing test>` - classify the task
2. `/orient` - confirm project facts
3. `/repro <focused command>` - reproduce the failure (or prove no-op)
4. `/evidence` - consult bug memory + local docs
5. patch the smallest likely cause
6. `/verify` - run the oracle stack (focused/typecheck/lint/broad)
7. `/learn` to propose saving, `/mission-save` to persist
8. `/delta-bench` to record metrics

## Compacted Bug Memory

`cheater_bug_memory_search` searches `data/cards/compacted.jsonl`, or the file
named by `CHEATER_BUG_MEMORY_PATH`.

Search is designed for:

- high relevance: weighted terms from bug type, symptom, root cause, fix
  pattern, key files, search keywords, and test signal
- low memory use: the full JSONL corpus is streamed into an on-disk index
- speed: subsequent searches read only query-term shards and fetch top cards by
  offset
