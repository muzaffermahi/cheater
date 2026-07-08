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
| `bestofn.ts` | Sequential best-of-N with real temperature jitter (owned engine) + **execution selection** (keep the first attempt whose finish gate verified); clean-workspace reset between attempts; gated to hard tasks. |
| `cli.ts` | `node dist/src/core/cli.js run "<task>" [--cwd DIR] [--reliable] [--bon N] [--model M] [--trace F]` — headless, prints a JSON result line. |

## Three run modes (the A/B ladder)

- **kitten (raw)** — bare tool loop. The control: "is our loop already competitive with opencode?"
- **kitrel (reliable)** — raw + contract/scout + syntax gate + finish gate. "Does the harness earn its keep?"
- **kitbon (best-of-N)** — reliable + sequential best-of-N with temperature + execution selection. "Does test-time compute close the hard-task gap?"

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
