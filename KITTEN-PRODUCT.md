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
  ├── undo.ts            git-snapshot rollback (/undo)
  ├── mascot.ts          runtime-independent pixel-cat (catAnsi for TUI, catCells for web)
  ├── app.ts             KittenApp service: route → run → persist → broadcast + approvals + undo
  └── kitten.ts          canonical `kitten` command dispatcher
        ├── tui.ts       streaming terminal UI
        ├── web/         local web UI (server.ts + page.ts) over SSE
        └── headless     kitten run / resume / conversations / undo / doctor
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

### Terminal UI (`core/tui.ts`)

`kitten` opens a streaming, event-driven TUI over the app service (no Pi). Linear streaming (native
scrollback — robust on Windows). Renders the pixel-cat mascot (state driven by the event stream), routes
every canonical event to a styled line, and covers the workflow with slash commands (`/new`, `/resume`,
`/conversations`, `/rename`, `/model`, `/mode`, `/diff`, `/undo`, `/cat`, `/doctor`, `/help`, `/exit`).
Interactive approvals (y/N), Ctrl+C cancels an active run (again to exit), `/resume` replays a stored
conversation's full history. `kitten repl` keeps the old minimal REPL for compatibility.

### Web UI (`core/web/`)

`kitten web` starts a dependency-free HTTP + SSE server on `127.0.0.1` over the SAME core and store. A
per-launch secret token authenticates every `/api/*` call (header for fetch; query for the EventSource);
Origin is allowlisted to loopback; no secrets reach the browser. The frontend is one self-contained HTML
string (no framework, no build step, no CDN): sidebar with search, streamed conversation, composer with
Stop, inline approvals, changed-files + unified diff, the mascot painted from `catCells`, safe markdown
(DOM nodes, never innerHTML), a11y + reduced-motion + light/dark. Refresh and server-restart restore the
conversation via `?c=` + replay-after-seq.

### Safety + undo

- **Safety floor** (`agent.ts` + `reliability/commandSafety.ts`): catastrophic / RCE / secret-exfil
  shell commands are hard-blocked in every lane. Merely-destructive commands route through an approval
  policy (`ask` / `auto-allow` / `auto-deny`; the CLI defaults to safe, `--dangerous` opts in).
- **`/undo`** (`core/undo.ts`): a pre-run `git stash create` snapshot lets undo restore only the run's
  own files (revert modified, delete created) while preserving your other dirty work. Never a whole-tree
  reset. Covers all lanes including Ascent (winner files derived from git).

## Status — all phases landed

| Phase | State |
|---|---|
| **A — spine** (events, store, app service, headless CLI, recovery) | ✅ landed, tested |
| **B — Ascent as adaptive default** (router, undo, safety/approvals, Ascent file events) | ✅ landed, tested |
| **C — Pi-free TUI + mascot port** | ✅ landed, tested + verified live |
| **D — local web UI** (SSE, security, mascot) | ✅ landed, tested + verified live in a browser |
| **E — packaging / CI / doctor / compat alias / docs** | ✅ landed; packed-install smoke passes |

**Exit conditions met:** a headless run persists and replays a complete conversation through the shared
API (`test/app-service.test.ts`, live `kitten run`→`resume`); interrupted runs recover honestly; losing
candidates leave no changes (Ascent isolation) and `/undo` preserves dirty work; a browser refresh +
server restart restore the conversation; `npm pack` installs clean and launches the TUI + web + a
persisted run (`npm run smoke`).

**Tests:** **754 green** (703 pre-existing preserved + 51 new: store, app service, CLI, router, undo,
safety, mascot, TUI, web). All offline/deterministic (fake/scripted runner, `:memory:`/temp store, local
web server) — no model needed. CI runs them on {ubuntu, windows} × node {22, 24} plus a packed-install
smoke.

## Reality pass (live against Ornith)

A follow-up pass (**`KITTEN-REALITY.md`**, branch `kitten-reality`) proved the product true under the
real local **Ornith-1.0-35B** (llama.cpp @ `:8080`) and fixed the general failures it exposed:
- **Conversation context is now real** (`core/context.ts`): a follow-up in a *fresh process* answers
  from prior-turn context — proven live. (Before: the model got only the latest sentence.)
- **Streaming is now real** (`KittenLLM.chatStream`): proven live — a 3-sentence answer streamed as 10
  incremental deltas + one final. (Before: whole-response only.)
- **Verified ≠ finished** (§4): honest completion grades — verified / checked / unverified — never a
  green check for lifecycle completion.
- **Cancellation** kills the shell process tree; **config** is unified (file + env, validated); the
  worked-example verifier, doctor, and changed-file/undo bugs found live are fixed.
- **9/9 live stress tasks solved correctly with zero false-positive verifications** (single-function,
  hidden-oracle). Test suite: **775 green**.

## Honest limitations / not-yet-true

- **Battery ablation + real-repo suite not completed.** The 9/9 live stress result is single-function,
  product-path solved/grade — NOT a direct-`k=1` vs adaptive vs Ascent-`k=2` comparison, and not
  multi-file. Those (and a live browser session) are the reality pass's own next steps.
- **Package name** is still `@cheater/cheater-pi`; the bins are `kitten`/`cheater`. Renaming to `kitten`
  is a deliberate follow-up (name availability + redirect).
- The web UI has no syntax-highlighting library (monospace diffs only, by design — zero deps).

## Next milestones (smallest first)

1. Run the hard-task battery **through `kitten run`** (not the raw Ascent CLI) and record honest
   product-path numbers.
2. Drive one real end-to-end coding session against a local model in both the TUI and web UI; fix
   whatever friction surfaces.
3. Unify configuration behind one validated loader for all clients; add first-run onboarding that
   detects the endpoint and lists models.
4. Rename the npm package to `kitten`; retire the Pi extension behind a dated removal boundary once the
   TUI/web fully cover its workflows.
