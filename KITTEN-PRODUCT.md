# Kitten — product unification build

Turning the split Cheater / Kitten / Ascent codebase into ONE local-first coding product, per
`KITTEN_PRODUCT_GOAL.md`. This doc tracks the canonical architecture and what has actually landed
(honest, code-backed — not aspirational).

## The problem this build solves

Three overlapping products lived in one repo, and the strongest engine, best UX, and public identity
did not coincide:

1. **`cheater`** — the mature Pi-extension TUI (blueprint/commitlet machinery, pixel mascot).
2. **`kitten`** — a thin Pi-free interactive REPL over Kitten Core.
3. **Kitten Core / Ascent** — the strongest pass@k→pass@1 reliability engine (`cheater-pi/src/core/`),
   reachable only via a flag-driven measurement CLI. **No file outside `core/` imported it**, so the
   `cheater` product never ran it.

The fix is a single shared backend that every client drives, with the Ascent engine promoted to the
adaptive default.

## Canonical architecture (the spine — landed)

```
Kitten application core  (cheater-pi/src/core/, Pi-free)
  ├── events.ts          versioned event model (the ONE state machine)
  ├── store/             durable SQLite conversation/event/run store
  ├── router.ts          adaptive lane router (answer / reliable / ascent)
  ├── runner.ts          lane → engine (answer/direct/reliable/bon/ascent)
  ├── app.ts             KittenApp service: route → run → persist → broadcast
  └── kitten.ts          canonical `kitten` command (run / resume / conversations / doctor)
        └── clients: headless CLI (now) · TUI (Phase C) · web UI (Phase D)
```

One implementation of conversation state, execution state, persistence, events, and routing. Clients
submit user actions and render events; they never decide eligibility, mutate the run ledger, or infer
completion from text.

### Canonical command flows

| Command | Behavior |
|---|---|
| `kitten` | interactive session in the cwd (currently the existing REPL; Phase C replaces with the TUI) |
| `kitten run "<task>"` | route → execute → **persist** → stream events; prints a resumable conversation id |
| `kitten resume [id]` | replay a stored conversation's full history (no id → list recent) |
| `kitten conversations` / `ls` | list stored conversations (id, when, outcome, title) |
| `kitten doctor` | Node + store health (endpoint/model checks land in Phase E) |
| `cheater` | unchanged Pi path for now; becomes a compatibility alias in Phase E |

Options for `run`: `--cwd DIR  --model M  --lane answer|direct|reliable|bon|ascent  --k N  --json`.

### The event model (`core/events.ts`)

A versioned discriminated union. Every event carries an envelope — `id` (`conversationId:seq`),
`conversationId`, per-conversation gap-free `seq`, `ts`, `schemaVersion` — plus a typed payload:
`conversation.created/renamed/archived`, `user.message`, `route.selected`, `run.started/status`,
`assistant.delta/final`, `tool.*`, `candidate.*`, `verification.*`, `file.changed`, `diff.updated`,
`repair.started`, `run.cancelled/interrupted/failed/completed`, `receipt.finalized`. `seq` is assigned
by the store (the single ordering authority); ids are derived, so replay is deterministic.

### Persistence (`core/store/`)

Built on Node's **built-in `node:sqlite`** (Node ≥ 22.5) — real SQLite (transactions, WAL, migrations)
with **zero native-module install friction**, which keeps packaging and CI clean. A thin adapter
(`db.ts`) isolates the engine so it is swappable. Store lives at `~/.kitten/kitten.db`
(`KITTEN_HOME` override); one user-level store spanning projects, each conversation recording its own
project identity.

Schema (migration v1, `PRAGMA user_version`):

- **conversations** — id, title, project_root, project_id, model, mode, created/updated, archived,
  last_seq (monotonic counter), search_text (title + message text), schema_version.
- **events** — (conversation_id, seq) PK, ts, type, run_id, payload JSON, schema_version. The
  append-only, ordered **source of truth**.
