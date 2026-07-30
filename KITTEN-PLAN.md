# KITTEN-PLAN — the competitive-harness master plan

This is the single execution plan for turning Kitten into the most competitive local-model coding
harness, delivered as **one polished native desktop program** with no browser or terminal user
surface, with a
subagent system better than opencode's, tuned specifically for **ornith-1.0-35B-A3B + qwen3.5-2B
sidecar** class hardware reality (~20–40 tok/s, 16k ctx, single endpoint).

It is written to be executed by a smaller model, phase by phase, top to bottom. Every task names
exact files, exact symbols, exact tests, and an exact acceptance check. Do not improvise around the
invariants. Do not skip verification.

---

## 0. Executor protocol (read before touching code)

### 0.1 How to execute this plan

1. Work **one task at a time**, in phase order. Do not start a task until the previous task's
   acceptance check passes.
2. Before each task, **read the files it names in full**. The plan cites verified facts with
   `file:line` references; lines may have drifted — trust the symbol names over the numbers.
3. After each task: `npm run build && node --test dist/test/*.test.js` from `cheater-pi/` must be
   green, plus the new tests the task requires. Then `npm run typecheck`.
4. Commit after every task with message `plan(<phase>): <task name>`. Never commit secrets.
5. If a task contradicts the code as it exists, the code wins on facts, the plan wins on intent:
   implement the intent, note the deviation in the commit message.
6. **Never break the invariants (§0.2).** A change that breaks one is a bug regardless of tests.
7. Keep changes minimal and in the style of the surrounding code. The Kitten core has a strong
   existing doctrine (see `KITTEN-CODE.md` design laws): deterministic clerical work, additive
   seams, graceful fallback, no new user-facing flags unless this plan says so.
8. Update docs as you go: each phase ends by updating `KITTEN-PRODUCT.md` (status table) and
   `cheater-pi/README.md` (if user-facing behavior changed).
9. Benchmark honesty: **one successful task is not evidence of general superiority.** Any lever in
   Phase 6 that isn't measured through `kitten run` on the battery stays marked unmeasured.
10. All tests must remain offline/deterministic (fake/scripted runners, `:memory:`/temp stores,
    local servers). No test may require a model endpoint.

### 0.2 Product invariants (binding — violations are bugs)

From the product constitution, plus the new ones from this plan:

- **One supported user product: Kitten Desktop.** The native Avalonia shell is the only supported
  user surface; the hidden Node engine is an implementation detail. Maintainer CLI/TUI/web modules
  may remain in source for compatibility, but are excluded from the release payload.
- **One application service/event model** across TUI, web, desktop, headless, and attach. Clients
  submit actions and render events; they never decide eligibility, mutate the run ledger, or infer
  completion from text.
- **Native-only UI.** Kitten Desktop owns the user experience directly; it does not embed a browser,
  webview, HTML page, terminal, or TUI. The local IPC protocol is the seam between the shell and the
  hidden engine.
- **No telemetry or background update requests.** Update checks are explicit and user-initiated.
- **Secrets remain environment-backed or endpoint-bound OAuth data.** Never in the store, logs,
  events, webview content, telemetry, or release assets.
- **No silent downloads or installs.** The desktop installer asks before installing anything
  (including Node).
- **Catastrophic command protections cannot be overridden.** The safety floor applies to every
  lane, every subagent, every client.
- **All project paths are lexical- and real-path confined.** This extends to subagent workspaces
  and the desktop shell's file access.
- **Model prose is not verification evidence.** Only execution receipts grade completion — this
  applies to subagent results too (Phase 5: parents receive receipts, not summaries to trust).
- **Production dependency count remains zero** for the CLI package unless an audited dependency has
  an overwhelming product justification. Desktop/VS Code packages carry their own deps and are
  never dependencies of the CLI package.
- **OpenCode compatibility is a migration feature; Kitten must remain an independent product.**
- **The legacy Pi runtime stays outside the production package** (enforced in Phase 7).
- **The polish bar:** the user should never deal with bullshit. Confusing errors, unclear approval
  state, missing progress feedback, inability to inspect changes, TUI/web inconsistency, false
  completion, lost context after resume, and cancellation that leaves hidden work running are all
  release-blocking defects.

### 0.3 Verification commands (memorize)

```sh
cd cheater-pi
npm run typecheck                          # strict, zero errors
npm run build                              # tsc → dist/
node --test dist/test/*.test.js            # full suite, currently 912 green
npm run smoke                              # pack → clean install → exercise bins + web
node dist/src/core/kitten.js help          # the product, headless
```

---

## 1. Current state — verified facts (the honest starting point)

These were verified against the code on branch `kitten-hardening` (July 2026). Where the plan says
"exists" or "does not exist", it was grep/read-verified.

### 1.1 The spine is real

- One event model (`cheater-pi/src/core/events.ts`, 31 payload types, schema v1, per-conversation
  gap-free `seq`), one SQLite store via `node:sqlite` (`core/store/conversationStore.ts`,
  migrations v1+v2, `PRAGMA user_version`, append-only-migration rule at `:75-132`), one app
  service (`core/app.ts` `KittenApp`), adaptive router (`core/router.ts`), lanes
  answer/direct/reliable/bon/ascent (`core/runner.ts`), TUI (`core/tui.ts`), web
  (`core/web/server.ts` + `core/web/page.ts`), headless (`core/kitten.ts`).
- Crash recovery flips transient runs to `interrupted` on startup. Cancel kills process trees and
  auto-denies pending approvals. Undo is git-snapshot-backed per run (`runs.snapshot`, v2).
- 912 offline tests green; CI on {ubuntu, windows} × node {22, 24} + packed-install smoke.

### 1.2 The surprises (verified — plan around these)

1. **`kitten serve` and `kitten attach` DO NOT EXIST.** `kitten.ts:381-398` dispatches only
   `run | resume | conversations|ls | undo | doctor | init | web | repl | help`. The web server is
   per-launch ephemeral (random token, dies with the process). In-flight runs, approvals, and
   cancel are **in-process** (`app.ts:106,109`) — two processes sharing the store cannot approve or
   cancel each other's runs. → Phase 0 builds the daemon.
2. **The package is NOT zero-dependency.** `cheater-pi/package.json` has
   `@earendil-works/pi-coding-agent` + `pi-tui` as runtime deps (legacy `cheater --pi` path), and
   `package-lock.json` is **stale** (wrong bins, wrong engines, wrong dep kinds — `npm ci` would
   fail). → Phase 7 strips the legacy runtime out of the production package.
3. **Web UI has ZERO slash commands.** `page.ts` `send()` posts every keystroke verbatim to
   `/api/message`; typing `/undo` sends the literal text to the agent. `/api/message` also **drops
   `lane`/`k`** though `submitMessage` supports them. → Phase 2 (shared command layer + rebuild).
4. **Web UI drops the run's outcome.** `run.completed` renders as almost nothing — no verified
   badge, no summary, no wall time, no token usage (all present in the event). This is a primary
   "feels empty" cause. `/api/status` exists but is never called. Historical messages timestamp
   "just now" (renderer ignores `ev.ts`). Replayed approvals render as actionable (no
   approval-resolved event exists). "Delete" is fake (archive; the store has no delete). The run
   banner states `waiting_approval`/`running` are unreachable (only `cancelling` is ever emitted).
5. **Model identity has three real bugs:**
   - The **ascent lane drops `ctx.model`** (`runner.ts:134-171` → `ascent.ts`: `AscentParams` has
     no model field) — ascent runs use the client construction-time model, so a resumed
     conversation can silently run a different model than its recorded identity.
   - **Web never records the model**: `web/server.ts:114-118` creates conversations without a
     model → always the app boot default.
   - TUI/web `--model` detection compares against `DEFAULT_MODELS.main` (env-derived at module
     load): if `--model` equals the env default it's silently indistinguishable from "no flag".
   - Also: `kitten run --model X -c <id>` is **silently ignored** (resume must use the recorded
     model — this needs a loud error, not silence).
6. **`/model` today is one line** (`tui.ts:349`): no validation, no discovery, no persistence,
   session-state only. The only discovery code is module-private `diagnoseEndpoint`
   (`kitten.ts:232-268`); `KittenLLM` has no `listModels()`. No provider registry exists (the
   cloud-burst endpoint is env-only and ascent-only).
7. **Subagents do not exist in the Kitten core.** The `candidate.*` event types are **defined but
   never emitted**; `runs.winner` is a **dead column**; candidate workspaces are deleted after
   adoption; per-candidate event streams and usage are discarded after aggregation. The Pi-world
   capsule workers (real child sessions via `createAgentSession`) are unreachable from
   `core/app.ts` and invisible to the store. Milestone 7's premise ("durable parent-linked events")
   is aspirational schema, not behavior. → Phase 5 builds it in the stated order.
8. **No shell completions, no installer, no checksums, no release workflow.** `RELEASING.md` is
   complete but **untracked**. The four repo-root launchers are untracked dev conveniences;
   `Kitten Web.bat` hardcodes machine-specific paths — exactly the failure mode the desktop
   program must kill. `@cheater/cheater-pi` is genuinely unpublished on npm (404).
9. **No `/redo`, no `/export`.** The workflow gauntlet (Milestone 4) requires both.
10. **opencode's agent surface (measured July 2026)**: primary agents (build/plan), subagents
    (general/explore/scout), hidden system agents (compaction/title/summary), `@`-mentions, a
    `task` tool with per-agent task permissions, per-agent model/temperature/steps/permission
    overrides, markdown agent files, child-session navigation, `/undo` **and** `/redo`. That is
    the bar. Kitten's wedge: execution-grounded child results, deterministic scout briefs, local
    model tiering, and durable follow-up-able child conversations.

---

## 2. Target architecture (one picture)

