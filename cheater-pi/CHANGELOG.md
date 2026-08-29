# Changelog

All notable changes to Kitten are recorded here. Dates are ISO (UTC). This is an **alpha / technical
preview** — expect rough edges and breaking changes between preview releases.

## [0.7.3] — 2026-08-01

Fixes earned by a 30-task bakeoff against opencode (both agents on the same local ornith-1.0-35B,
hidden behaviour oracles). Kitten 24/30, opencode 0/30 — and Kitten's six failures paid for the list
below.

### Fixed
- **`bash` runs a real POSIX shell on Windows.** `spawn(..., {shell: true})` resolved to `cmd.exe`,
  so every `ls`, `pwd`, `cat` and `grep` a POSIX-trained model reaches for failed on the product's
  primary platform. Git for Windows' bash is used instead, resolved from `git --exec-path` with
  `KITTEN_SHELL` as an override. WSL launchers (`System32ash.exe`, the WindowsApps stub) are
  refused even when named explicitly — they run in a filesystem namespace where the workspace path
  does not exist.
- **An interrupted ascent run keeps its work.** Candidates live in isolated workspaces and the winner
  was adopted only at the very end, so a kill discarded everything — one bakeoff task ran fifteen
  minutes and left an empty folder. Finished candidates are now checkpointed to
  `.kitten-candidates/`, and cleared once the winner is adopted. Deliberately a copy *beside* the
  work, never a provisional adoption: adoption clears `cwd`, so adopting early would replace the
  user's own files with a candidate that never won.
- **The effort ceiling is a real deadline, on every lane.** It was set only on the ascent branch, and
  even there the budget governor checked the clock only *between* rounds — nothing bounded a
  candidate in flight, and a Balanced run (10 min) went 900 s. A timer-backed abort signal now binds
  every lane, and a ceilinged run says so instead of looking like the model gave up.
- **A transient runtime 500 is retried** (failed slot, GC pause) instead of ending the run, while a
  500 reporting that the server could not parse the model's *own* tool call fails fast — an
  identical resend reproduces it, and the guided "write it in smaller pieces" retry one level up is
  what actually fixes it.
- **A rejected tool call says which argument and why.** The transcript showed only
  `bad args for write`; it now carries the parse error and payload size, and an oversized payload
  gets advice the model can act on.

## [0.7.0] — Unreleased Kitten product (technical preview)

The unification of the split Cheater / Kitten / Ascent code into one local-first product, `kitten`,
built on a single shared application core.

### Added
- **Native diagnostics export** — the hidden desktop engine now exposes an asynchronous, redacted
  support bundle and the Avalonia shell saves it with a native file picker. Engine detection is
  recorded accurately instead of serializing a pending promise; URL credentials and query-string
  secrets are stripped before the bundle leaves the app.
- **Explicit native-only release manifest** — `kitten-manifest.json` now carries both
  `nativeOnly: true` and `browserFallback: false`, matching the installer release metadata.
- **Native workspace continuity** — the shell now has a one-click **New task** action that creates a
  durable conversation in the active project without forcing the user through the folder picker again.
- **Engine recovery hardening** — a broken native pipe now tears down a still-live stale child before
  Retry engine, preventing reconnect attempts from attaching to an orphaned process.
- **Conversation search** — the native shell can filter durable sessions in place while preserving the
  same local store and project context.
- **Local-runtime readiness retry** — chat and streaming requests retry bounded transient load/gateway
  responses inside their existing timeout, while configuration errors still fail immediately.
- **Native layout hardening** — model setup, health, probe, and bakeoff actions are arranged in bounded
  sidebar rows so none are clipped by the compact workspace column.
- **Scrollable setup dialog** — all runtime/model fields and Save/Cancel controls remain reachable on
  smaller displays and at normal Windows scaling.
- **Responsive prompt controls** — the native minimum-size window now keeps Plan, Implement, Run, and
  Stop actions visible in a two-row grid instead of allowing the action strip to overflow.
- **Scrollable workspace sidebar** — the project, model, and conversation sections no longer disappear
  below the fold at the default window height.