- **runs** — a projection updated transactionally *from the same events*: request, lane, reasons, k,
  status, finished, winner, summary, verified, files_changed, usage, error, started/ended.

`appendEvent` runs in one transaction: assign next seq → insert event → update the conversation
aggregate → apply the run projection. So the projection can never drift ahead of the log.

**Crash recovery**: on startup, any run left in a transient status (`queued/running/waiting_approval/
cancelling`) is flipped to `interrupted` and a `run.interrupted` event is appended — a client never
shows a crashed run as still running or completed.

### Adaptive router (`core/router.ts`)

Deterministic and inspectable (Goal §3). Reuses the existing Pi-free autopilot classifier (regex) +
`scoreHardness` — **cheap deterministic evidence, never a model-estimated difficulty number**, so easy
tasks never pay best-of-N latency:

- explanation/orientation, no requested change → **answer** (no write tools)
- ordinary bug fix / small feature → **reliable k=1** (check-first + gates + finish evidence)
- high-risk **or** complexity signals **or** ambiguous (low confidence) **or** large/multi-part build
  → **Ascent k=2** (coverage + execution consensus + finished-but-wrong repair)

Every decision records its reasons in `route.selected`, surfaced in the CLI and persisted.

## Status

| Phase | State |
|---|---|
| **A — spine** (events, store, app service, headless CLI, recovery) | ✅ landed, tested |
| **B — Ascent as adaptive default** (router) | ✅ router landed; candidate-isolation for in-place lanes, `/undo`, approval policy layer **still to do** |
| **C — Pi-free TUI + mascot port** | ⏳ not started (audit + extraction plan ready) |
| **D — local web UI** | ⏳ not started |
| **E — packaging / CI / onboarding / docs / compat alias** | ⏳ not started (Node floor already set to ≥ 22.5) |

**Exit condition met (Phase A):** a headless run persists and replays a complete conversation through
the shared API — proven by `test/app-service.test.ts` (EXIT CONDITION) and live via `kitten run` →
`kitten resume`.

**Tests:** 729 green (703 pre-existing preserved + 26 new: store, app service, CLI, router). All new
tests are offline/deterministic (fake/scripted runner, `:memory:` or temp-file store) — no model needed.

## Honest limitations / not-yet-true

- `kitten` (bare) is still the old REPL, not the new TUI. No web UI yet.
- The reliability wins (worked examples, execution consensus, repair resampling, disjointness, owned
  decode) are preserved in `core/` and reachable through the Ascent lane, but the router→Ascent path
  has not yet been measured on a real battery *through the app service* (the engine's own battery
  numbers stand; the plumbing is new).
- `runner.ts` maps the Ascent lane but does not yet surface the adopted candidate's changed files as
  `file.changed` events (marked TODO).
- No approvals/undo/candidate-isolation for in-place lanes yet; cancellation is wired (`app.cancel`).
- `kitten doctor` does not yet probe the endpoint/model/capabilities (Phase E).

## Smallest next milestones

1. **Finish Phase B**: surface Ascent winner file changes as events; add `/undo` (snapshot before a
   run, restore last adopted run without touching pre-existing dirty work); a shared approval policy
   layer used by every client.
2. **Phase C**: extract the mascot (`ui/catPixels.ts` + `ui/mascot.ts` are already Pi-free;
   `composeCat(state)` is the pure `(state)→frame` fn) into a runtime-independent module, then build the
   streaming TUI over the app's event stream.
3. **Phase D**: `kitten web` — a 127.0.0.1 server streaming the same events over WebSocket/SSE with
   reconnect + replay-after-seq (the store already supports `readEvents(afterSeq)`).
4. **Phase E**: LICENSE + repo metadata + `files` allowlist, `prepack` + packed-install smoke test,
   cross-platform CI, first-run onboarding, `cheater` → compat alias, retire stale Pi-only surface.