```
                        ┌──────────────────────────────────────────────┐
                        │              THIN CLIENTS                     │
                        │  kitten (TUI)   kitten app / Kitten Desktop   │
                        │  kitten web     VS Code extension             │
                        │  kitten attach (TUI on a remote daemon)       │
                        └───────────────┬──────────────────────────────┘
                                        │ HTTP + SSE, token auth, seq replay
                        ┌───────────────▼──────────────────────────────┐
                        │  kitten serve  (daemon, owns ALL in-flight)  │
                        │  ┌────────────────────────────────────────┐  │
                        │  │ KittenApp service (core/app.ts)        │  │
                        │  │ route → run → persist → broadcast      │  │
                        │  │ approvals · cancel · undo/redo · spawn │  │
                        │  ├────────────────────────────────────────┤  │
                        │  │ command layer (core/commands.ts)       │  │
                        │  │ ONE registry → TUI, web, headless      │  │
                        │  ├────────────────────────────────────────┤  │
                        │  │ store (node:sqlite, ~/.kitten/kitten.db)│ │
                        │  │ conversations · events · runs · agents │  │
                        │  └────────────────────────────────────────┘  │
                        └───────────────┬──────────────────────────────┘
                                        │ OpenAI-compat + native llama.cpp
                        ┌───────────────▼──────────────────────────────┐
                        │  providers: local (LM Studio/llama.cpp)      │
                        │             cloud-burst (same weights)       │
                        │  main: ornith-1.0-35b-a3b                    │
                        │  sidecar: qwen3.5-2b (clerical, no-think)    │
                        └──────────────────────────────────────────────┘
```

Everything below builds this in dependency order: **Phase 0 foundations → Phase 1 models →
Phase 2 interface → Phase 3 program → Phase 4 polish gauntlet → Phase 5 subagents →
Phase 6 small-model engine → Phase 7 release → Phase 8 VS Code.**

Phases 0–4 are the "stop being shit" arc. Phases 5–6 are the "beat opencode" arc.
Phases 7–8 ship it.

---

## PHASE 0 — Foundations (everything else stands on this)

**Goal:** a real daemon (`kitten serve`), one command layer shared by all clients, the store/event
additions every later phase needs, and the three model-identity bugs fixed.

### Task 0.1 — `kitten serve` daemon + `kitten attach`

**Files:** new `cheater-pi/src/core/serve.ts`; refactor `core/web/server.ts`; touch
`core/kitten.ts` (dispatch), `core/tui.ts` (remote mode), `core/web.ts` (reuse).

Design:

- Extract from `web/server.ts` a reusable `createKittenServer(app, opts): KittenServer` where
  `opts = {host, port, token, servePage: boolean}`. `kitten web` keeps today's behavior
  (ephemeral token, serves the page, opens browser, dies on exit). `kitten serve`:
  - binds `127.0.0.1`, `--port` default `4025` (`--port 0` = ephemeral);
  - token: generated, written to `~/.kitten/serve.json` **mode 0600**:
    `{port, token, pid, startedAt, version}`; printed once as JSON with `--print-connection`;
  - single instance per user: on start, if `serve.json` exists and `GET /api/status` with its
    token answers, exit with "already running (pid N, port P)" unless `--replace`;
  - serves the full API + page (the desktop program and browser both connect to it);
  - does NOT open a browser; logs one line: `kitten serve listening on http://127.0.0.1:PORT
    (connection file: ~/.kitten/serve.json)`;
  - on SIGTERM/SIGINT: mark nothing "completed" — existing crash recovery already flips
    transient runs to `interrupted` on next start. Test this.
- `kitten attach`: the TUI in **remote mode** — reads `~/.kitten/serve.json` (or `--url/--token`),
  talks to the daemon over the same HTTP/SSE API the web uses. This requires the TUI's app calls
  to have a remote `KittenClient` implementation with the same surface as `KittenApp`
  (`submitMessage, cancel, resolveApproval, undoLast, ...` + `subscribe` via SSE). Introduce
  `core/client.ts`: `KittenClient` interface; `LocalClient` wraps `KittenApp`; `RemoteClient`
  uses fetch/EventSource. TUI, web page, and attach all consume the interface.
- Because the daemon owns in-flight runs, **approvals and cancel now work across clients**:
  approve from the desktop a run started in the TUI. This is the "one application service/event
  model across TUI, web, headless, and attach" invariant made literal.

**Tests** (`test/serve.test.ts`, `test/remote-client.test.ts`): connection file written 0600 and
redacted from logs; second instance refuses; `--replace` works; RemoteClient submit → SSE stream
receives gap-free seq after reconnect; approve-via-HTTP resolves a TUI-started run; SIGTERM during
a run → next start marks it `interrupted`, never `completed`/`running`.

**Acceptance:** `kitten serve &` → `kitten attach` → send task → approve from `curl` →
`kitten run -c <id> "follow up"` works after killing and restarting the daemon.

### Task 0.2 — Store migration v3 + event additions

**Files:** `core/store/conversationStore.ts` (MIGRATIONS — append v3, never edit v1/v2),
`core/events.ts`, `core/app.ts`.

Migration v3 (single `BEGIN IMMEDIATE` like the existing `migrate()`):

```sql
ALTER TABLE runs          ADD COLUMN model TEXT;
ALTER TABLE runs          ADD COLUMN agent TEXT;
ALTER TABLE runs          ADD COLUMN parent_run_id TEXT;
ALTER TABLE runs          ADD COLUMN undone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs          ADD COLUMN snapshot_after TEXT;
ALTER TABLE conversations ADD COLUMN provider TEXT;
ALTER TABLE conversations ADD COLUMN agent TEXT;
ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT;
ALTER TABLE conversations ADD COLUMN parent_run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_parent
  ON conversations(parent_conversation_id);
```

Event model (`core/events.ts`; additive — keep `EVENT_SCHEMA_VERSION = 1`, and add a regression
test that every renderer (TUI `renderEvent`, web `applyEvent`, CLI printer) **ignores unknown
event types without crashing**):

| Addition | Payload | Why |
|---|---|---|
| `run.started` + `model`, `agent?` | existing + `model: string` | effective-model identity per run (acceptance: TUI/web/headless record identically) |
| `run.completed` + `model` | existing + `model: string` | usage/support reports show effective model |
| `tool.approval_resolved` | `{runId, callId, allowed, source: "user"\|"auto-deny-cancel"}` | kills the "replayed approval is actionable" lie (KITTEN-HARDENING deferred item) |
| `run.redone` | `{runId, restored[], deleted[], skipped[]}` | mirrors `run.undone` for `/redo` |
| `task.started` | `{runId, childConversationId, agent, prompt}` | Phase 5 (define now, emit later) |
| `task.completed` | `{runId, childConversationId, childRunId, status, summary, usage}` | Phase 5 (define now, emit later) |

Emit `tool.approval_resolved` from `app.resolveApproval` and from `app.cancel`'s auto-deny. Emit
`run.status` `"running"` at run start and `"waiting_approval"` when an approval becomes pending
(the web banner already handles these states; nothing emits them today). Set `runs.winner` in the
run projection when an ascent/bon run completes (the value exists at `ascent.ts` — thread it
through `RunOutcome`; the column has been dead since v1).

**Tests** (`test/store.test.ts` additions): v2→v3 migration preserves all rows; new columns
nullable/defaulted; double-migrate safe; projection sets `winner`, `model`, `undone`; unknown
event type tolerated by all three renderers.

**Acceptance:** open a v2 database with the new build → migrates cleanly, old events replay
identically, new runs record `model`.

### Task 0.3 — The shared command layer (`core/commands.ts`)

**Files:** new `core/commands.ts`; refactor `core/tui.ts` `slash()`; new endpoint in
`core/web/server.ts`; `core/kitten.ts` headless wiring.

Design — ONE registry, three renderers:

```ts
export interface CommandIO {
  print(text: string, style?: "dim"|"ok"|"warn"|"error"): void;
  table(rows: string[][], header?: string[]): void;
  frame(frame: CommandFrame): void;   // structured card; TUI degrades to text
}
export interface SessionState {
  conversationId: string | null;
  model: string;            // default for NEW conversations (session-level)
  provider: string | null;  // Phase 1
  lane: LaneName | null;    // per-message override (/mode)
}
export interface CommandContext {
  app: KittenApp; llm: KittenLLM; settings: KittenSettings;
  session: SessionState; cwd: string; io: CommandIO;
}
export interface KittenCommand {
  name: string; aliases?: string[]; usage: string; description: string;
  run(ctx: CommandContext, arg: string): Promise<void>;
}
export const COMMANDS: KittenCommand[];
export async function runCommand(ctx, input: string): Promise<boolean>; // false = not a command
```

- Move every TUI command implementation out of `tui.ts:324-394` into the registry, unchanged in
  behavior: `help exit quit new conversations ls resume rename model mode diff undo cat doctor web
  search archive status`.
- Web: `POST /api/command {conversationId, input}` → runs `runCommand` with an IO that collects
  frames → returns `{frames}`. The page's composer detects a leading `/` and calls this instead of
  `/api/message`. `GET /api/commands` returns `{name, usage, description}[]` for the slash menu —
  single source of truth, so a new command appears in TUI and web simultaneously.
- Headless: `kitten run` stays the pipeline; `/`-commands are interactive-only, EXCEPT the ones
  that already exist headlessly (`doctor`, `conversations`, `undo`, `resume`) — those get thin
  shims over the registry so behavior can't diverge.

**Tests** (`test/commands.test.ts`): every command runs against a scripted `KittenApp` with a
capturing IO; TUI parity test — for each command, TUI-frame text and web-frame payload carry the
same facts (snapshot both); `GET /api/commands` lists the full registry; unknown `/foo` yields a
helpful "unknown command, try /help" in both clients.

**Acceptance:** typing `/status`, `/model`, `/diff` in the web composer works and matches TUI
output fact-for-fact.

### Task 0.4 — Fix the three model-identity bugs

**Files:** `core/ascent.ts` (+ `AscentParams.model`), `core/runner.ts:134-171`,
`core/cloudBurst.ts:101,263-268`, `core/web/server.ts:114-118`, `core/web.ts:32-46`,
`core/tui.ts:177-187`, `core/kitten.ts:85-145`.

1. Thread `ctx.model` through `AscentParams` → `cloudBurstGenerate` (per-call `ChatParams.model`,
   the same mechanism every other lane uses). One-line-shape change, big honesty win.
