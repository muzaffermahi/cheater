# Cheater

**A reliability layer for [Pi](https://github.com/earendil-works/pi-coding-agent) that helps a small/mid local model finish coding tasks it would otherwise botch.**

Cheater is a Pi extension, not a separate agent. Pi owns the TUI, the tools, the
editing, and the agent loop. Cheater adds a harness on top: it plans the change,
makes each edit in a bounded step, **grades and repairs it in code**, runs the
project's tests, and refuses to say "done" until something actually passed.

## Quick start

Run one command inside a project:

```powershell
cheater
```

Then just ask, in plain language:

```text
fix this failing test
add a /hello command
build me a Flask API for notes with create/list/delete
```

Cheater classifies the request and routes code changes automatically. It is
**autonomous by default** — one prompt runs to completion, no approval step.
Set `"requireApprovalForHighRisk": true` in `.cheater/config.json` to make
genuinely destructive requests (deleting files, dropping a DB, lockfile churn)
pause and ask first.

## How it works

Every code task runs through **one flow**, driven by the harness — the model
only writes code inside bounded steps:

```
route  →  plan into commitlets  →  for each: edit → grade (guard + health) → verify → repair if needed  →  finish gate → receipt
```

- **Commitlets** are small, single-purpose edits with a scope the harness enforces.
- **Grading is code, not vibes**: a diff guard + patch-health score + the project's
  own tests decide whether an edit passed.
- **Best-of-N**, adaptively: an easy edit gets one attempt; a hard one gets up to
  3 independent tries, and the harness keeps the first that verifies.
- **The finish gate** blocks "done" unless real verification evidence exists and
  no failures are unresolved. If verification genuinely can't run, the skip is
  recorded honestly — it never fakes success.

## Vanilla Pi vs Cheater — the numbers

Measured with **ornith-1.0-35b** (a Qwen-3.5-35B-A3B fine-tune) running locally in
LM Studio. Two honest findings:

### On easy / in-distribution tasks, Cheater matches vanilla — at a speed cost

A strong 35B model already solves small, well-scoped tasks on its own. Cheater's
structured loop doesn't raise the pass rate here; it adds orchestration overhead.

| Task set (single-file bugs + small from-scratch apps) | Vanilla Pi | Cheater |
| --- | --- | --- |
| Pass rate | 6 / 6 | 6 / 6 |
| Median wall-clock | ~40 s | ~180 s (~4.5×) |

**Takeaway:** if the model can already do it, vanilla is faster. Cheater's cost
only pays off when correctness is actually at risk.

### On genuinely hard tasks, the harness carries the model further

On a curated set of 19 hard [Terminal-Bench 2](https://github.com/laude-institute/terminal-bench)
tasks (write a MIPS interpreter, a compressor, C/Rust polyglots, a Scheme
evaluator…), the bare model gives up or thrashes on most. With Cheater's
route → attempt → verify → repair loop the ornith-class model **passes 4/19** —
tasks it otherwise refuses to even attempt correctly. *(A clean vanilla-vs-cheater
head-to-head on this set is in progress.)*

**Bottom line:** Cheater's value is **hard tasks where the bare model fails** and
**never shipping unverified work** (the finish gate). On easy tasks it's overhead
— which the adaptive best-of-N and inline finish-verification keep as small as
possible, but don't erase.

## Configuration

Config lives in `.cheater/config.json` (merged over sensible defaults). Common keys:

| Key | Default | What it does |
| --- | --- | --- |
| `provider` / `model` | — | Backend + model id (e.g. `lmstudio` / `ornith-1.0-35b`). |
| `requireApprovalForHighRisk` | `false` | Pause + ask before destructive intent. |
| `maxSessionContextTokens` | ~90% of window | Cap the main session's context. |
| `adaptiveMaxSamples` | `3` | Max best-of-N tries for the hardest single-file edit. |
| `cleanTuiEnabled` | `true` | Collapse Pi's raw tool output (`/pi` toggles it back). |
| `mascotStyle` | `cat` | `cat` \| `ascii` \| `off` — the terminal mascot. |

## Slash commands

`/cheater` (help + status) · `/pi` (toggle raw tool output) · `/test` · `/map` ·
`/remember` · `/reliability-status` · `/commitlet-status` · `/gym` (local benchmark).

## Development

```bash
cd cheater-pi
npm run build                     # tsc
node --test dist/test/*.test.js   # unit suite (all green)
```

The live extension is `cheater-pi/src/extension.ts`. Pi loads the TypeScript
directly, so edits take effect on the next `cheater` launch.
