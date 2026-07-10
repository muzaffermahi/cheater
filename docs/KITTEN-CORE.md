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

## Measured results (~120 A/B runs, hidden oracles, serialized)

**Capability = parity.** On the local regime (single-function bugs, from-scratch, small multi-file /
stateful), ornith-35B passes ~100% at pass@1 whether it's driven by kitten or opencode. "More capable"
is not real here — the same model solves these either way. Genuine pass@1 failures need large multi-file
work or the TB2 Docker suite (a 35B can't one-shot those). So the harness's job on this regime is not
capability — it's speed and a verification guarantee.

**Speed = the proven win.** Definitive head-to-head, final build, same session, 5 tasks × 2 trials:

| agent | avg turns | avg sec | pass |
|---|---|---|---|
| **kitrel** (reliable) | **3.5** | **72** | 10/10 |
| kitten (raw) | 4.4 | 79 | 10/10 |
| opencode | 4.2 | 98 | 10/10 |

kitten is faster than opencode on **5/5 tasks**; kitrel is **~27% faster** *and* still runs a real
verification before finishing (opencode does not). This came entirely from **trace review → fixes**:
the harness was slower by burning turns, not by failing. The four fixes, each measured:
1. **Noun-gate false block** — `isPathLike` read `evaluate('10/4')` inside `python -c` as a phantom
   path (~2 wasted turns/run). Reject code-like tokens; skip the inline-code arg after `-c/-e/-m`.
2. **Hallucinated cwd** — the model invented `/home/user`, fumbled `rm`, tidied scratch files. The
   prompt now states the real cwd, "never cd", "leave scratch files".
3. **Editor feedback** — the edit tool echoes the changed region so the model trusts it and stops
   re-writing whole files.
4. **Lean prompts (the variance killer)** — the verbose "verify every edge" mandate primed an
   over-verification *spiral* (word-wrap 3t one run, 12t the next; a 1-line dedup fix took 9 turns).
   Move the detail into the finish gate, keep the upfront prompt lean → kitrel **median 3 turns**,
   dedup 9t→3t. A verify-cap nudge tames the strict-validation tail (duration-parse 19t→≤10t).

The finish gate still guarantees no unverified finish, and best-of-N consensus (synthtest) is available
for the hard regime — but on tasks the model already solves, consensus mostly just agrees. The honest
headline: **same model, kitten is faster and it verifies; opencode is neither faster nor safer.**