2. Web `POST /api/conversations` accepts optional `{model}`; the page sends the current picker
   value (Phase 1 wires the picker; for now send `window.KITTEN.model`). Server falls back to app
   default exactly like the TUI.
3. Replace the `model !== DEFAULT_MODELS.main` hack in `tui.ts`/`web.ts` with an explicit
   `modelFlagProvided` boolean from arg parsing.
4. `kitten run --model X -c <id>`: hard error — `conversation <id> already runs model <M>; resume
   uses the recorded model. Start a new conversation to use --model.` (Exit 2, no run started.)
5. Record `model` on `run.started`/`run.completed` and in the runs projection (uses Task 0.2).

**Tests:** ascent lane with `ctx.model = "other-model"` issues requests with `"other-model"` in
the body (fake LLM records bodies); web-created conversation stores the posted model; `--model`
+ `-c` exits 2 with the exact error; run rows carry the effective model for all four lanes.

**Acceptance (the pasted criterion):** create the same conversation via TUI, web, and headless
with the same model → `conversations.model` and every `runs.model` identical across the three.

---

## PHASE 1 — Model & provider system (the `/model` contract)

**Goal:** the pasted specification, implemented exactly:

- `/model NAME` validates against discovered models when discovery succeeds.
- When discovery is unavailable, permit an explicit model ID but clearly mark it unverified.
- Persist the selected model only on the newly created conversation; never mutate historical run
  model identity. (Already true at the store layer — keep it that way; add a test that proves no
  code path UPDATEs `conversations.model`.)
- Equivalent web behavior and an explicit headless `--model` (exists — now validated + consistent).
- A model switch never silently changes provider, endpoint, credentials, or permission policy.
- A helpful error when a user requests a model belonging to a different configured provider.

### Task 1.1 — Discovery as a reusable core capability

**Files:** new `core/discovery.ts`; `core/llm.ts` (+ `listModels`); `core/kitten.ts` (move
`diagnoseEndpoint` out, keep behavior).

```ts
// core/discovery.ts
export interface ModelInfo { id: string; provider: string; verified: boolean }
export interface DiscoveryResult {
  ok: boolean; models: ModelInfo[]; engine: EngineKind; error?: EndpointError;
}
export async function discoverModels(llm: KittenLLM, provider: string): Promise<DiscoveryResult>;
export async function pingModel(llm: KittenLLM, model: string): Promise<boolean>;
```

- `KittenLLM.listModels(): Promise<string[] | null>` — `GET {baseUrl}/models`, 4s timeout, Bearer
  auth like `diagnoseEndpoint`, `null` on any failure (endpoint down, non-JSON, 404). Never throws.
- Keep the doctor philosophy (`kitten.ts:327-334`): **ping is authoritative**; a llama.cpp
  single-model server advertises the .gguf path but accepts any id.
- Validation algorithm for an explicit model request `NAME` (one function, used by TUI/web/headless):

```
list = listModels()
if list != null:
  if NAME in list            → accept, verified=true
  elif NAME in OTHER providers' discovered lists → CROSS-PROVIDER ERROR (Task 1.3)
  elif pingModel(NAME)       → accept, verified=true, note "not in /models list (normal on llama.cpp)"
  else                       → ERROR: "model 'NAME' not served by <provider>. Available: …"
else (discovery unavailable):
  if pingModel(NAME)         → accept, verified=FALSE, mark "unverified (endpoint gave no model list)"
  else                       → ERROR: "endpoint unreachable / model 'NAME' not responding" + doctor hint
```

**Tests** (`test/discovery.test.ts`): fake HTTP server covering each branch — listed, unlisted but
pingable (llama.cpp shape), unlisted unpingable (error names available ids), discovery down +
pingable (unverified marker), discovery down + unpingable (actionable error).

### Task 1.2 — `/model` in the command layer + headless + web picker

**Files:** `core/commands.ts` (`model` command — rewritten), `core/kitten.ts` (`cmdRun` validation),
`core/web/server.ts` (`GET /api/models`), `core/web/page.ts` (picker; temporary home until Phase 2).

- `/model` (no arg): show session default, its source (flag > env > project config > user config >
  built-in default), and verification state.
- `/model NAME`: run the Task 1.1 algorithm → set `session.model` (affects only NEW conversations)
  → print `model for new conversations: NAME ✓ verified` or `… ⚠ unverified (<reason>)`.
  Never touches: provider, baseUrl, apiKey, approvalPolicy, sidecar/embed/ORM models, and NEVER
  updates any existing conversation row (regression test: after `/model X`, all existing
  `conversations.model` values byte-identical).
- `kitten run --model NAME`: same validation; on validation failure exit 2 before creating
  anything. `--json` output gains `"model"` and `"modelVerified"`.
- Web: `GET /api/models` → `{models: ModelInfo[], current: string, unverified: boolean}`. Picker
  in the header (dropdown from the endpoint; an "unverified" badge; selection persists to
  `localStorage` and is sent on conversation creation). Server-side there is no per-browser
  session state: the model travels as a conversation-creation parameter — identical store outcome
  to TUI/headless.

### Task 1.3 — Provider registry (minimal, honest)

**Files:** `core/settings.ts` (new keys), new `core/providers.ts`, store (uses v3
`conversations.provider`), `core/commands.ts` (`/provider`).

Config shape (`~/.kitten/config.json`; project `.kitten/config.json` may add providers too):

```jsonc
{
  "provider": "local",                       // active provider name
  "providers": {
    "local":    { "baseUrl": "http://localhost:1234/v1" },
    "llamacpp": { "baseUrl": "http://localhost:8080/v1" },
    "alibaba":  { "baseUrl": "https://dashscope…/compatible-mode/v1",
                  "apiKeyEnv": "ALIBABA_API_KEY" }       // env-backed secret, never the value
  }
}
```

Rules:

- Backward compatible: with no `providers` key, behavior is exactly today (env/settings single
  endpoint = an implicit provider named `default`).