- **Comparative local bakeoff** — Full bakeoff now discovers advertised 35B–200B and 2B–9B candidates,
  compares up to three per tier with the isolated coding/project batteries, and retains the configured
  pair as a safe fallback when discovery is unavailable. Native requests allow up to 90 seconds so
  slower large local models are not unfairly rejected by a short desktop timeout.
- **Adaptive sidecar fan-out** — shared endpoints remain serialized for stability, while a dedicated
  project sidecar endpoint can run up to three bounded clerical jobs concurrently; switching settings
  or projects reconfigures the control plane automatically.
- **Honest model health states** - native recovery now distinguishes a responding model, a slow/loading
  local model, and an unavailable model, so a large model warming up is not mislabeled as invalid.
- **Expanded sidecar workflow packs** - the native toolbox now includes refactor planning, test
  hardening, and dependency/security audit workflows in addition to intake, review, triage, and release.
- **Live bakeoff progress** - long local-model probes now report tier, model, task, pass/fail, and
  timing progress to the native activity panel while remaining cancellable.
- **Context-window-aware history** - the configured 4k-131k model window now controls the durable
  conversation preamble budget; larger local coding models get more relevant history without
  crowding small-model outputs and tool results.
- **Persistent model guidance** - the native model status surface now restores the newest bakeoff
  recommendations after restart, keeping hardware guidance and measured local quality side by side.
- **Specialist sidecar agent library** - the native Agent library now ships bounded `architect`,
  `security`, `debug`, `test`, `release`, `docs`, and `performance` profiles alongside
  explore/review/verify. Each role is
  explicitly sidecar-backed, permission-scoped, and routed through the direct tool lane so it can
  produce durable, inspectable evidence without gaining write access.
- **Intent-aware sidecar plans** - read-only planning now deterministically selects the matching
  specialist for security, failure/debugging, testing, release, and architecture requests, while
  retaining the generic review path for ordinary work. The selected role remains bounded and visible
  in the task graph before any main-model edit is authorized.
- **Visible subagent lineage** - the native conversation picker now labels child sessions with their
  agent role and parent branch marker, making durable sidecar reports easy to reopen and inspect.
- **Readable Agent Library** - role cards now show purpose, model tier, mode, step budget, source,
  and permissions directly in the native dialog instead of exposing raw configuration JSON.
- **Strict native payload allow-list** - the packaged engine now strips maintainer-only CLI, slash
  command, terminal, TUI, REPL, and browser entry points, keeps only the static desktop-engine import
  closure, and fails closed if any forbidden path is reintroduced. The runtime109 release contains
  66 files (60 runtime modules, no declaration-only compatibility files) with zero forbidden surface paths.
- **Managed runtime auto-recovery** - a configured local llama.cpp executable/model pair is probed and
  restarted automatically when the native engine opens, while injected fixtures and already-responsive
  external endpoints are left alone; failures remain recoverable from Model setup instead of blocking app launch.
- **Project runtime handoff** - selecting a conversation now performs the same bounded runtime ensure
  for that project, so project-local model paths recover when the user opens a project after Kitten has
  already started.
- **Strict tier enforcement** - model selection, bakeoff candidate discovery, health recommendations,
  managed runtime start, and project runtime recovery now agree on 35B-200B for main and 2B-9B for
  sidecar; unknown-size IDs remain allowed but are never silently classified as a fit.
- **Tier contract closes every native entry point** - settings writes, conversation creation, catalog
  downloads, and automatic runtime recovery now reject known-size models outside their lane; settings
  inspection reports persisted mismatches so setup can repair them explicitly.
- **Native onboarding and specialist mentions** - Model setup scans common local endpoints in parallel
  and recommends tier-compatible advertised models; the composer now accepts `@agent objective` to
  launch the same durable, cancellable child-session path as the Agent Library.
- **Runtime111 artifact** - refreshed native-only package after the onboarding, specialist, and inference-resilience pass: 66 files, 60 runtime
  modules, zero declarations/forbidden surface paths; SHA-256
  `CB15BB87030B5B5C89FBDF9B8B42481BD8E34044697BE94717DC71B2779CBFC1`.
- **Runtime114 artifact** - refreshed native-only package with the corrected static closure (including
  the shared augmentation runtime) and a process-level IPC smoke gate that must receive a ready
  health response before release packaging succeeds: 65 files, 61 runtime modules, zero
  declarations/forbidden surface paths. Candidate lifecycle cards are now emitted for Ascent and
  best-of-N runs. SHA-256:
  `DF3AACE96927CB6244FB73AFF166A132E4C9C528165FA040B409B1BD84167873`.
