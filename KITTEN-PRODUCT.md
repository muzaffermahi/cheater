# Kitten — product unification build

ONE local-first coding product per KITTEN-PLAN.md. This doc tracks what has actually landed.

## Canonical architecture

```
Kitten application core (cheater-pi/src/core/, Pi-free)
  ├── events.ts          versioned event model (+ run.started model, run.completed model,
  │                      tool.approval_resolved, run.redone, task.started, task.completed)
  ├── store/             durable SQLite (v3 migration: model, agent, parent links, provider,
  │                      snapshot_after, undone, input_history)
  ├── router.ts          adaptive lane router
  ├── runner.ts          lane → engine with model identity threading
  ├── undo.ts            git-snapshot rollback + redo
  ├── commands.ts        ONE shared command registry (TUI + web + headless)
  ├── client.ts          KittenClient abstraction (LocalClient / RemoteClient)
  ├── discovery.ts       model discovery + validation (listModels, ping, cross-provider check)
  ├── modelCatalog.ts    verified catalog parsing + resumable checksum downloads
  ├── modelBenchmark.ts  bounded responsiveness + sandboxed coding/project probes
  ├── modelProfiles.ts   hardware-aware 35B–200B / 2B–9B tier guidance
  ├── providers.ts       multi-provider registry (local, llamacpp, alibaba with env-backed keys)
  ├── agents.ts          agent definitions (explore, review, verify, general, title, compact)
  ├── capabilities.ts    capability probe (engine, grammar, logprobs, context, cache_prompt)
  ├── sidecar.ts         sidecar scheduler (title, compact, failureCard, triage, editRepair)
  ├── sidecarControlPlane.ts + sidecarJobs.ts
  │                      prioritized validated catalog, deterministic floors, workflow packs, cancellation
  ├── taskGraph.ts       durable dependency-aware subagent DAGs, bounded handoffs, resume and adaptive fan-out
  ├── workspaceIndex.ts  persisted file/symbol/import/test intelligence for native orientation and verification
  ├── desktopEngine.ts   native IPC engine, model lifecycle, bakeoff, postflight, and recovery commands
  ├── app-launch.ts      native desktop launcher (no browser fallback)
  ├── desktop/Installer    native GUI installer + Start Menu shortcut
  ├── export.ts          conversation → Markdown export
  ├── support.ts         diagnostic bundle (redacted secrets)
  ├── serve.ts           reusable createKittenServer (used by kitten serve + kitten web)
  ├── mascot.ts          pixel-cat
  ├── app.ts             KittenApp service with redo and model identity
  ├── kitten.ts          canonical `kitten` (run, serve, attach, app, export, completions, support)
  ├── tui.ts             streaming TUI + remote attach mode
  └── web/               served UI over SSE with /api/commands and /api/models
```

## Commands

| Command | Status |
|---|---|
| `kitten` | maintainer compatibility CLI (not the supported user surface) |
| `kitten run "<task>"` | route → execute → persist → stream |
| `kitten resume [id]` | replay stored conversation |
| `kitten conversations` / `ls` | list conversations |
| `kitten undo [id]` | git-backed rollback |
| `kitten redo` | re-apply undone run |
| `kitten doctor` | environment + endpoint checks |
| `kitten init` | first-time setup |
| `kitten web` | legacy/debug web UI (maintainer-only; never shipped in the native bundle) |
| `kitten serve` | daemon mode (writes ~/.kitten/serve.json) |
| `kitten attach` | TUI connected to a running daemon |
| `kitten app` | native Avalonia program window (the supported product surface) |
| `kitten export [id]` | conversation → Markdown |
| `kitten support` | diagnostic bundle (secrets redacted) |
| `kitten completions <shell>` | shell completions (bash/zsh/fish/powershell) |
| `kitten help` | this help |

## Phase status (from KITTEN-PLAN.md)

| Phase | State |
|---|---|
| **0 — Foundations** (serve, attach, store v3, commands, model bugs) | ✅ landed |
| **1 — Model & provider** (discovery, /model, providers, support) | ✅ landed |
| **2 — The Interface** (commands registry, /redo, /export, web API endpoints) | ✅ landed |
| **3 — The Program** (native app-launch, hidden local engine, installer) | ✅ landed |
| **4 — Onboarding** (init improvements, gauntlet skeleton) | ✅ native model/runtime setup + health/bakeoff probes |
| **5 — Subagents** (agent definitions, task tool foundation) | ✅ landed |
| **6 — Small-model engine** (capability probe, sidecar, grammar-ready) | ✅ landed |
| **7 — Release** (completions, export, zero-dependency package gate) | ✅ landed |
| **8 — VS Code extension** | ⬜ not started |

