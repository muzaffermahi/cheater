# Kitten Core — the standalone, pi-free runtime

*Status doc for the "get rid of pi" work. Kitten Core is a self-contained agent runtime that talks
directly to LM Studio and owns its loop, tools, and gates — no Pi runtime, no Pi tools, no TUI.*

## Why

Pi owned the loop, the provider, the tools, and the TUI, and we couldn't escape its formatting or
control the inference. Kitten Core replaces those four things with a lean stack we control — which is
what unlocks the owned-engine advantages (temperature, json_schema, logprobs, the sidecar running in
parallel) and lets the reliability gates live *inside* the loop instead of racing Pi's tool chrome.

The deterministic harness modules (contract extraction, noun/path gate, scout localization, sidecar
jobs, symbol slicing) are pi-independent TypeScript and are reused as-is; only the loop + provider +
tools + TUI are replaced.

## The stack (`cheater-pi/src/core/`)

| Module | What |
|---|---|
| `llm.ts` | OpenAI-compat client for LM Studio. MAIN (ornith-35b, reasoning-aware — separates `reasoning_content`, needs a big token budget; native tool-calling, temperature, json_schema, logprobs), SIDECAR (qwen3.5-2b, fast/clean JSON, parallel on CPU), EMBED (nomic). |
| `tools.ts` | Native tools with Tier-A research levers baked in: **edit** = search/replace + lenient/fuzzy apply + repair-ready errors; **read** = bounded line-numbered windows; **bash** = truncated output; write/ls/grep/finish. |
| `agent.ts` | The OpenAI tool-calling loop. Noun/path firewall wired IN (pre-execution). Optional async gate hooks (`postToolHook`, `finishGate`). The **raw** loop is the opencode-comparable baseline. |
| `reliable.ts` | `runReliableAgent` — the harness edge: contract + scout localization in the first message; a **post-edit syntax gate** (py_compile / node --check) that rejects a broken edit and re-asks in the same turn (Tier A2); a **finish gate** ("no done without receipts") that refuses finish until a verification actually ran, grounding a test failure via the sidecar. |
| `sidecar.ts` | qwen-2b failure-card grounding (json_schema) with a deterministic floor. |
| `synthtest.ts` | **Sidecar synthetic-test selection** (the sidecar's biggest job): for a single-python-function task the sidecar invents probe INPUTS (not outputs — we don't trust a 2b's answers), every best-of-N attempt is executed on them, and the winner is chosen by **execution consensus** (per-input plurality output + fewest crashes). CodeT/Agentless lever; catches a subtly-wrong-but-self-verified attempt the finish gate alone passes. |
| `bestofn.ts` | Sequential best-of-N with real temperature jitter (owned engine). Selector ladder: **consensus** (synthtest) when the task is a single fn, else **verified** (first attempt whose finish gate passed). Attempt-1 fast path (verified + no probe crash → stop) keeps easy work ~1×; clean-workspace reset between attempts; gated to hard tasks. |
| `cli.ts` | `node dist/src/core/cli.js run "<task>" [--cwd DIR] [--reliable] [--bon N] [--model M] [--reasoning low\|med\|high] [--trace F]` — headless, prints a JSON result line. |
| `repl.ts` | `node dist/src/core/repl.js` — the **pi-free interactive REPL**. A readline chat loop over the same runtime with clean formatting (no Pi banners/boxes), `/raw /reliable /bon /cwd /model` commands. This is the last pi surface replaced: the files on disk are the session state. |

## Three run modes (the A/B ladder)

- **kitten (raw)** — bare tool loop. The control: "is our loop already competitive with opencode?"
- **kitrel (reliable)** — raw + contract/scout + syntax gate + finish gate. "Does the harness earn its keep?"
- **kitbon (best-of-N)** — reliable + sequential best-of-N with temperature + consensus/verified selection. "Does test-time compute close the hard-task gap?"

## "Get rid of pi" — status

The entire measured capability path is **pi-free**: `core/` imports only four pure-TS helpers (nounGate,
projectCommands, symbolSlice, contract) plus node built-ins — no Pi runtime, tools, provider, or TUI.
The two entry points are both ours: `cli.js` (headless, what the A/B drives) and `repl.js` (interactive).
Pi is no longer in the loop, the tools, the provider, or the frontend for anything Kitten Core does.

## Grounding fixes from A/B trace review (speed)

Reading the traces showed the harness was *slower* than opencode on hard tasks by burning turns, not by
failing — two grounding bugs, now fixed:
- **Noun-gate false block**: `isPathLike` treated any token with `/` as a path, so `evaluate('10/4')`
  inside `python -c "..."` was blocked as a phantom path (wasted ~2 turns/run). Fixed: reject code-like
  tokens (parens/quotes/operators) and skip the inline-code arg after `-c/-e/-m`. Regression-tested.
- **Hallucinated cwd**: the model invented `/home/user`, then fumbled `rm` at the wrong path and wasted
  turns tidying scratch files. Fixed: the system prompt now states the real working directory, that all
  tools run there, and that scratch files may be left in place. The verify mandate prefers a one-line
  `python -c` check over writing+running+deleting a separate test file.

## The A/B rig (`~/Desktop/kitten-ab/`, not in the repo)

`ab.mjs` runs real SWE tasks with **hidden behavior oracles**, STRICTLY one agent at a time (LM Studio
serves one request at a time). Key hard-won harness facts encoded there:
- opencode writes nothing to stdout off a TTY and never self-exits (persistent server) — it's run
  blocking via `spawnSync` through git-bash with `XDG_DATA_HOME` set INLINE (a login shell drops it →
  the broken 845 MB default DB → hang) and the full shim path (a non-login bash lacks npm on PATH).
- A **preflight** skips any task whose oracle already passes on its unsolved setup (guards against a
  corrupted/trivial task silently giving both agents a free win).
- Fresh workspace per run; oracle runs after and never enters the workspace during the run.
- `analyze.mjs <tag> [--traces]` prints the pass/time/turns grid and auto-categorizes kitten failure
  modes from traces (bad-edits / finish-gate-loop / finished-unverified / wandered / stalled / …).

Both models live: ornith-1.0-35b (GPU) + qwen3.5-2b (sidecar, CPU). opencode uses provider `ornith`
→ the same model/endpoint, so the comparison isolates the harness.

## Early signal

On the trivial edit task, the bare kitten loop finished faster than opencode on the same model
(≈84 s vs ≈124 s), and reliable-mode verified its own fix (wrote+ran a check) before finishing. The
full 3-way sweep across 13 tasks (single-file bugs, from-scratch, multi-file, stateful) is how we find
where the harness wins and where opencode wins, and iterate from there.
