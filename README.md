# 🐱 Kitten

**A reliable, local-first coding agent for local models — terminal UI, local web UI, durable
conversations, and an adaptive reliability engine.**

Kitten runs a coding agent against a model you host locally (LM Studio, llama.cpp, or any
OpenAI-compatible endpoint). It edits your repo, runs your tools, verifies its own work with real
execution, isolates risky attempts, and remembers every session. One shared core drives a terminal UI,
a local web UI, and a headless CLI over one durable SQLite conversation store.

> **Alpha / technical preview.** It works end to end; expect rough edges. Built for *local* models — it
> is honest about the latency and capability that implies, and makes no hosted-agent parity claims.

> The local model is a kitten — fast, sharp claws, writes any single piece of code beautifully, but
> wanders, invents doors that don't exist, and never knows when it's done. Kitten is the handler: it does
> every non-intelligent job deterministically, hands the model one small fully-briefed piece at a time,
> checks each with a real test before trusting it, and only says "done" with receipts.

## Quick start

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite` — no native build step, no compiler).

```sh
cd cheater-pi
npm install && npm run build
export KITTEN_BASE_URL="http://localhost:1234/v1"   # your local model server
export KITTEN_MAIN_MODEL="ornith-1.0-35b"
node dist/src/core/kitten.js            # terminal UI
node dist/src/core/kitten.js web        # local web UI (127.0.0.1)
node dist/src/core/kitten.js run "fix the off-by-one in parser.py"   # headless, persisted
```

Installed globally, these are just `kitten`, `kitten web`, and `kitten run "…"`.

## How it works

- **Adaptive routing** — questions get an answer-only lane; ordinary edits get the reliable lane at
  `k=1` (check-first + post-edit gates + a finish gate that refuses "done" without execution evidence);
  only genuinely hard/risky/ambiguous/large-build tasks escalate to the **Ascent** engine (best-of-N →
  execution consensus → finished-but-wrong repair). Easy tasks never pay best-of-N latency.
- **Durable everything** — conversations, events, and runs persist to `~/.kitten/kitten.db`; close and
  resume in either UI; a crash marks in-flight runs interrupted rather than lying about them.
- **Real safety** — a floor blocks catastrophic / remote-code-execution / secret-exfiltration commands
  in every lane; an approval policy gates destructive ones; `/undo` rolls back a run's own file changes
  (git-backed) while preserving your other work.
- **No telemetry.** Nothing leaves your machine except calls to your configured model endpoint.

## Where the strength (and honesty) is

A capable local model already solves small, well-scoped tasks on its own — there Kitten mostly adds
orchestration overhead, which the adaptive router keeps to `k=1`. Kitten earns its keep on **harder
tasks where the bare model ships plausible-but-subtly-wrong work**, and on **never shipping unverified
work**. The reliability engine and its measurements are documented in
[`KITTEN-ASCENT.md`](./KITTEN-ASCENT.md), [`KITTEN-CODE.md`](./KITTEN-CODE.md), and
[`LOCAL-INFERENCE-PASS.md`](./LOCAL-INFERENCE-PASS.md). **Those battery/real-repo numbers are external,
single-run, and directional** — the only continuously-verified figure is the in-repo test suite.

## Documentation

- [`KITTEN-PRODUCT.md`](./KITTEN-PRODUCT.md) — the product architecture, event model, storage schema, status.
- [`cheater-pi/README.md`](./cheater-pi/README.md) — install, usage, endpoints, troubleshooting.
- [`cheater-pi/SECURITY.md`](./cheater-pi/SECURITY.md) — the local-data + web-security model.
- [`cheater-pi/CONTRIBUTING.md`](./cheater-pi/CONTRIBUTING.md) — development.

## Compatibility

`cheater` is a compatibility alias that now opens Kitten; `cheater --pi` runs the legacy Pi-based UI.
Internals still read `.cheater/` for the legacy path; the canonical data/config home is `~/.kitten`.

## License

MIT — see [`cheater-pi/LICENSE`](./cheater-pi/LICENSE).