- **One canonical application core** (`src/core/`, Pi-free): a versioned event model, a durable
  `node:sqlite` conversation/event/run store with migrations and crash recovery, and a `KittenApp`
  service that routes → executes → persists → broadcasts every state change.
- **`kitten` terminal UI** — a streaming, event-driven TUI with the pixel-cat mascot, slash commands,
  a conversation picker, resume with full history, interactive approvals, cancellation, and `/undo`.
- **`kitten web`** — a local (127.0.0.1) web UI over the same core and store: streamed runs over SSE
  with reconnect + replay, approvals, diffs, conversation search, and the mascot. Token-authenticated.
- **`kitten run` / `resume` / `conversations` / `undo` / `doctor`** — a stable headless surface; every
  run is persisted and resumable.
- **Adaptive router** — answer-only / reliable / Ascent chosen from deterministic evidence; easy tasks
  stay on `k=1`, only genuinely hard/risky/ambiguous/large-build tasks pay best-of-N.
- **Safety model** — a hard floor blocking catastrophic / remote-code-execution / secret-exfiltration
  shell commands in every lane, plus an approval policy (`ask` / `auto-allow` / `auto-deny`).
- **`/undo`** — git-snapshot rollback of a run's own file changes, preserving pre-existing dirty work.
- Packaging: `LICENSE` (MIT), repository metadata, an npm `files` allowlist, and a packed-install
  smoke test (`npm run smoke`).
- **Native Kitten desktop app** for Windows: a browser-free Avalonia shell with a hidden local IPC
  engine, managed main/sidecar runtimes, durable subagent conversations, task board, approvals,
  cancellation, model downloads, agent library, workspace explorer, change review, export, and
  interrupted-run recovery. Workspace indexes persist per project in `.cheater/workspace-index.json`.
- **Automatic sidecar orientation** on native submissions: the small model (or its deterministic
  floor) classifies the task, ranks bounded candidate files, and extracts explicit requirements before
  the main model starts. Each job has a short deadline and cannot authorize edits or invent paths.
- **Automatic sidecar postflight** after file-changing runs: bounded diff review, secret-pattern
  detection, evidence notes, relevant test selection, and likely verification commands are surfaced in
  the native Evidence pane as advisory findings.
- Postflight now also persists risk level/reasons and generated edge-case checklists, with deterministic
  floors when the sidecar is absent or unavailable.
- **Native verification button** executes only the suggested test/build allow-list in hidden non-shell
  processes with capped output, timeouts, and durable pass/fail receipts; unsafe commands are rejected.
  Verification can be cancelled from the same native pane, with process-tree termination and an honest
  cancelled receipt.
- **Native sidecar continuation loop** now adds bounded history compaction for long conversations and
  a persisted advisory failure card (severity, signature, likely cause, and salient error lines) after
  failed runs; neither can alter the execution grade.
- **Native coding-quality probe** runs three deterministic pure-function tasks for the main and sidecar
  tiers inside a restricted VM sandbox, persists pass/fail receipts, and keeps the result explicitly
  separate from the responsiveness benchmark and any claim of general coding quality.
- Added a native **Project probe** with two held-out multi-file tasks, an in-memory CommonJS loader,
  hidden cases, traversal/builtin rejection, and per-module VM timeouts; generated files never touch the
  selected workspace.
- Hardened sidecar cancellation so a runtime that ignores abort signals cannot publish a stale success;
  deadlines still fall back deterministically and user cancellation remains a rejected job.
- Native task planning now threads its parent cancellation ID through sidecar orientation, so Stop works
  before a plan is persisted as well as during subagent execution.
- Coding probes now time out per model task, invoke generated functions inside the VM timeout, avoid
  retry amplification on sidecar network timeouts, and can distinguish an advertised-but-unloaded model
  from one that actually answers a validation ping.
- Native **Model health/recovery** scans a bounded set of local candidates, reports response latency and
  conservative tier fit, and offers explicit same-tier selection when a configured model is unloaded;
  it never silently changes the main 35B+ or sidecar 2B-9B choice.
