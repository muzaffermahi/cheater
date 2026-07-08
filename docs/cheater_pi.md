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

- one-flow tools: `cheater_run` (deterministic closed loop over the whole
  chain), `cheater_reliability_start`, `cheater_commitlet_next`,
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
`/blueprint-memory`, `/test`, `/map`, `/remember`,
`/skills`, `/sidecar`, `/traces`, `/settings`, `/doctor`. Debug-only: `/commitlet-next`,
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

Preferred entry: `cheater_run` executes the whole chain deterministically when
real fresh workers are available (honest simulated-handoff degradation
otherwise). Every code mode runs the SAME one flow: `cheater_reliability_start` plans
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

## Sidecar (a parallel CPU clerk)

The sidecar is a small 2-4B "clerk" model that offloads bounded, fuzzy chores from the main model
and works *ahead* of it. Doctrine (never violated): **code decides truth, the small model
organizes, the big model creates.** The sidecar is never an authority - every job has a
deterministic fallback and consumers never await it, so a slow, wrong, or absent sidecar only ever
falls back to exactly what the harness did before it existed.

Best on a single GPU: run the main model on the GPU and the sidecar as a **separate CPU model** on
its own endpoint. The two never contend, so the clerk runs truly in parallel (`concurrent` mode)
and prepares each upcoming worker's context while the GPU model writes the current file - no brakes.

Jobs (each with a deterministic floor):

- `prepare_context` (flagship, parallel): compress a commitlet's repo facts, prioritize its own
  candidate files, and add short orientation notes - prepared ahead so the next worker's context is
  ready with no wait. Dispatched for upcoming commitlets while a worker runs (concurrent only) and
  in the GPU-free grade window (both modes).
- `distill_failure`: compress a verification failure into a tiny cause/hint/don't-repeat note for
  the repair worker.
- `route_goal`: a second opinion that refines only a low-confidence deterministic route.
- `review_diff`: an advisory "second pair of eyes" on a passing diff (never blocks a gate).

Set-up (LM Studio or llama.cpp, CPU-only so it never steals the GPU):

```
# LM Studio: load e.g. qwen2.5-coder-3b-instruct, set GPU layers = 0, start the local server, then:
/sidecar setup <provider> http://localhost:1234/v1 qwen2.5-coder-3b-instruct
/sidecar doctor        # confirm it reports ONLINE
# llama.cpp equivalent: llama-server -m qwen2.5-coder-3b-q4.gguf -ngl 0 --port 8080
```

A configured endpoint auto-selects `concurrent` mode and a longer per-call timeout (CPU is slower).
The self-healing latch re-probes after a transient failure, so a CPU endpoint that is still loading
recovers on its own instead of blacking out for the whole session.

Commands: `/sidecar [status|doctor|setup <provider> <url> <model>|model <id>|endpoint <url>|provider
<name>|mode <gap|concurrent|off>|timeout <ms>|on|off]`. `status` shows the live latch
(ONLINE/OFFLINE), the per-job tally, and learned prefetch hit-rates; `doctor` actively probes and
names the exact fix if it is dark.

## Main LLM Call Governor & TTFT discipline

Local models are slow to first token (TTFT) once the prompt grows, so the rule is: **call the big
model only when being dumb would actually hurt.** Everything clerical, compressive, and
non-authoritative goes to deterministic code or the sidecar; the big model is reserved for blueprint
planning (deterministic here anyway), writing/repairing code, and strategic bug reasoning.

- **Main LLM Call Governor** (`runtime/mainCallGovernor.ts`, off by default via
  `mainCallGovernorEnabled`): classifies each intended call into a role, states the policy (main /
  sidecar / deterministic and whether it may escalate), and records main calls made vs avoided.
  Clerical roles (route, failure_distill, capsule_compress, compaction_summary, receipt_summary,
  tool_error_normalize) never escalate to the big model unless added to `mainFallbackAllowedRoles`.
  With the governor on, the completion receipt gains a budget section:

  ```
  main model calls: 3 total (~4200 est tokens)
    code_worker: 2
    repair_worker: 1
    avoided by sidecar/deterministic: 5
      route: 1
      failure_distill: 2
      capsule_compress: 2
  sidecar: attempted 4, succeeded 3, fallback 1 (roles: failure_distill, capsule_compress)
  prompt shape: ~1800 tok, 12% stable prefix, NOT cache-friendly
  provider/perf: stateful_chat available, response_id used, /v1/chat/completions treated stateless
    TTFT 0.320s, input 1200 tok, 22.0 tok/s
    cache benefit measured: small
  ```