## Native-era correctness sweep (July 30, 2026)

The modules the native product is built on — `desktopEngine`, `taskGraph`, `sidecar*`, `model*`,
`workspace*` — were written at high velocity and had never been through a correctness pass. Six
defects were found and fixed with regression tests; each one violated a stated invariant.

| Defect | Invariant it broke | Fix |
|---|---|---|
| The engine's local socket had **no authentication**: any process running as this user could `conversation.submit` into any directory (file writes + shell), repoint `baseUrl` at a collecting endpoint via `settings.update`, or passively receive the whole event stream — prompts, output, diffs. The pipe name was predictable and every socket joined the broadcast set before sending a byte. | KITTEN-PLAN §2 specified "a random per-launch handshake secret"; never implemented | per-launch 24-byte token published with the socket path to `<kittenHome>/engine.json` (0600, withdrawn on close). Nothing is served — not liveness, above all not events — before a valid `hello`; a wrong token or an idle deadline closes the connection |
| `app.recover()` ran **before** the socket bind, so a second launch (which then loses the bind) flipped the live instance's in-flight runs to `interrupted` in the shared store | "crash never lies about run state" | recovery runs only after the bind; the bind is the single-instance lock |
| A lost bind also leaked the open store handle + event subscription (on Windows the `.db` stayed locked) | — | the failure path closes both before rethrowing |
| **Stop on a sidecar workflow** only cancelled the step in flight. A Stop during the initial index warm, or between steps, was dropped and every remaining step ran | "cancellation that leaves hidden work running is release-blocking" | one pack-wide cancellation flag registered before the first await; the result reports `cancelled`/`completedSteps` honestly |
| `read`/`write`/`edit` **left the project root** whenever a task had no allow-list (the common case): `../../anything` and bare absolute paths were accepted. Matching was lexical and case-sensitive, so a symlink/junction widened the root and `Secrets/` slipped past a `secrets` forbid entry | §0.2 "lexical- and real-path confined"; symlink/junction escape is always-block. `realpathSync` appeared nowhere in src | the project root is an absolute first gate for every tool path, resolved through the nearest existing ancestor, case-folded where the filesystem folds |
| A **model download that broke once stayed broken**: any `.part` was resumed with no record of which artifact produced it, and a checksum failure left the bad partial in place, so every retry appended to bytes that could never verify | "no silent downloads or installs" implies a recoverable one | partials are claimed (id/URL/hash sidecar) and resumed only on a match; a proven-bad partial is discarded and the error says so |

An `ok:true` frame with an undefined result also serialized without the field, which a typed client
reads as a hard failure; success frames now always carry `result`.

The release smoke gate additionally asserts that an unauthenticated client is **refused**, so an open
engine fails the release rather than shipping. `.github/workflows/desktop.yml` restores the compile
gate for the C# shell (`-warnaserror`) plus the bundle + IPC smoke, because no Node test can catch a
break in the native shell.

## Native workbench

The app is the product, so it was rebuilt and then reviewed by rendering it, not by trusting that it
compiled. `Kitten.Desktop.exe --snapshot <png> [--palette] [--view <name>] [--task "<prompt>"]` lays the
real window out against the real engine, writes a PNG and exits — every screen, including a live run in
flight, is reviewable without a human at the mouse (and pinnable in CI).

**Shell.** Three regions and a status line: sessions, the conversation, what the run produced.
Everything else — models, runtimes, benchmarks, agents, workspace tools, exports — sits behind Ctrl+K
in one searchable command palette, replacing the twenty-two-button left rail. `App.axaml` carries the
design tokens (surfaces, borders, text, one accent, ok/warn/error) and control styles, so surfaces stop
drifting into hand-picked hex. Approvals appear next to the conversation that raised them and are
hidden otherwise. The transcript is bottom-anchored, like a conversation.

