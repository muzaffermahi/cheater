# Changelog

All notable changes to Kitten are recorded here. Dates are ISO (UTC). This is an **alpha / technical
preview** — expect rough edges and breaking changes between preview releases.

## [Unreleased] — Kitten product (technical preview)

The unification of the split Cheater / Kitten / Ascent code into one local-first product, `kitten`,
built on a single shared application core.

### Added
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

### Preserved
- The Ascent reliability engine (execution consensus, worked-example eligibility, repair resampling,
  adaptive `k`, the disjointness firewall, owned decode controls, honest receipts) — now reachable as
  the adaptive default rather than only from a benchmark CLI.
- The existing unit/fixture suite (703 tests) plus new spine/UI/safety tests.

### Compatibility
- `cheater` remains as a compatibility alias during migration.
- Minimum Node is now **22.5** (for the built-in `node:sqlite`).