- The sidecar now works on a shared endpoint when no second runtime is configured (serialized through the
  control plane), exposes four native workflow packs, and supports direct durable subagent spawning from
  the Agent library with cancellation.
- Foreground orientation is now a single validated `orient_task` pass with an 8-second bounded deadline,
  making real 2B sidecars usable on local runtimes that need a few seconds to load or emit JSON.
- Dependent subagent nodes now receive bounded predecessor reports/evidence as explicit handoffs; the
  parent transcript remains excluded, but review and verification workers no longer start blind.

### Preserved
- The Ascent reliability engine (execution consensus, worked-example eligibility, repair resampling,
  adaptive `k`, the disjointness firewall, owned decode controls, honest receipts) — now reachable as
  the adaptive default rather than only from a benchmark CLI.
- Independent sidecar scouts now fan out in durable task plans while main-model workers remain serialized;
  the graph records the adaptive concurrency policy and preserves bounded dependency handoffs.
- The native model panel now includes a full local bakeoff combining isolated coding and held-out
  multi-file project signals, with transparent per-tier recommendations, a saved report, and native
  cancellation for long local runs. The native panel can explicitly apply reviewed winners to project
  settings with confirmation; model changes are never silent.
- Known parameter-count mismatches are now blocked when selecting a model for the wrong tier (main
  35B–200B, sidecar 2B–9B), with an explicit diagnostic override for unusual naming/fixtures.
- Shared main/sidecar endpoints now have an endpoint-level request gate: foreground generations and
  clerical calls cannot collide, while queued cancellation remains immediate; the gate is process-wide
  so project-local runtime clients cannot bypass it.
- The native task board can now resume cancelled/interrupted plans, rerunning only incomplete nodes while
  preserving completed dependency reports and evidence.
- The existing unit/fixture suite plus new spine/UI/safety/native tests (900 green).

### Compatibility
- `cheater` remains as a compatibility alias during migration.
- Minimum Node is now **22.5** (for the built-in `node:sqlite`).

---

## Polished UI release (pre-v0.8.0)

### Web UI
- **Markdown overhaul** — headings, lists, blockquotes, links, horizontal rules, paragraph breaks, and
  code blocks with language badges and copy buttons.
- **Syntax highlighting** — keyword coloring for 17 languages in code blocks.
- **Inline rename** — a styled input replaces the browser `window.prompt()` dialog.
- **Typing indicator** — animated dots while the model generates.
- **Message timestamps** — relative timestamps on every message bubble.
- **Keyboard shortcuts** — `Ctrl+N` new conversation, `Ctrl+K` focus search, `Ctrl+L` focus input,
  `Escape` stop during active run.
- **Favicon**, **jump-to-bottom** button, **offline banner debounce** (no false flicker), **conversation
  delete**, **retry/regenerate**, **model badge**, **SVG icons** replacing Unicode characters.
- **Approval buttons** now disable during API call to prevent double-sends.

### TUI
- **Live status line** with mascot face, elapsed time, turn count, and files changed during runs —
  updates in-place (not just printed to scrollback once).
- **Tab completion** for slash commands, conversation IDs, and model names.
- **Readline history persistence** across sessions.
- **Spinner animation** during silent periods (bon/ascent lanes).
- **Multi-line messages** via trailing `\` continuation.
- **`/search`** and **`/status`** commands added.
- **Ctrl+C feedback** shows "Cancelling..." immediately.

### Reliability
- **`process.on("unhandledRejection")`** handlers on all entry points prevent silent crashes.
- **Web server** validates conversation exists before calling `submitMessage` (fixes silent 500).
- **TUI** no longer creates a dummy conversation on startup; conversation is created lazily on first
  real message.

### Distribution
- **`cheater-pi/RELEASING.md`** — complete release procedure, gates, tagging, npm trusted publishing,
  and post-release verification checklist.
- **`kitten init`** command — guided first-time setup.
- **Doctor** endpoint diagnostics classify failures (refused/auth/timeout) with provider-specific
  guidance.

### Documentation
- `blueprint/webScout.ts` and `commitlet/executor.ts` — added module-level doc comments explaining
  the search-trigger pipeline and the 7-step prompt assembly pipeline respectively.