- **Prompt shape discipline** (`runtime/promptShape.ts`): measures whether a worker prompt is
  cache-friendly - fixed rules as a leading stable prefix, dynamic content last, no duplicated
  blocks. It never rewrites a prompt; it reports, so bloat is visible in the receipt.

- **Tool-error normalization** (`runtime/toolErrorNormalize.ts`): deterministic pattern-matching
  turns raw command/stderr sludge into a bounded `{kind, summary, hint}` - the big model never
  receives pages of stderr.

- **LM Studio stateful/telemetry probe** (`providers/lmStudioStateful.ts`, command
  `/provider-probe [bench]`): LM Studio's OpenAI-compatible `/v1/chat/completions` is STATELESS
  (every call resends the whole conversation - the TTFT tax), while its native `/api/v1/chat` is
  stateful (`response_id` / `previous_response_id`) and reports TTFT/token stats. The probe is a
  standalone fetch against `lmStudioBaseUrl` (or `sidecarBaseUrl`); it does NOT rewire Pi's provider
  and never claims KV-cache reuse - `cache benefit measured` comes only from a fixed-prefix
  micro-benchmark and is `unknown` unless measured.

Keeping the clerk busy + cutting prefill (for create-heavy / from-scratch builds, where the sidecar
used to go idle because a NEW file has no repo facts to compress):

- **Contract cards** (`prepare_context`): the clerk now also ORGANIZES a commitlet's already-decided
  acceptance criteria + must-hold + the sibling files this build touches into a worker-ready build
  card (what this file must export, how it fits the siblings, the pattern to match). This is
  organizing, never planning; the deterministic floor carries the contract as orientation even when
  the clerk is unavailable/slow, so a new-file worker always gets the card.
- **Prefetch horizon + pool** (`sidecarPrefetchHorizon`, default 3; `sidecarMaxConcurrency`, default 1
  and only >1 with a separate CPU endpoint): how many upcoming commitlets the clerk preps ahead and
  how many jobs run at once, so it always has a queue while the GPU model writes.
- **Latency telemetry**: `/sidecar status` and the receipt show `~<ms>/job`. A reasoning clerk is slow
  (its prep often won't land in time → deterministic floor); a fast non-reasoning 2-4B lands and helps.
- **Lean worker prompt** (`leanWorkerPromptEnabled`): caps the growing/fixed capsule fields (rulePack,
  operatingRules, workspaceDigest, mutationSummary, priorWorkerReports, snippets) harder to shrink the
  main model's per-commitlet prefill. Drops nothing load-bearing; off = byte-identical worker prompts.

Config (all optional, off/conservative by default): `mainCallGovernorEnabled`, `mainAllowedRoles`,
`mainFallbackAllowedRoles`, `sidecarPreferredRoles`, `sidecarKeepAliveEnabled`,
`sidecarForceWarmOnRunStart`, `sidecarMinUsefulCallsPerRun`, `lmStudioBaseUrl`, `providerProbeEnabled`,
`providerProbeBenchmark`, `leanWorkerPromptEnabled`, `sidecarPrefetchHorizon`, `sidecarMaxConcurrency`.

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
  "requireApprovalForHighRisk": false,
  "sidecarModel": null,
  "sidecarProvider": null,
  "sidecarBaseUrl": null,
  "sidecarParallelism": "gap"
}
```

Sidecar keys (all optional; see the Sidecar section): `sidecarEnabled`, `sidecarModel`,
`sidecarProvider`, `sidecarBaseUrl`, `sidecarParallelism` (`gap` | `concurrent` | `off`),
`sidecarTimeoutMs`, `sidecarMaxOutputTokens`, `sidecarAllowMainModel`. Setting `sidecarModel`
auto-enables the sidecar; setting `sidecarBaseUrl` auto-selects `concurrent` mode and a longer
timeout. Prefer the `/sidecar` command, which persists these for you.

## Compacted Bug Memory

`cheater_bug_memory_search` searches `data/cards/compacted.jsonl`, or the file
named by `CHEATER_BUG_MEMORY_PATH`.

Search is designed for:

- high relevance: weighted terms from bug type, symptom, root cause, fix
  pattern, key files, search keywords, and test signal
- low memory use: the full JSONL corpus is streamed into an on-disk index
- speed: subsequent searches read only query-term shards and fetch top cards by
  offset