- A conversation records `provider` at creation (null = default). `/provider NAME` switches the
  session default for NEW conversations — same semantics as `/model`. It changes endpoint +
  credentials source **only for new conversations, loudly** ("new conversations will use provider
  'alibaba' (https://…), key from ALIBABA_API_KEY=set"). Historical rows never mutate.
- Cross-provider model error (the pasted requirement), exact shape:

  ```
  model 'qwen3.6-35b-a3b' is served by configured provider 'alibaba'
  (https://dashscope…/v1), but this session is on provider 'local'
  (http://localhost:1234/v1).
    → /provider alibaba        switch provider for new conversations
    → /model <id>              pick one of: ornith-1.0-35b, qwen3.5-2b
  ```

- **The no-silent-switch test (binding):** switching model or provider must leave
  `settings.models.baseUrl`, `apiKey`, `approvalPolicy`, sidecar/embed/ORM config, and every
  existing conversation row untouched — one test mutates session model/provider and asserts deep
  equality on all of the above.
- Precedence for per-role models stays exactly as documented in exploration: per-call
  `ChatParams.model` > `ctx.model` (= `conversations.model`) > creation input > session default >
  `settings.models.main` (`KITTEN_MAIN_MODEL` > project config > user config) > built-in default.
  Sidecar (`models.sidecar`, `tierSidecar` cloud re-tier), embed, ORM (`KITTEN_ORM_MODEL`), and
  cloud-burst (`KITTEN_CLOUD_*`) keep their own knobs. Write this chain into
  `cheater-pi/README.md` verbatim — "documented precedence" is an acceptance criterion.

### Task 1.4 — Usage & support reports show effective models, zero secrets

**Files:** `core/commands.ts` (`status` upgrade, new `usage`), new `core/support.ts`,
`core/kitten.ts` (`kitten support`), `core/web/page.ts` (run footer).

- Every run row now carries `model` (Task 0.2/0.4). `/usage` + run footer in web: per-run
  `model · lane · k · ✓/~/• grade · prompt+completion+reasoning tokens · wall time`.
- `kitten support` → a copy-pastable diagnostic bundle: kitten version, node, platform, config
  sources with `apiKey` rendered as `set`/`unset` (NEVER the value), endpoint + engine +
  capabilities, active provider, session model + verification state, last 10 runs
  (id, model, lane, grade, wallMs), store path. Redaction test: plant a fake key
  (`sk-test-…`) in env/config and assert the output contains no occurrence of it.

**Phase 1 acceptance (the pasted criteria, verbatim):**

- [ ] TUI, web, and headless runs record the effective model identically. (Test: same model via
      three clients → identical `conversations.model` + `runs.model`.)
- [ ] Resume uses the conversation's recorded model. (Test: resume after env change → requests
      still carry the recorded model; `--model -c` errors loudly.)
- [ ] Per-command and per-agent model overrides retain documented precedence. (Precedence chain
      test + README section.)
- [ ] Usage and support reports show effective model IDs without exposing secrets. (Redaction
      test.)

---

## PHASE 2 — The Interface (the web UI becomes THE interface)

**Goal:** one served interface so complete that the TUI is optional. Every `/` command works in
it. It is dense, honest, fast-feeling, and never lies about state. This is the UI the desktop
program (Phase 3) windows, the VS Code extension (Phase 8) mirrors, and `kitten web` serves.

**Prime directive:** fix the "empty and shit" verdict at its roots — the UI must show *everything
the event stream already knows*: run outcomes with grades and receipts, token/wall stats, tool
activity, verification timelines, candidate trees, approval state that can't lie, real progress.

### Task 2.1 — Split the monolith without adding a build step

**Files:** `core/web/page.ts` (1663 lines, one 82KB string) → `core/web/assets/` directory:
`index.html.ts`, `style.css.ts`, `app.js.ts`, `markdown.js.ts`, `mascot.js.ts` — each a TS module
exporting a string constant; `core/web/server.ts` serves them as separate routes
(`/`, `/assets/style.css`, `/assets/app.js`, …) with correct content types and `no-store`.

- Zero dependencies, zero bundler: still string templates, still no `innerHTML` for model content
  (the escape-by-construction markdown renderer moves as-is into `markdown.js.ts`).
- Why: a smaller model (and any maintainer) can edit a 300-line module safely; an 82KB
  interpolated string with a "no backticks anywhere" hazard (`page.ts:23-26`) is how the UI
  rotted. Keep the template-literal constraint documented at the top of each asset module.
- Test: `GET /` 200 + each asset route 200 + content-type; page references only served assets
  (no CDN — grep test for `http://`/`https://` in served HTML/JS except loopback).

### Task 2.2 — Honesty repairs (the "it lies to me" list)

**Files:** `core/web/assets/app.js.ts`, `core/web/server.ts`, `core/app.ts`.

Each of these was verified broken; each gets a regression test:

1. **Render `run.completed` fully**: grade badge (`✓ verified` / `~ checked` / `• unverified` —
   same words as TUI `tui.ts:106-109`), summary, wall time, token usage, model, lane/k.
2. **Historical timestamps from `ev.ts`**, never `Date.now()` (`page.ts:958,983` today).
3. **Approval lifecycle**: `tool.approval_resolved` (Task 0.2) → historical approvals render
   resolved ("Approved"/"Denied · by cancel"), only live pending ones are actionable. The card
   must always show: the exact command/paths, risk level, and the policy that will apply if you
   do nothing ("default: deny").
4. **Real delete**: `store.deleteConversation(id)` (DELETE + events + runs, one transaction) →
   `DELETE /api/conversations/:id`; UI keeps archive as the default, delete behind confirm.
5. **Wire `/api/status`** into a status surface (it's a dead endpoint today).
6. **Busy indicators for ALL conversations** with active runs, not just the open one (the SSE
   frames carry `conversationId` — track a Set).
7. **Emit `run.status` `running`/`waiting_approval`** from `app.ts` (Task 0.2) so the banner's
   existing states become reachable; banner shows `Waiting for approval — [y] approve [n] deny`.
8. **Accept `lane`/`k` on `POST /api/message`** (pass-through to `submitMessage` opts) —
   unblocks `/mode`, forced best-of-N from any client.
9. **`/api/rename` and `/api/archive` return 404 for unknown ids** (they currently return
    `{ok:true}` silently).

### Task 2.3 — Command parity in the composer

**Files:** `core/web/assets/app.js.ts` (composer), `core/commands.ts` (from Task 0.3).

- Composer detects leading `/` → `POST /api/command`; renders returned frames as rich cards
  (tables → tables, diff frames → colored diff, error frames → red, pickers → inline choosers).
- **Slash menu**: typing `/` opens a filtered menu from `GET /api/commands` (name, usage,
  description); ↑↓/Tab completes; Esc closes. Same registry as TUI Tab-completion, so parity is
  structural.
- **Input history**: per-user, stored server-side in the store (new table
  `input_history(input TEXT, ts INTEGER)` — append in Task 2.3, cap 500) so TUI and web share
  recall; ↑/↓ in the composer. (TUI keeps its file until it migrates to the same store — do the
  migration in this task and delete `~/.kitten/history.txt` handling.)
- **Multi-line**: Shift+Enter newline (exists), trailing `\` continuation (TUI parity).
- New commands landing here (all in the shared registry, so TUI gets them too):
  `/redo` (Task 2.4), `/export` (Task 2.5), `/delete`, `/usage`, `/agents` (Phase 5),
  `/provider` (Phase 1), `/retry` (re-submit the last user message of a
  cancelled/interrupted/failed run — the web already has a Retry button; make it a command too).

### Task 2.4 — `/redo`

**Files:** `core/undo.ts`, `core/app.ts` (`redoLast`, `redoRun`), `core/store` (v3 columns
`snapshot_after`, `undone` — Task 0.2), `core/commands.ts`.

- Capture the post-run state at run completion: second `git stash create` + the untracked-file
  manifest (same mechanism as the pre-run snapshot — reuse `undo.ts` code paths, don't fork them).
  Store in `runs.snapshot_after`.
- `undoLast` sets `runs.undone = 1`; `redoLast(conversationId)` picks the newest run with
  `undone = 1` and a `snapshot_after`, and re-applies the post-state to exactly the run's own
  files (revert-to-after modified, re-create files undo deleted, delete files the run created
  that undo restored — mirror logic of undo with the same drift guard: if any touched file's
  current content matches neither the pre- nor post-snapshot, refuse and say which file drifted).
- `run.redone` event (Task 0.2) + `undone = 0`. Undo/redo never touch files outside the run's
  recorded change set — the existing "preserve the user's other dirty work" guarantee holds.
- Tests (`test/undo.test.ts` additions): undo→redo round-trip restores byte-identical content;
  drift in a run file blocks redo with the right error; untracked pre-existing files are never
  deleted by the round trip; redo after a NEW run started is still correct (operates on run
  identity, not position).

### Task 2.5 — `/export` (Markdown)

**Files:** new `core/export.ts`; `core/commands.ts`; `core/kitten.ts` (`kitten export [id] [--out]`);
`core/web/server.ts` (`GET /api/conversations/:id/export` → `text/markdown`); web header button.

Renderer (deterministic, from the event log — the store is the source of truth):

```markdown
# <title>
_kitten conversation <id> · <project root> · model: <model> · provider: <provider> · <date>_

## You — 14:02
<user message text>

## Kitten — 14:02 · lane: reliable · k=1 · ~ checked · 38s · 12.4k tok
<assistant.final text>

<details><summary>tools (4)</summary>

- `edit src/parser.py` ✓ (+12 −3)
- `bash pytest -q` ✓ — 9 passed
…
</details>

**Verification:** ✓ red-then-green check `test_off_by_one` · ✓ full suite 9/9
**Files changed:** `src/parser.py` (+12 −3)
```

- Secrets safety: tool args are already sanitized in events (`tool.proposed`); assert the export
  contains no configured apiKey (reuse the redaction test helper).
- Web renders a "Download .md" (blob from the endpoint); headless writes
  `./<slug>-<id8>.md` and prints the path; `/export` in TUI/web writes via server and toasts the
  path.
- Tests: fixture conversation → golden markdown; export of a conversation with candidates →
  candidate sections collapsible; cancelled run exported honestly ("cancelled — work incomplete").

### Task 2.6 — The layout rebuild (structural/visual spec)

Build this in `core/web/assets/` (dark-first; gold/ink palette from `themes/cheater.json` —
accent `#f0b429`, warm dark panels; light theme via `prefers-color-scheme` + toggle as today).

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 🐱 Kitten   <conversation title ✎>          [model: ornith-1.0-35b ✓▾] [lane▾]  │
├───────────────┬────────────────────────────────────────────────────┬─────────────┤
│ SESSIONS      │  TRANSCRIPT                                        │ INSPECTOR   │
│ ┌───────────┐ │ ┌────────────────────────────────────────────────┐ │ [Changes]   │
│ │ search…   │ │ │ You · 14:02                                    │ │  parser.py  │
│ └───────────┘ │ │  fix the off-by-one in parser.py               │ │   +12 −3    │
│ ▸ Today       │ ├────────────────────────────────────────────────┤ │  util.py    │
│  ● parser fix │ │ Kitten · 14:02                          ~ chk'd│ │   +2 −1     │ │  ● parser fix │ │ ┌ route: reliable · k=1 · model: ornith ✓ ┐   │ │ [View diff] │
│  ○ auth spike │ │ └──────────────────────────────────────────────┘ │ │             │
│ ▸ Yesterday   │ │ ▶ tools (4) — edit parser.py ✓ · pytest ✓ 9/9   │ │ [Run]       │
│    └ ⑂ explore│ │ ▶ verification — red→green ✓ · suite ✓          │ │  reliable   │ │    (subagent)│ │ ┌ receipt ──────────────────────────────┐   │ │  k=1        │
│ ▸ Last week   │ │ │ ✓ worked examples 5/5   ✓ focused tests 9/9  │   │ │  model ✓    │
│               │ │ │ ~ no independent oracle — graded "checked"   │   │ │  38s        │
│ [+ New]       │ │ └──────────────────────────────────────────────┘   │ │  12.4k tok  │
│               │ │ Files: parser.py +12−3 · undo ⤺ · redo ⤻ · export│ │             │
│ AGENTS        │ ├────────────────────────────────────────────────┤ │ [Status]    │
│  explore      │ │ ⏳ Working… 41s · turn 3 · 2 files · 9.1k tok    │ │ endpoint ✓  │
│  review       │ │ ▌working on: bash pytest -q                      │ │ llama.cpp   │
│  verify       │ │                                                  │ │ native      │
│               │ ├────────────────────────────────────────────────┤ │ git: main*  │
│               │ │ ⚠ Approval required — risk: medium               │ │ store ✓     │
│ ⚙ settings    │ │ bash: rm -rf build/ && npm run build             │ │ ctx 16k     │
│               │ │ [y] Approve once   [n] Deny   [a] Always ask ▾  │ │             │
├───────────────┴────────────────────────────────────────────────────┴─────────────┤
│ ▸ message kitten…   (/ for commands · @ for files/agents · ↑ history · ⏎ send) │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Components and rules:

- **Transcript cards** (one renderer per event family): user bubble; assistant bubble (streaming
  with the existing dedup; reasoning in `<details>`); route chip (lane, k, reasons on hover,
  model); tool card (collapsible, args+output, auto-open on fail — exists, keep); candidate tree
  (once Phase 5 Stage A emits them: per-candidate status/summary/winner highlight); verification
  timeline (evidence rows with `proves`); receipt card (evidence table + honest grade);
  approval sticky bar (§2.2.3); subagent card (Phase 5 Stage D); run footer (grade · wall ·
  usage · model · undo/redo/retry/export actions).
- **Progress is a first-class surface**: the sticky status strip shows elapsed, turn count, files
  changed, tokens, current activity (latest tool name), tok/s when computable. The mascot
  (existing `catCells`) sits in the strip, state-driven. No silent seconds: if 15s pass with no
  event, the strip pulses "still working — model is thinking" (reasoning models emit long
  thinking phases; honesty about local latency is a product value).
- **Empty states that onboard**: no conversations → hero with mascot, detected endpoint status,
  "try: fix a bug in this project" + example chips; endpoint down → inline doctor card with the
  exact failing check and the fix command (reuse Phase 4 doctor logic via `/api/doctor`).
- **Settings panel** (`⚙`): approval policy (`ask`/`auto-allow`/`auto-deny` — wired to
  `setApprovalPolicy` via new `POST /api/config/approval-policy`), theme, default model/provider
  for new conversations (Phase 1), context window display. No secrets render here — apiKey shows
  "set (env)" / "not set".
- **Inspector**: Changes tab (file list from `file.changed` + full `git diff` view — remove the
  "hidden until `diff.updated`" gate; the diff endpoint works regardless), Run tab (route, lane,
  k, model, verification state, usage, winner when present), Status tab (`/api/status` + doctor
  summary + capabilities from Phase 6).
- **Keyboard**: `/` menu nav, `y`/`n` on focused approval, Esc = stop run → close drawer → close
  menu (existing priority order), Ctrl/Cmd+N new, Ctrl/Cmd+K search, Ctrl/Cmd+E export,
  Ctrl/Cmd+Shift+D changes drawer. Keep existing IME guard, reduced-motion, responsive sidebar.
- **Mobile/narrow**: inspector becomes a bottom drawer; sidebar slide-over (existing behavior
  extended).

**Tests** (this is a string-template UI; test what's testable): server routes for all new
endpoints; command frames round-trip; delete endpoint; export endpoint; approval-policy endpoint;
a jsdom-free DOM test is NOT required — instead, keep all state transitions in pure functions in
`app.js.ts` (`reduceEvent(state, event)`) exported for `node --test` with a tiny DOM stub. New
file `test/web-client-reducer.test.ts` covers: run.completed → footer model, replayed approval →
resolved card, ev.ts timestamps, busy set across conversations, run.status transitions.

**Acceptance:** every TUI command works in the web composer with the same facts; the transcript
of the Phase 4 gauntlet run shows route, tools, verification, receipt, grade, usage, model,
undo/redo/export actions without opening the inspector; a replayed old conversation has zero
actionable approvals and correct timestamps.

---

## PHASE 3 — The Program (.exe like the opencode/Codex apps)

**Goal:** Kitten is a **program** the user installs and launches — not a browser tab they have to
summon. Two delivery stages: an interim zero-dependency `kitten app` (ships in the CLI package),
then the real desktop shell `kitten-desktop` (separate package, thin client over `kitten serve`).

The rule from the invariants: **the desktop shell never embeds the agent core** and adds **zero
dependencies to the CLI package**. The UI it windows is exactly the Phase 2 served interface.

### Task 3.1 — `kitten app` (interim, ships in the CLI package, zero new deps)

**Files:** new `core/app-launch.ts`; `core/kitten.ts` (`app` command); `package.json` `files` +=
`assets/kitten.ico` (generate a simple gold-cat icon; commit the .ico + the source SVG).

Behavior:

1. Ensure a daemon: read `~/.kitten/serve.json`; if a live daemon answers, reuse it; else spawn
   `kitten serve` detached (`child_process.spawn` with `detached: true, stdio: "ignore"`,
   `unref()`), wait for `GET /api/status` 200 (≤5s, poll 100ms).
2. Open a **program window**, not a tab, via app-mode flags:
   - Windows: `msedge --app=http://127.0.0.1:PORT/?token=…` (Edge is guaranteed present); fall
     back to `chrome --app=`, then default browser.
   - macOS: `open -na "Google Chrome" --args --app=…`; Linux: `google-chrome --app=`,
     `chromium --app=`, fallback `xdg-open`.
   - The token travels in the URL only on loopback (already the SSE design); the page must never
     persist it beyond `sessionStorage`. Document in SECURITY.md.
3. `kitten app --install`: create a real launcher so Kitten lives in Start Menu/Desktop:
   - Windows: a `.lnk` via a PowerShell one-liner (`New-Object -ComObject WScript.Shell`) pointing
     at `node …/kitten.js app` (resolve node + script paths at install time — the fix for the
     hardcoded-path sin of `Kitten Web.bat`), icon `assets/kitten.ico`, then delete the four
     untracked repo-root launcher hacks (`Kitten*.bat/.vbs/.ps1`) from the user's workflow by
     superseding them (leave the files; print a note).
   - macOS: a minimal `.app` bundle template (Info.plist + launcher script) written to
     `~/Applications/Kitten.app`. Linux: a freedesktop `.desktop` file in
     `~/.local/share/applications`.
4. No silent anything: `--install` prints exactly what it will write and asks for `y` first
   (respects the no-silent-install invariant).

**Tests** (`test/app-launch.test.ts`): spawn/wait logic against a fake serve; OS dispatch picks
the right opener per platform table; `--install` dry-run prints the exact paths (no writes without
confirmation); serve.json staleness (dead pid) handled.

### Task 3.2 — `kitten-desktop` (the real .exe — separate package)

**Location:** new top-level `desktop/` directory in the monorepo with its **own** `package.json`
(name `kitten-desktop`), its own lockfile, its own CI job. It is **never** a dependency of
`cheater-pi`, and `cheater-pi` never depends on it.

**Stack decision (decided, not open): Tauri v2** (Rust shell + the OS's own webview — WebView2 on
Windows, which is evergreen-preinstalled on Windows 10/11). Why over Electron: ~10MB installer
instead of ~200MB, no bundled Chromium, native menus/tray/notifications, built-in
single-instance and updater plumbing (updater kept **opt-in** per invariants). Why over a
C#/WebView2 one-off: the same shell carries macOS/Linux later with no rewrite. Rust toolchain
lives in the desktop CI job only.

The shell is THIN — its entire job:

```
Kitten Desktop window
┌───────────────────────────────────────────────────────────────┐
│ 🐱 Kitten — <conversation title>        ornith-1.0-35b ✓  ─ □ ✕│  ← native titlebar
├───────────────────────────────────────────────────────────────┤
│                                                               │
│              the Phase 2 served UI, verbatim                  │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│ ● connected to kitten serve (pid 4213, port 4025)   ⚙ tray   │  ← native status strip
└───────────────────────────────────────────────────────────────┘
```

1. **Daemon handshake**: on launch, find or spawn `kitten serve` (same logic as Task 3.1,
   reimplemented in Rust — it is 40 lines, no shared code needed); read the connection file;
   pass the token to the webview via a Tauri `invoke`/init-script handshake — **never** in the
   URL (desktop hardening beyond the browser model), never in logs, window title, or crash
   reports.
2. **Single instance**: second launch focuses the existing window (Tauri plugin).
3. **Tray**: show/focus, active-run indicator (poll `/api/status` quietly — local only), quit
   (asks whether to stop the daemon or leave it running).
4. **Native notifications**: approval-required and run-completed when the window is unfocused
   (subscribe SSE from Rust side or inject; keep it minimal — poll `/api/status` deltas).
5. **Node requirement**: v1 requires Node ≥ 22.5 on PATH — the installer **detects and, with
   consent, opens** the Node download page (no silent installs). v1.1 (later, optional): a
   standalone flavor bundling a Node single-executable build of `kitten` via `node --experimental-sea`
   — spike it only after v1 ships; it's explicitly not required for the milestone.
6. **Installer**: Tauri NSIS for Windows first (`Kitten-Setup-x.y.z.exe`): installs the shell,
   offers the "requires Node" check, creates Start Menu entry with the icon. Code signing:
   unsigned for alpha (documented in RELEASING); signing cert is a maintainer task later.
7. **Auto-update**: OFF. An explicit "Check for updates…" menu item compares the latest GitHub
   Release tag and *prompts*; nothing downloads in the background, ever (invariant).

**Tests:** desktop CI job builds the shell on windows-latest; a smoke step launches it against a
fixture `kitten serve` (a tiny mock server implementing `/api/status` + `/api/stream` is enough)
and asserts the window loads and the token never appears in the process args/logs. These tests
live in `desktop/` and never touch the zero-dep package.

**Acceptance:** on a clean Windows VM with Node installed: run `Kitten-Setup.exe` → launch
"Kitten" from Start → the full Phase 2 UI in its own window → run one prompt end-to-end →
approval notification fires when unfocused → close window, relaunch, conversation restored.

---

## PHASE 4 — Onboarding & the one-prompt gauntlet (Milestone 4, executable)

**Goal:** from download to a verified result with **one prompt and zero bullshit**. This phase is
the user's polish bar made into a process: a fixed manual gauntlet, a friction log, and a rule
that every reproducible friction point becomes a fix + a regression test.

### Task 4.1 — `kitten init` that actually onboards

**Files:** `core/kitten.ts` (`cmdInit` — today it prints hints and calls doctor), new
`core/onboard.ts`, `core/discovery.ts` (reuse), `core/settings.ts` (write path).

Flow (interactive when TTY, `--yes` for defaults, non-TTY = print-only):

1. **Probe endpoints in parallel** (2s each): configured `KITTEN_BASE_URL`, LM Studio
   `:1234/v1`, llama.cpp `:8080/v1`, Ollama `:11434/v1`. Report each: reachable + engine +
   models, or why not.
2. **Recommend, don't decide**: list discovered models with a recommended default (prefer the
   largest instruct/coder model as main; a 1.5–4B as sidecar if present); let the user pick by
   number, Enter accepts the recommendation.
3. **Capability probe** (Phase 6 builds the full version; init stores what it can): engine,
   thinking support, grammar, logprobs, context size → `~/.kitten/capabilities.json`.
4. **Write config**: `~/.kitten/config.json` mode 0600, `{baseUrl, mainModel, sidecarModel,
   provider}`; print exactly what was written and where, plus the one command to change it.
5. **Finish with the next step**: `kitten run "explain this project"` — and if the store has no
   conversations, the TUI/desktop first-run shows this same card (Phase 2 empty state).

Tests: fake endpoints fixture (refused / LM-Studio-shape / llama.cpp-shape / Ollama-shape);
selection logic; config written 0600 with secrets never written; `--yes` non-interactive;
non-TTY prints without writing.

### Task 4.2 — Doctor: full config trace + capability report

**Files:** `core/kitten.ts` (`cmdDoctor`), `core/discovery.ts`.

Doctor output sections: node ≥22.5; store path + writable + migration version; config values with
**their source** (flag/env/project/user/default) and apiKey as set/unset; endpoint classification
(existing: refused/auth/timeout/not-found); ping per configured model (main/sidecar/embed) with
verified/unverified; engine + capabilities summary; git present (undo needs it); active provider
+ other providers (names + baseUrls only). Exit code: 0 healthy, 1 actionable problem (and the
output always ends with the single most important fix command).

### Task 4.3 — The gauntlet (the pasted Milestone 4, mechanized as a checklist)

Create `cheater-pi/GAUNTLET.md` — the manual script, run against a reachable model endpoint
before any release and after any Phase 2/5/6 change:

1. `kitten init` — expect: endpoint auto-detected, config written, zero manual env setup.
2. `kitten doctor` — expect: all green or one exact fix instruction.
3. TUI task involving at least one file edit and a test — expect: live progress strip, tool
   cards, verification evidence, honest grade, usable `/diff`.
4. A follow-up correction — expect: prior-turn context used (proven by ContextBuilder), no
   re-explanation demanded.
5. An approval prompt — expect: exact command, risk, default-if-you-wait, one-key answer,
   visible result of the decision.
6. A cancellation — expect: run marked cancelled, **no hidden work still running** (verify: no
   child processes survive — the tree-kill path — and no candidate workspaces left behind), an
   honest "cancelled, work incomplete" state, working Retry.
7. Resume after restart (close the program entirely, reopen) — expect: full transcript restored,
   correct timestamps, zero actionable stale approvals, follow-up answers from prior context.
8. Undo and redo — expect: only the run's own files move, dirty work preserved both directions,
   clear refusal on drift.
9. Export Markdown — expect: the §2.5 format, opens clean in any markdown viewer.
10. **Repeat steps 3–9 in `kitten web` / the desktop program** — expect: pixel-level parity of
    facts (not layout): same grades, same evidence, same commands available, same approval
    behavior.

Rules (the pasted priorities, as policy): every reproducible friction point found in a gauntlet
run gets an entry in the gauntlet's friction log (date, step, what confused, fix commit, test).
Priority order for fixes: confusing errors → unclear approval state → missing progress feedback →
inability to inspect changes → TUI/web inconsistency → false completion → lost context after
resume → cancellation leaving hidden work. **A release (Phase 7) requires a clean gauntlet with
an empty open-friction list.** And the standing discipline: one successful gauntlet task is never
evidence of general benchmark superiority.

---

## PHASE 5 — Subagents better than opencode's (Milestone 7, in its stated order)

**Goal:** child work that is a first-class, navigable, follow-up-able conversation — verified by
execution before its result reaches the parent. Build order is the milestone's: **first make
completed child work inspectable and follow-up capable; do NOT start with background
implementation agents.**

Where we start (verified): `candidate.*` event types exist but are never emitted; `runs.winner`
is dead; the Pi-world capsule workers are unreachable from the core. opencode's bar (measured):
`task` tool, `@`-mentions, markdown agent files, per-agent model/permission/steps, child-session
navigation, hidden system agents.

### Stage A (Task 5.1) — Make candidate work durable and inspectable

**Files:** `core/runner.ts` (wire hooks), `core/bestofn.ts` (`onSlateEntry` exists — use it),
`core/ascent.ts`, `core/cloudBurst.ts` (per-attempt events currently die in
`BurstAttempt.result.events`), web/TUI renderers.

- Emit `candidate.started / candidate.completed / candidate.rejected` (types already in
  `events.ts:150-167`) from bon and ascent; include per-candidate `usage` in
  `candidate.completed`; set `runs.winner` (Task 0.2 already threads the projection).
- Keep candidate token streams out of the parent transcript (the "interleaving is noise" design
  at `runner.ts:104-105` stands) — candidate cards carry status + summary + usage, expandable to
  the candidate's own event detail.
- Retain candidate workspaces only behind `KITTEN_KEEP_WORKSPACES=1` (debug knob), else delete as
  today; record `snapshot` refs so the winner's diff stays inspectable via existing diff events.
- Tests: k=2 bon run emits exactly 2 started / ≤2 completed|rejected with unique indices across
  repair rounds (the round-local index collision was fixed once — regression-lock it); winner set
  on the run row; usage sums match `run.completed.usage`.

### Stage B (Task 5.2) — Child conversations with stable identity

**Files:** `core/app.ts` (`spawnChild`, `cancelTree`), `core/store` (v3 columns — Task 0.2),
`core/events.ts` (`task.started/completed` — defined in Task 0.2, emitted here).

- `app.spawnChild({parentConversationId, parentRunId, agent, prompt, model?})` → creates a real
  conversation row with `parent_conversation_id`, `parent_run_id`, `agent`, its own title
  (`"<agent>: <prompt excerpt>"`), its own gap-free seq space, and runs it through the SAME
  router/runner machinery (a child is a conversation, not a special case).
- Parent transcript gets `task.started` immediately (the card) and `task.completed` at the end
  (status, one-paragraph summary, **the child's verification grade + evidence lines**, usage,
  deep link). **The parent receives receipts, not prose to trust** — the model-prose-is-not-
  verification invariant applied to delegation.
- **Cancellation**: `app.cancel` on a parent run with live children cancels the whole tree (each
  child marked `cancelled` honestly, its own events intact); cancelling a child alone detaches it
  from the parent's wait (parent gets `task.completed status:"cancelled"`).
- **Usage accounting exactly once (binding rule):** child usage lives ONLY on child runs; the
  parent run records only its own orchestration usage. Anywhere a tree total is shown (web run
  footer, `/usage`), it is **computed at display time** by summing the tree — never stored
  summed. Regression test: a tree of parent+2 children → store totals unchanged by display
  rollups; no run's usage includes another run's.
- **Crash recovery**: the existing interrupted-run machinery already works per conversation — a
  crashed child flips to `interrupted`, the parent's `task.completed` records
  `status:"interrupted"`, and nothing pretends the work completed.
- **Follow-up turns**: a child conversation is openable and continuable like any other
  (submitMessage on it), with its agent's model and system prompt retained (store the agent name
  on the conversation; the runner rebuilds the agent context). This is the milestone's
  "follow-up turns after completion" delivered by construction.
- Sidebar: children nest under the parent (one indent level, `⑂ agent-name`), navigable; the
  parent link is visible in the child's header ("↩ from: fix the off-by-one…").
- Tests (`test/subagents.test.ts`): spawn → child row linked, replayable; parent gets
  started/completed; tree cancel marks all terminal-honestly; usage exactly-once; interrupted
  child recovery; follow-up turn on a completed child runs with the child's model.

### Stage C (Task 5.3) — The `task` tool + agent definitions

**Files:** new `core/agents.ts` (registry + loaders), `core/agent.ts` (tool exposure),
`core/tools.ts` (`task` tool), `~/.kitten/agents/*.md` + `.kitten/agents/*.md` loaders.

Agent definition (markdown with frontmatter — opencode-compatible shape, Kitten semantics):

```markdown
---
description: Read-only codebase exploration; finds files, symbols, call sites
mode: subagent            # primary | subagent | all
model: sidecar            # main | sidecar | explicit id — per-agent model override
temperature: 0.1
steps: 8                  # max agentic iterations before forced summarize
permission:               # may only NARROW the session policy, never widen
  edit: deny
  bash: ask
allowSpawn: false         # recursion: explicit + budgeted or forbidden
hidden: false             # hidden from @-menu, still callable via task
---
You are the explore agent. Answer with exact file:line references…
```

- **Built-ins** (shipped in `core/agents.ts` as strings; overridable by user files):
  `explore` (read-only; deterministic scout briefs from `blueprint/scout.ts` logic injected into
  its capsule — a weak-model superpower opencode's explore doesn't have), `review` (advisory diff
  reviewer; the Pi-world `reviewDiffSidecar` idea promoted to a real agent), `verify` (runs the
  project's tests/build and reports execution evidence only), `general` (full tools, narrowed by
  session policy). Hidden system agents: `title` (sidecar, session naming — replaces the static
  title logic), `compact` (sidecar, Phase 6 context compaction).
- **The `task` tool** in the main agent loop: `task(agent, prompt)` gated by (a) lane policy,
  (b) the session approval policy (spawning a tool-capable child under `ask` requires approval),
  (c) the agent's `permission.task`-style allow-list if configured, (d) the **recursion guard**:
  a child cannot spawn unless its def has `allowSpawn: true` AND depth < `maxSpawnDepth`
  (default 1) AND the run budget (`core/budget.ts`) has room. Violations return a tool error the
  model can read.
- **Capsule doctrine (from the Pi world, kept):** a child's prompt = agent system prompt +
  bounded briefed context (scout slices, contract nouns — byte-budgeted) + the task. **Never the
  parent transcript.** Add the construction test equivalent to the Pi-world capsule test.
- **Child completion contract:** the child run finishes through the SAME finish gates as any run
  (receipts or honest unverified); `task.completed.summary` includes the grade — the parent's
  model sees `verify agent: checked, evidence: …` not `verify agent says it's fine`.
- **Parallel children**: `task` calls in one turn run concurrently with isolated workspaces for
  edit-capable agents (reuse the bon isolation approach) — contested-file conflicts resolve by
  order of completion with the loser's diff presented to the parent for re-application (v1:
  serialize edit-capable children, parallelize read-only ones; note the simplification).
