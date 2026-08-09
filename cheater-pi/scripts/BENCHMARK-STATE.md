# What is measured, what is blocked, and exactly how to unblock it

Written 2026-08-09, after the selection/scaffold/context pass. Every claim here is either a stored
result file or a named blocker — there are no numbers in this document that a file does not back.

## The honest scoreboard

| Benchmark | Best real number | Date | Config | Status |
|---|---|---|---|---|
| **SWE-bench Verified** | **none — never run** | — | — | rig written, blocked on credentials |
| **Terminal-Bench 2 (full 89)** | 0/16 before the sweep died on installs | 2026-08-01 | local ornith-35b | blocked on Docker |
| Terminal-Bench 2 (9-task cached slice) | kitten 5/9 · opencode 3/9 · omp 1/9 | 2026-08-06 | cloud qwen3.6-35b-a3b | **not a TB2 score** — see below |
| Local fixture battery (30 tasks) | kitten 30/30 · opencode 29/30 | 2026-08-04 | cloud qwen3.6-35b-a3b, model-matched | `data/benchmarks/kitten-opencode-30.latest.json` |
| llama.cpp tuning sweep | 32.45 tok/s decode at ncmoe 30 | ~2026-08-03 | RTX 4060 8.59 GB | `KITTEN-TUNING.md` |

**Why the 5/9 is not a TB2 score.** Nine of eighty-nine tasks, chosen by which Docker images happened
to be cached locally, n=1, and heavily git-weighted (five of the nine are git tasks, and kitten passed
all five). Quoting it as "56% on TB2" would be dishonest in both directions — it is not the benchmark,
and it is not a stable estimate of anything. The publication protocol in `KITTEN-INFERENCE.md` §3 asks
for a stratified 20–30 task smoke to prune, then the **full 89 paired**, reporting mean *and* paired
per-task win rate with Harbor and llama.cpp commits pinned. Nothing short of that is a TB2 number.

## SWE-bench Verified — the cheapest unclaimed number in the repo

`scripts/modal_swebench.py` (374 lines) pins the dataset by revision, selects 20 instances by SHA-256
order with at most two per repository, smoke-tests every base commit with a remote `git ls-remote`
before freezing, runs three adapters, and grades with the **official `swebench==4.1.0` evaluator**.
It has never been executed. It is one command away from a first real number.

Three things are missing, and all three need a human:

1. **A Modal token.** `~/.modal.toml` does not exist. `modal token new` opens a browser and
   authenticates an account — not something an agent should do on someone's behalf.
2. **The `qwen-endpoint` Modal Secret**, holding `MODEL_ENDPOINT` and `MAAS_API_KEY`. The runner
   injects it into workers through a loopback proxy so no benchmarked agent ever sees the key in its
   environment; it is never committed and never placed in a task env.
3. **The evaluator venv inside WSL** (`Ubuntu-24.04`, currently *Stopped*). The official grader is
   Linux-only.

Present and verified: `.modal-venv/Scripts/modal.exe`, all three payload bundles at
`Desktop\tbench-run\tb2-bakeoff\payload`, and the WSL distro itself.

```powershell
# once
.modal-venv\Scripts\modal.exe token new
wsl.exe -d Ubuntu-24.04 -- python3 -m venv /home/lenovo/swebench-venv
wsl.exe -d Ubuntu-24.04 -- /home/lenovo/swebench-venv/bin/python -m pip install swebench==4.1.0
# then the whole proof
$env:MODAL_SECRET_NAME = "qwen-endpoint"
.modal-venv\Scripts\modal.exe run cheater-pi/scripts/modal_swebench.py --revision c104f840cc67f8b6eec6f759ebc8b2693d585d4a --model qwen3.6-35b-a3b
```

## Terminal-Bench 2 — blocked on the Docker daemon

`wsl -l -v` shows `docker-desktop` **Stopped**. The last full attempt (2026-08-01) scored 0/16 and
then died on `none(rc=1)` install failures; diagnosing that is the first job once the daemon is up,
and the logs are under WSL `/opt/tb2`.

