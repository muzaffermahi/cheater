# Contributing to Kitten

Kitten is an alpha technical preview. Contributions and bug reports are welcome.

## Development

Requirements: **Node ≥ 22.5** (Kitten uses the built-in `node:sqlite`). No native build tools needed —
there are no native dependencies.

```sh
cd cheater-pi
npm install
npm run build       # tsc → dist/
npm test            # build + node --test dist/test/*.test.js
npm run typecheck   # tsc --noEmit
npm run smoke       # pack the tarball, install it clean, and exercise the bins (slow)
```

Run it locally:

```sh
node dist/src/core/kitten.js            # the TUI
node dist/src/core/kitten.js web        # the web UI
node dist/src/core/kitten.js run "..."  # a headless run
```

## Architecture

The product is one shared core with multiple clients (see `KITTEN-PRODUCT.md` at the repo root for the
full map):

- `src/core/events.ts` — the single versioned event model.
- `src/core/store/` — the durable `node:sqlite` conversation/event/run store.
- `src/core/app.ts` — the `KittenApp` service (route → run → persist → broadcast). All clients drive it.
- `src/core/router.ts` — the adaptive lane router.
- `src/core/runner.ts` — lane → engine (answer/direct/reliable/bon/ascent).
- `src/core/tui.ts`, `src/core/web/` — the terminal and web clients.

There is exactly one implementation of conversation state, execution, persistence, approvals, events,
and routing. UI code renders events and submits user actions; it must not decide candidate eligibility,
mutate the run ledger, or infer completion from text.

## Conventions

- TypeScript strict, ESM (NodeNext), `.js` import specifiers.
- Tests are `node:test` + `node:assert/strict`, offline and deterministic (fake/scripted runner,
  `:memory:` or temp-file store). Add coverage with any behavior change; keep the suite green.
- Prefer reusing the Pi-free canonical primitives (`nounGate`, `runstate/contract`, `commandSafety`,
  `computeBudget`, `autopilot/classifier`) over adding a parallel implementation.
- Commit in coherent, reviewable slices with a clear message.

## Reporting issues

Open an issue with your OS, Node version, `kitten doctor` output, and steps to reproduce. Do not paste
secrets — Kitten redacts known secret patterns, but review any log you attach.