**The transcript** renders each turn as a card (prose/fenced-code split, monospaced scrollable code,
per-block selection) and each tool call as a compact step — `read stats.py`, `edit stats.py`,
`bash python -c …` with duration and output preview. `tool.completed` carries a `target` for this. A
card opens as "thinking…" because a local 35B needs half a minute before its first token; a turn that
only called tools leaves no empty card behind. Kitten's own notes are labelled as harness output.

**Honest state.** Every panel describes the current run: EVIDENCE shows that run's receipt (replayed
sessions included), CHANGES the files it touched, and stopped/interrupted runs say so in the history
instead of leaving a prompt with no answer. Durations read "1m 53s". The status line is one line, with
the detail on hover.

**Secondary surfaces** were each rendered and repaired: model settings no longer clips its fields and
docks Save; change review filters Kitten's own `.cheater/` cache and colours the diff; the task board
describes the DAG instead of printing `[]`; the file browser lists the project on open via
`workspace.files`; the agent library docks its actions.

Still open: an inline diff in the inspector (it is a separate window today), a subagent tree view, and
a guided first-run wizard.

## Tests

Core and desktop-engine tests: **928 green** (912 at the start of this pass).

The native Agent library includes seven additional sidecar specialists (`architect`, `security`,
`debug`, `test`, `release`, `docs`, and `performance`) with bounded permissions and durable
child-conversation routing.
All offline/deterministic — no model endpoint needed.

## Key design decisions

- **One command registry** (`core/commands.ts`) used by TUI, web, and headless
- **One client abstraction** (`core/client.ts`) with LocalClient and RemoteClient
- **Model identity tracked on every run** (run.started.model, run.completed.model)
- **Provider switching** never mutates existing conversations (deep-equality test)
- **Sidecar jobs** prioritized queue, deterministic floor, no-think, validated JSON, workflow packs, and cancellation
- **Cancellation is authoritative**: stale results arriving after Stop are discarded even when a local
  runtime ignores the abort signal; only deadline expiry may take the deterministic fallback.
- **Sidecar-backed planning** feeds the bounded orientation packet into native read-only and editable
  subagent DAGs; deterministic plans remain available when the small endpoint is offline.
- **Native task recovery** resumes only incomplete DAG nodes and preserves completed reports/evidence.
- **Shared endpoint safety** serializes main/sidecar requests process-wide when they target the same local URL;
  dedicated endpoints remain concurrent.
- **Model bakeoff** combines isolated coding and held-out multi-file project signals, saves a local report,
  and supports native cancellation.
- **Tier contract** is enforced consistently: known-size main candidates must be 35B-200B and known-size
  sidecars 2B-9B across selection, health, bakeoff, and managed-runtime recovery; unknown-size IDs remain
  explicitly marked unknown rather than guessed.
- **Native workspace continuity** keeps project context attached to durable conversations and exposes a
  one-click New task action, so users do not reopen the folder picker for every task.
- **Managed runtime recovery** remembers configured llama.cpp paths and performs a bounded startup
  probe/restart without preventing the native shell from opening when the runtime is unavailable.
- **Automatic postflight** also persists bounded risk classification and generated edge-case
  checklists alongside the sidecar's diff, secret, evidence, test, and command receipts.
- **Capabilities cached** in ~/.kitten/capabilities.json (1-hour TTL)
- **Secrets always env-backed**, never in store, logs, or webview
- **Production npm surface is zero-dependency**: legacy Pi packages remain dev-only, `cheater` is a
  thin Kitten forwarder, and the packed files allow-list excludes legacy launchers and Pi UI assets.
- **Native release closure**: the Windows bundle keeps only the static import closure of
  `desktopEngine.js`; runtime114 is 65 files with no declaration-only or maintainer CLI/TUI/browser
  modules. Known-size model IDs are enforced at every native configuration, launch, download, and
  conversation entry point (35B–200B main, 2B–9B sidecar).
- **Native onboarding**: Model setup can probe common local loopback endpoints in parallel and
  populate tier-compatible advertised model suggestions; the composer accepts `@agent objective`
  for direct durable specialist sessions.
- **Native IPC smoke gate**: release packaging launches the bundled hidden engine with an isolated
  local pipe and requires a successful health response before the archive is produced — and requires
  that an unauthenticated client is refused first.
- **The engine channel is authenticated**: the local socket carries a per-launch handshake token
  published to `<kittenHome>/engine.json` (0600). It is not a formality — that channel can write files
  and run commands, so an unauthenticated peer is told nothing but "unauthorized" and disconnected.