One thing was fixed here without needing Docker. The adapter was exporting `KITTEN_CEILING_MS`, an
environment variable the engine **no longer reads** — Kitten deliberately has no automatic wall clock
— so it believed Kitten would stop itself at 780 s while Harbor killed the container at 900 s with
nothing written. The deadline now belongs to the harness: `kitten run --deadline-ms N` cancels exactly
as a user's own cancel does, at a seam where partial work survives. `run-full-streaming.sh` and
`pi_terminal_bench/kitten_agent.py` both pass it explicitly.

## The local fixture battery — needs any model endpoint

`npm run benchmark:compare` is offline-validated: the manifest holds 30 tasks with one smoke task and
every fixture resolves against the 32-entry catalog. It needs a live endpoint (LM Studio, a managed
llama.cpp, or the cloud) and will refuse to report a zero for OpenCode when OpenCode's own smoke task
did not complete — an endpoint failure must never be published as model quality.

## Measured live this pass (ornith-35B on the reference machine)

The endpoint was started from the auto-tuner's own plan — `--ctx-size 32768 --n-gpu-layers 999
--n-cpu-moe 31 --flash-attn on --cache-type-{k,v} q8_0 --spec-type ngram-mod` — which is the same
configuration `KITTEN-TUNING.md` arrived at by sweep.

**E0 — does capturing logprobs cost decode speed?** Pre-declared threshold: turn the self-certainty
lever off if it costs ≥1.5×. Four paired `/completion` runs of 200 tokens after a discarded warm-up:

```
n_probs off   18.4  16.3  15.4  15.8   median 16.35 tok/s
n_probs on    17.9  17.0  18.3  16.1   median 17.88 tok/s
                                       ratio 0.91x
```

**It is free.** The difference is inside the run-to-run spread and points the wrong way. The engine's
own code had recorded "roughly a 3x generation slowdown with n_probs > 0" as the reason for
suppressing capture on single-candidate runs; that claim does not hold on this build and has been
replaced with the real reason (nothing reads the number when there is only one candidate) and this
measurement. **P1 self-certainty stays on.**

**Live end-to-end smoke.** A one-line median bug, fast effort, real model. It confirmed three of this
pass's changes in one run: the headless path printed `context: 32768 tokens (from the server)` (it
would previously have planned against the 16k default), `--deadline-ms` fired and cancelled cleanly
**with the repaired file written** (the exact behaviour TB2 needs and did not have), and the fix
itself was correct including the even-length case the original never handled.

**Unexplained, worth a calibration run:** decode measured ~16 tok/s here against the 32.45 tok/s the
sweep recorded at ncmoe 30. The auto-tuner proposes 31 (deliberately the safe side of a one-layer
cliff), and other VRAM was in use. This is exactly what *Settings → Performance → Tune for this
machine* exists to resolve — the formula cannot see what else is holding the card.

## What this pass changed that a re-measurement should show

Every one of these is unit-tested and none has been measured against a benchmark yet. Listed so the
next sweep knows what it is attributing a delta to:

- **Selection** — CodeT dual agreement and S* disambiguation in the verifier, and a screened
  reproduction script that gives repo-shaped tasks the red-then-green they never had.
- **Scaffold** — "command not found" answered with what *is* installed; a failed path answered with
  its real siblings; a ledger that stops paying for an action that already failed with nothing
  changed since.
- **Context** — old tool output elided as the window fills, instead of the run dying on
  "Context size has been exceeded"; and `contextWindowTokens: "auto"` now actually asks the server on
  the headless path (it previously fell back to 16k, so a 64k engine was benchmarked at a quarter of
  its window — this alone may move numbers).
- **Decode** — a tool-call grammar armed for exactly one turn after an argument parse failure.

The honest expectation: the context fix and the scaffold hardening should show up on TB2 (long tasks,
missing binaries, and repeated failed attempts are its three biggest buckets); the selection work
should show up on SWE-bench Verified, where the whole game is picking correctly among candidates you
already generated.
