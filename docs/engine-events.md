# Engine events — the renderer contract

The single event model lives in `cheater-pi/src/core/events.ts` (`EVENT_SCHEMA_VERSION`, currently 1).
Every event is persisted per conversation, then broadcast; the desktop shell receives them as framed
JSON over the engine pipe (`eventFromKitten` moves the payload under `payload`). Renderers MUST
ignore unknown `type`s and tolerate absent optional fields — new types and optional fields do not
bump the schema version.

## Run lifecycle

| Event | When | Renderer notes |
|---|---|---|
| `user.message` | user submitted | |
| `task.compiled` | before routing | contract summary (mode/family/goal/counts/warnings); full IR via the `task.compiled-get` IPC verb (lazy — `trace`/`rendered` can be large) |
| `task.clarification_requested` | compiler asked instead of guessing | render as a callout, not plain prose |
| `plan.updated` | plan created/changed | REPLACE the whole step list; `source: "compiled-contract"` = advisory outline (statuses stay `planned`), `"task-graph"` = real DAG with live statuses |
| `route.selected` | before run.started | `lane`, `reasons[]`, `k`, optional `hardness` (number), optional `effort` |
| `run.started` | runner begins | |
| `run.status` | `running` / `waiting_approval` / `cancelling` | `waiting_approval` fires before `tool.approval_required`; `running` fires again after resolution |
| `run.completed` | terminal | `finished` (work produced) vs `verified` (execution proof) — never collapse these; also `summary`, `wallMs`, `usage` |
| `run.failed` / `run.cancelled` / `run.interrupted` | terminal | |
| `receipt.finalized` | after run.completed | the audit trail lines |

## Live activity (new in the desktop-king pass)

| Event | When | Renderer notes |
|---|---|---|
| `tool.started` | before a gated-and-approved tool executes | `callId` pairs with `tool.completed`; `target` = path/command/pattern. Emitted on direct/reliable lanes only (parallel candidates suppress it). Skip during history replay — only `tool.completed` replays |
| `tool.output` | bash streams (≤8 chunks × ≤2 KB, coalesced) | progressive preview only; `tool.completed.output` is authoritative |
| `tool.completed` | after execution | real `durationMs`; `ok:false` should surface the salient error line, never raw JSON |
| `step.started` / `step.completed` | task-graph node state change | `stepId` matches `plan.updated.steps[].id`; failure/blockage folds into `step.completed.status` |
| `verification.started` | finish gate / ascent verifier begins | `what` says which receipt is being sought |
| `verification.evidence` | each executed check | `check`, `passed`, `durationMs`; ascent prefixes `#<candidate>` |
| `verification.passed` | receipt obtained | |
| `verification.failed` | gate rejection / no eligible candidate | single-sourced (a finish-gate rejection emits exactly one) |
| `repair.started` | ascent begins a repair round | `round`, `seed` (the concrete failure being repaired) |
| `candidate.*` | bon/ascent per-candidate cards | |

## Runtime state (NOT persisted — broadcast only)

`runtime.state` frames have no `conversationId` and never appear in history. Payload
(`RuntimeStatePayload` in `desktopEngine.ts`):

```
{ phase: starting|probing|ready|failed|stopped|external,
  endpoint, model, sidecarModel?, ctxTokens?, pid?, external?, stderrTail?, ts }
```

Emitted on change from launch/stop/ensure/startup-recovery and from a 15s health watchdog
(2-strike debounce; paused during launches). Late joiners seed from the `runtime.status` response's
`state` field. `ctxTokens` is the server's actual context window for this launch — display this,
not the configured wish.

## Sidecar / advisory

`sidecar.postflight`, `sidecar.failure`, `run.step_critique`, `workspace.verification` — advisory,
never change a run's grade. Desktop-only out-of-band frames: `sidecar.preflight`,
`model.download.progress`, `model.bakeoff.progress`, `task.blocked` (legacy shape).