- Tests: agent loading (built-ins + user file + project file precedence); permission can only
  narrow; recursion denied without allowSpawn, denied at depth cap, allowed+budgeted when
  configured; task under `auto-deny` policy never spawns; child prompt contains no parent
  transcript; parallel read-only children both complete.

### Stage D (Task 5.4) — UI + commands

- Transcript **subagent card**: `⑂ explore — ⏳ 12s · finding call sites…` → terminal state with
  grade + summary + `Open ↗`. Click opens the child conversation (same view, breadcrumb back).
- `@`-mention menu in the composer: `@explore where is the router?` → submits a message that
  routes to a forced `task` call (router hint, deterministic, not model discretion).
- `/agents` command: table of agents (name, mode, model, permission summary, source:
  built-in/user/project).
- Sidebar tree (Stage B) + child header badge (`⑂ explore · child of <parent>`).
- **Parity-and-beyond checklist vs opencode** (gauntlet item): task tool ✓, @-mentions ✓,
  markdown agents ✓, per-agent model ✓, permissions ✓, hidden agents ✓, child navigation ✓ —
  plus what opencode lacks: execution-graded child results ✓, deterministic scout briefs ✓,
  sidecar-tier agents on the 2B ✓, durable follow-up-able children ✓, exactly-once usage ✓.

