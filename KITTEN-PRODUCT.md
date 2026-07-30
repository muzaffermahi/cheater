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

## Tests

Core and desktop-engine tests: **912 green**.

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
  local pipe and requires a successful health response before the archive is produced.
