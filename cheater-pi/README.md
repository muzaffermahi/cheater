# 🐱 Kitten

**A reliable, local-first coding agent for local models — with a terminal UI, a local web UI, durable
conversations, and an adaptive reliability engine.** Point it at a model running in LM Studio or
llama.cpp and it edits your repo, runs your tools, verifies its own work, and remembers every session.

> **Alpha / technical preview.** Kitten works end to end, but expect rough edges and breaking changes
> between previews. It is not a drop-in replacement for hosted agents like Claude Code or Codex — it is
> built for *local* models and is honest about the latency and capability that implies.

## What it is

Kitten runs a coding agent against a local, OpenAI-compatible endpoint and layers a real reliability
harness on top: it routes each request to the right amount of compute, verifies changes with actual
execution (not model self-review), and isolates risky work. One shared core drives three clients — a
terminal UI, a local web UI, and a headless CLI — over one durable conversation store.

**Strengths**
- Every conversation is stored locally and fully resumable — close and reopen, in either UI.
- Adaptive routing: easy tasks run cheaply (`k=1`); only genuinely hard/risky/ambiguous tasks pay for
  the best-of-N Ascent engine (coverage → execution consensus → repair).
- Real safety model: a floor that blocks catastrophic/RCE/exfil commands, plus approvals and `/undo`.
- No telemetry, no cloud dependency, no secrets in stored or browser state.

**Honest limits**
- It is only as capable as your local model. A 35B-class model handles small-to-medium tasks well;
  large, novel tasks are still hard.
- The Ascent lane runs multiple candidates, so hard tasks are **slower** than a single pass — that is
  the tradeoff that buys reliability. Easy tasks stay fast.
- Benchmarks: the unit/integration suite is the only continuously-verified number. Any battery/real-repo
  figures elsewhere in this repo are external, single-run, and directional — not headline claims.

## Install

Requires **Node ≥ 22.5** (Kitten uses the built-in `node:sqlite` — no native build tools, no compiler).

```sh
npm install -g <this-package>     # or: npm pack && npm install -g ./<tarball>.tgz
```

Then run a local model server (e.g. LM Studio) exposing an OpenAI-compatible API, and set your endpoint:

```sh
export KITTEN_BASE_URL="http://localhost:1234/v1"   # your local server
export KITTEN_MAIN_MODEL="ornith-1.0-35b"           # your model id
kitten doctor                                        # check node, store, endpoint
```

## Use

```sh
kitten                     # the terminal UI (streaming, mascot, slash commands)
kitten web                 # the local web UI at http://127.0.0.1:4025
kitten run "fix the off-by-one in parser.py"   # headless, persisted, resumable
kitten resume              # list recent conversations; `kitten resume <id>` replays one
kitten conversations       # list stored conversations
kitten undo                # roll back the last file-changing run (git-backed)
```

### Terminal UI

`kitten` opens a streaming session: the pixel-cat mascot reflects the run state, output and tool calls
stream live, and slash commands cover the workflow — `/new`, `/resume`, `/conversations`, `/rename`,
`/model`, `/diff`, `/undo`, `/cat`, `/doctor`, `/help`, `/exit`. Ctrl+C cancels an active run (again to
exit). When a run wants to do something risky, it asks for approval inline.

### Web UI

`kitten web` starts a local server bound to `127.0.0.1`, prints the URL, and opens your browser. It is a
real client — start, continue, interrupt, approve, inspect, and resume sessions — over the same core and
store as the terminal. Streaming is via Server-Sent Events with reconnect and replay, so a page refresh
or a server restart restores your conversation. See **Security & local data** below.

## Persistence & privacy

- Conversations, events, and runs live in one SQLite database at `~/.kitten/kitten.db`
  (override with `KITTEN_HOME`). Deleting it deletes your history.
- **No telemetry.** Nothing leaves your machine except calls to the model endpoint you configure.
- API keys are never written to the store or sent to the browser. See [`SECURITY.md`](./SECURITY.md).

## Supported endpoints & models

Any OpenAI-compatible endpoint: **LM Studio**, **llama.cpp** (`--server`), or a compatible cloud
endpoint. Native llama.cpp unlocks extra request-level controls (grammar, min-p/DRY, `/tokenize`,
prompt-cache reuse). Kitten uses a small optional sidecar model for clerical/structured work; when it's
unavailable, the main model covers for it. It never requires two models resident at once.

Configuration precedence: `KITTEN_*` env vars → `~/.config/kitten` → project `.kitten/config.json`.

## Troubleshooting

Run `kitten doctor`. Common cases:
- **endpoint offline** → your local server isn't running or `KITTEN_BASE_URL` is wrong.
- **model missing / wrong name** → set `KITTEN_MAIN_MODEL` to a model your server has loaded.
- **Node too old** → upgrade to ≥ 22.5.
- **not a git repo** → allowed, but `/undo` needs git for rollback.

## Compatibility

`cheater` is a compatibility alias that now opens Kitten; `cheater --pi` runs the legacy Pi-based UI.

## Development

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`../KITTEN-PRODUCT.md`](../KITTEN-PRODUCT.md) for the
architecture. `npm run build`, `npm test`, `npm run typecheck`, `npm run smoke`.

## License

MIT — see [`LICENSE`](./LICENSE).