---

## PHASE 6 — The small-model engine (ornith-1.0-35B-A3B + qwen3.5-2B)

**Goal:** squeeze the hardware reality this product actually runs on. Grounded in the repo's own
measured passes (`KITTEN-ASCENT.md`, `LOCAL-INFERENCE-PASS.md`, `KITTEN-COMPARISON.md`) — every
lever below either proved out there or is marked *unmeasured* until the battery says otherwise.
The discipline stands: levers are toggleable internal constants, measured through `kitten run`,
and cut if they don't earn their keep. One successful task proves nothing.

### Task 6.1 — Capability probe (`core/capabilities.ts`)

One probe at init/doctor/first-use, cached in `~/.kitten/capabilities.json` keyed by
`baseUrl + model`: engine (native llama.cpp vs OpenAI proxy — `detectEngine` exists), thinking
support + how to disable (`chat_template_kwargs.enable_thinking:false` — measured win on the
sidecar), grammar/GBNF support, logprobs, context size, slot/cache support (`/props`),
`cache_prompt` behavior. Every consumer uses the **probe-record-never-assume** latch pattern
(a 400 naming a feature marks it unsupported and retries without — already proven in
`providers/localControl.ts`; port the pattern into `core/llm.ts`). Tests: fixture servers for
each capability shape + the fallback ladder.

### Task 6.2 — Tool calls that cannot be malformed (grammar-constrained decoding)

The #1 small-model failure class is malformed tool-call JSON/format. Executor: first read
`core/agent.ts` in full and find the exact tool-call emission/parse point; then:

- On native llama.cpp: wrap the tool-call turn in a **GBNF grammar** matching the harness's
  tool-call envelope (`ChatParams.grammar` exists; `/completion` + grammar exists via
  `complete()`). On proxies: `response_format: json_schema` when the probe says it works.
- Fallback ladder per call: grammar → json_schema → plain + one deterministic repair retry
  ("your last message was not a valid tool call: <parse error>; emit exactly one tool call") →
  count and surface `format_rescues` in the run receipt (honesty: the harness fixed it, say so).
- **Assistant prefill** on tool-call turns via the native `complete()` path (seed the opening of
  the envelope, never the reasoning — the ASCENT pass documented that pre-filling the `def` body
  suppresses reasoning; same physics here).
- Tests: grammar fixture server asserting request bodies carry the grammar; rescue counter
  increments exactly when injected malformed output is repaired; proxy fallback order honored.

### Task 6.3 — Context governor + sidecar compaction (16k ctx is the budget)

**Files:** `core/context.ts` (ContextBuilder), new sidecar jobs in `core/sidecar.ts`.

- Priority-ordered sections with a byte budget from the probe (§6.1): contract/task >
  current-turn evidence > repo truth slices > recent turns > old-turn digests. Lost-in-the-Middle
  placement (`arXiv:2307.03172`, cited in-repo): the contract goes at the START and the
  one-paragraph state summary at the END; never bury acceptance criteria mid-context.
- **Compaction**: when the assembled context exceeds budget, old turns collapse via a sidecar
  `compact` job (qwen3.5-2B, thinking OFF — the measured no-think sidecar win), with a
  deterministic truncation floor if the sidecar is absent (the sidecar doctrine: deterministic
  floor always). Compaction events recorded (`context.compacted` — additive event type) so the
  transcript UI can show "context compacted: 14 turns → digest".
- KV-cache discipline (measured in the capsules pass): stable prefix first, volatile trio last,
  so a stateful endpoint reuses the prefix across turns and across best-of-N samples
  (`cache_prompt` where native). Test: two consecutive assembled prompts share a byte-identical
  prefix of length ≥ system+contract.

### Task 6.4 — Edit-apply cascade + lint/type gate (the opencode portable wins, core edition)

**Files:** `core/tools.ts` (edit), `core/reliable.ts` (finish checks), `core/verificationRunner.ts`.

- Edit cascade (from `KITTEN-COMPARISON.md` portable win #2): exact → whitespace-lenient
  (exists, CRLF-safe since the hardening pass) → **block-anchor** (match on first+last lines) →
  **context-aware** (unique context lines); multiple matches remain an error (correctness beats
  eagerness). On total failure the model gets the anchor feedback, not a bare "no match"
  ("could not locate: nearest anchor at parser.py:41"). Keep the aider-derived insight: lenient
  apply separates "wrong whitespace" (rescue) from "wrong code" (grade strict).
- **Typecheck/lint as a gate, not a hint** (portable win #1): after edits in reliable/ascent
  lanes, if a project check is detectable (`tsc --noEmit`, `pyright`, `ruff` — detect by manifest,
  60s cap, skipped silently when absent), diagnostics on CHANGED files feed the finish gate as
  failing evidence. Advisory in the direct lane (easy tasks stay cheap).
- Per-step time budget (portable win #5): a tool step exceeding the budget (default 120s, same
  number opencode inherits) is killed with a readable timeout error the model can act on.

### Task 6.5 — Sidecar expansion in core

Port the Pi-world scheduler pattern (fire-and-forget, `maxConcurrent: 1`, deterministic floors —
`sidecar/scheduler.ts`) into `core/sidecar.ts`. Jobs (all no-think, all floored): `title`
(session naming — replaces static titles, feeds the sidebar), `compact` (§6.3), `failureCard`
(exists), `editRepair` (malformed edit → applicable edit, assists §6.4), `triage` (router hint —
advisory only, router stays deterministic). Each job records `source: sidecar|deterministic` in
its receipt line. The 2B is fast enough that these run between turns without stalling the main
loop; queue depth 1 keeps the single endpoint sane.

### Task 6.6 — Decode levers, honestly gated

Already built and kept: native forbidden-token decode bans (`constraints.ts`), per-sample sampler
diversity (`attemptSampler`), self-certainty tiebreak (gated to genuine ties), no-think sidecar,
thinking re-enabled on repair turns. New work here is **documentation + measurement plumbing**:

- `docs/LOCAL-SETUP.md`: the recommended `llama-server` launch per GPU class (from
  `LOCAL-INFERENCE-PASS.md`: `-ngl 99 --cpu-moe -c 16384 --no-mmap -fa on --jinja`, slot-save for
  KV reuse), including the **speculative-decoding caution**: on an A3B MoE an external draft can
  net-SLOW decode — prefer server-side MTP; qwen3.5-2B-as-draft is an experiment, not a default.
- `scripts/decode-bench.mjs`: a 3-prompt tok/s probe (plain / cache_prompt / grammar) that
  prints the numbers init can show ("your endpoint: 24 tok/s, prompt cache active").
- Any new decode lever ships OFF behind an internal constant until the battery (run through
  `kitten run`, not the raw Ascent CLI) shows a lift on held-out tasks.

### Task 6.7 — Latency-honest UX

At ~20 tok/s, perceived performance IS the product: the progress strip (§2.6) shows tok/s and
"thinking" states; the router keeps easy tasks at k=1 (exists); the finish of every run states
wall time; long Ascent runs explain themselves ("2 candidates × verification — hard tasks are
slower by design, easy tasks stay fast"). No spinners without state, no silent turns.

**Phase 6 acceptance:** capability probe cached + surfaced in doctor; a native-llama.cpp fixture
run shows zero malformed-tool-call turns (grammar active) or an honest `format_rescues` count;
context governor keeps assembly under budget on a 20-turn conversation (test); edit cascade
rescues a whitespace-drifted edit (test); battery discipline documented — no lever claimed
without a `kitten run` battery line.

---

## PHASE 7 — Release & clean-machine validation (Milestone 5, with teeth)

**Goal:** first public publication, maintainer-controlled, on bytes that were actually tested.
Follow `cheater-pi/RELEASING.md` (commit it first — it is currently untracked) with these
additions forced by verified findings.

### Task 7.1 — Zero production dependencies, for real

The package today depends on `@earendil-works/pi-coding-agent` + `pi-tui` (the legacy
`cheater --pi` path). The invariant says the legacy Pi runtime stays OUTSIDE the production
package. Execute:

- Move the legacy stack (`src/extension.ts`, `src/index.ts` Pi entry, `src/sidecar/`,
  `src/blueprint/`, `src/commitlet/`, `src/runstate/`, `src/reliability/`, `src/providers/`,
  `src/runtime/`, `src/ui/`, `src/autopilot/`, `src/launcher.ts`, `prompts/`, `themes/`,
  Pi-only `skills/`) into `legacy/` **excluded from `files`** and out of the published build, OR
  into a separate private package `cheater-pi-legacy/` in the monorepo. (Decide by whichever
  keeps `npm run build` simplest; the monorepo-private-package option preserves `cheater --pi`
  for maintainers without shipping it.)
- `package.json`: `dependencies: {}` (delete the Pi deps + `peerDependencies` + `pi` block);
  the `cheater` bin becomes a tiny alias that prints "Cheater is now Kitten — run `kitten`" and
  execs the kitten bin.
- Regenerate `package-lock.json` from scratch (the current one is stale: wrong bins, engines,
  dep kinds). CI gains a **zero-dep gate**: a script asserting `dependencies` is empty and
  `npm ls --omit=dev --depth=0` prints nothing.
- Python `cheater/` launcher + `pyproject.toml`: keep version-locked for now (RELEASING already
  treats it conditionally); it gains a deprecation notice pointing at `kitten`.

### Task 7.2 — Rename + version lock

- Check npm name availability for `kitten`; fallback `@kitten-app/kitten`. Rename `name`,
  update bins (keep `cheater` alias), lockfile, README badges, CI.
- `scripts/version-check.mjs` (wired into CI + release): asserts `package.json.version` ==
  `pyproject.toml` version == `CHANGELOG.md` latest heading == the git tag being released ==
  the string printed by `kitten --version` (add a `--version` flag if missing — check first).

### Task 7.3 — The four completion generators (greenfield — none exist)

`kitten completions <bash|zsh|fish|powershell>` prints a completion script to stdout (the
standard pattern; users source it or pipe to the right dir). Generate from the command registry +
flag tables — never hand-maintained lists (drift-proof). CI test: each generator emits a script
containing every canonical command (`run resume conversations undo doctor init web repl app
serve attach completions support export`) and every flag; powershell uses
`Register-ArgumentCompleter`, bash `complete -W`, zsh `#compdef` + `_arguments`, fish
`complete -c`.

### Task 7.4 — Installer + checksums + release workflow

- `install.sh` (POSIX) + `install.ps1`: check Node ≥ 22.5 (exact error + download link, no
  silent installs), `npm install -g <tarball-or-registry>`, run `kitten doctor`, print the
  desktop-program next step. Both served from the GitHub Release, both checksummed.
- New `.github/workflows/release.yml` (tag-triggered, `v*`): typecheck → build → full tests →
  smoke → `npm pack` → **record the tarball sha256** → generate `SHA256SUMS.txt` → create the
  GitHub Release with the tarball + sums + installers → npm publish with **trusted publishing +
  provenance** (the RELEASING.md bootstrap section applies for the first publish). The rule from
  the milestone, enforced structurally: **the checksum, installer, and tarball on the release are
  the same tested bytes** — the smoke job's input is the workflow's packed artifact, and the
  uploaded assets are those exact files (hash asserted in the release step).
- Never an npm token in source, logs, tests, config, or release assets (milestone rule; CI grep
  gate for `npm_` tokens in the repo).

### Task 7.5 — Clean-machine validation (mechanized)

Extend `scripts/pack-smoke.mjs` into `scripts/cleanroom-smoke.mjs` run in a fresh `node:22`
container job with NO repo mount: install the tarball artifact → `kitten init --yes` against a
**fixture provider** (new `scripts/fixtures/mock-openai.mjs` — a 100-line OpenAI-compatible
server serving canned models/responses) → `kitten doctor` green → `kitten run "add two numbers"`
persisted → `kitten resume` replays → `kitten export` produces markdown → all four completion
generators run → `kitten app --install --dry-run` prints paths. Plus the RELEASING.md manual
clean-VM checklist for the first release (a human still walks it).

**Release gates (merged from RELEASING.md + this plan):** typecheck/build/tests/smoke green ·
zero-dep gate · version lock · cleanroom smoke · clean Phase 4 gauntlet with empty friction log ·
signed tag `vX.Y.Z` matching everything · provenance attestation · no tokens anywhere.

---

## PHASE 8 — VS Code extension (Milestone 6, thin client)

**Location:** `editors/vscode/` — own `package.json` (name `kitten-vscode`), own deps (`@types/vscode`,
`vsce` for packaging), own CI job. **Never** a dependency of the CLI package; **never** embeds or
duplicates the agent core — it is a protocol client to `kitten serve` (Phase 0), exactly like the
desktop shell.

Minimum credible scope (the milestone's list, mapped to the serve API):

| Feature | Mechanism |
|---|---|
| Connect to an authenticated daemon | discover `~/.kitten/serve.json` (or `kitten-vscode.server` setting); token in **SecretStorage**; `GET /api/status` handshake |
| List/create/resume sessions | `/api/conversations` endpoints; tree view with children nested (Phase 5) |
| Stream events | `GET /api/stream?conversation=&after=` SSE; replay by durable seq on reconnect |
| Approve/deny | `/api/approve`; native quick-pick + notification with Approve/Deny buttons |
| Attach active file/selection | inserts a bounded context mention into the message — **through the existing bounded context rules** (byte caps, real-path confinement; the server enforces, the extension just sends paths + excerpts) |
| Open changed files and diffs | `file.changed` events → `vscode.window.showTextDocument`; diff via built-in `vscode.diff` against the run snapshot |
| Cancel | `/api/cancel` |
| Reconnect/replay | `after=<lastSeq>` — the server is the ordering authority |

Non-negotiables: daemon tokens never in logs, telemetry (there is no telemetry), output channels,
or webview HTML; the extension's message view renders events it fetches — it does NOT iframe the
served UI (that would couple versions) and does NOT reimplement routing/grading logic (that would
duplicate the core). Test independently: extension-host integration tests against the fixture
mock server (`scripts/fixtures/mock-openai.mjs` + a fixture serve), run in its own CI job.

---

## Cross-cutting requirements

### Security updates (fold into `cheater-pi/SECURITY.md`)

- `~/.kitten/serve.json` mode 0600; token lifecycle (per-daemon, regenerated per launch);
  `kitten attach --token` never echoes the token to logs.
- Desktop: token passed via init-script handshake, never URL; webview denies navigation off
  loopback; no remote content.
- Served UI: add `content-security-policy: default-src 'self'; style-src 'self' 'unsafe-inline'`
  and `x-frame-options: DENY` headers (verified absent today) — assert in a server test.
- Input history table stores text only — no event payloads, no tool args.

### Event/migration registry discipline

- New event types: additive only; `EVENT_SCHEMA_VERSION` stays 1 until a breaking change (none
  planned); every renderer must tolerate unknown types (regression test from Task 0.2).
- Migrations: append-only; v3 (Task 0.2), v4 reserved for `input_history` (Task 2.3) — fold into
  v3 if Phase 2 lands before any release; never edit shipped migrations.

### Docs to update at each phase end

`KITTEN-PRODUCT.md` status table · `cheater-pi/README.md` (commands, precedence chain, desktop
install) · root `README.md` quick start (desktop-first) · `cheater-pi/SECURITY.md` ·
`cheater-pi/CHANGELOG.md` per release · new: `docs/SERVE-PROTOCOL.md` (endpoint + SSE contract
for third-party clients — the VS Code extension's bible), `docs/LOCAL-SETUP.md`,
`cheater-pi/GAUNTLET.md`.

### Milestone mapping (the handed-down numbering → this plan)

| Handed-down milestone | Where it lives here |
|---|---|
| `/model` spec + acceptance criteria | Phase 1 (+ Phase 0.4 fixes) |
| Milestone 4 — real-user workflow polish | Phase 4 (gauntlet) + Phase 2 (the friction it will find) |
| Milestone 5 — release & clean-machine | Phase 7 |
| Milestone 6 — competitive IDE client | Phase 8 |
| Milestone 7 — independent subagent history | Phase 5 (stages A→D, its order preserved) |
| Product invariants | §0.2 (extended, binding) |
| "Web UI is THE interface, ALL / commands" | Phase 2 (+ 0.3 command layer) |
| "A PROGRAM .exe like opencode/codex app" | Phase 3 |
| "One prompt, zero bullshit" | Phase 4 + §2.6 progress surfaces |
| "Better subagents than opencode" | Phase 5 (parity checklist + Kitten-only deltas) |
| "Tuned for ornith-35B-A3B + qwen3.5-2B" | Phase 6 |

### Master acceptance list (the whole plan in one screen)

1. `kitten serve` + `attach` + cross-client approvals; crash never lies about run state.
2. Store v3 migrated; run rows carry effective model/agent/winner; unknown events tolerated.
3. Every `/` command works identically in TUI, web, and desktop; `/mode`/`/k` accepted by the
   server; input history shared.
4. `/model` validated (discovery → ping → unverified-marked); cross-provider error names the
   owning provider; no silent provider/endpoint/credential/policy changes (deep-equality test);
   resume uses the recorded model; `--model -c` errors loudly; precedence chain documented.
5. Web UI renders everything the event stream knows: grades, receipts, usage, tools,
   verification, candidates, approvals that can't lie, real timestamps, real delete, busy
   everywhere, progress always.
6. `/undo` and `/redo` round-trip safely with drift guards; `/export` produces clean markdown
   from any conversation including cancelled runs.
7. `kitten app` opens a program window today; `Kitten-Setup.exe` installs the desktop shell on a
   clean Windows VM; token never in URL/logs on desktop.
8. `kitten init` onboards with zero env knowledge; doctor gives one exact fix; the 10-step
   gauntlet runs clean in TUI and desktop with an empty friction log.
9. Subagents: candidates durable; children are real linked conversations, inspectable,
   follow-up-able, tree-cancelled, usage exactly-once, recursion explicitly gated; `task` tool +
   markdown agents + @-mentions; opencode parity checklist + the five Kitten-only deltas.
10. Grammar-constrained tool calls on native llama.cpp; capability probe cached; context
    governor + sidecar compaction; edit cascade; typecheck gate; latency-honest UX; no lever
    claimed unmeasured.
11. Release: zero production deps (CI gate), renamed package, version lock, four completions,
    installer + checksums of the tested bytes, trusted publishing, cleanroom smoke green.
12. VS Code extension connects, lists, streams, approves, attaches selection, opens diffs,
    cancels, replays by seq — with tokens in SecretStorage and zero core code.

### Suggested execution order (one line)

**0.1 → 0.2 → 0.3 → 0.4 → 1.1 → 1.2 → 1.3 → 1.4 → 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 →
4.1 → 4.2 → 3.1 → 3.2 → 4.3 (gauntlet #1) → 5.1 → 5.2 → 5.3 → 5.4 → 6.1 → 6.3 → 6.5 →
6.2 → 6.4 → 6.6 → 6.7 → 4.3 (gauntlet #2) → 7.1 → 7.2 → 7.3 → 7.4 → 7.5 → 8.**

(4.1/4.2 early because onboarding fixes make every later gauntlet run cheaper; 3.1 before 3.2
because the CLI app-mode window delivers "a program" weeks before the Tauri shell; gauntlet runs
twice — once after the interface exists, once before release.)

*Plan written against the verified state of branch `kitten-hardening`, July 2026. If a fact here
has drifted, re-verify against code and keep the intent.*
