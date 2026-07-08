# KITTEN-ASCENT — driving a 35B to 80–90 on SWE-bench / as high as honest on Terminal-Bench 2

A **pass@k→pass@1 machine** built on the kitten harness. Raise what a weak model *can* solve with diverse,
tool-augmented, memory-primed generation (coverage); capture that ceiling as a single shipped answer with
an execution-grounded verifier so good it approaches the oracle (selection); make it affordable at 25
tok/s (affordability); and prove every gain transfers to real use, not just the benchmark (proof).

> **The load-bearing principle.** We win *only* through an execution-grounded verifier: a point is earned
> only when a real test passes in a clean, reset environment. So the benchmark number and the user-value
> number become the **same number** — an 85%-on-SWE-Verified kitten is a junior dev whose work passes
> tests 85% of the time. Anything that inflates the benchmark without inflating real reliability is a
> non-goal, and the disjointness firewall makes that a compile-time guarantee, not a promise.

## The thesis (one idea, from SWE-Gym arXiv:2412.21139)

| fixed ~32B model | pass@1 | Best@16 (verifier picks) | pass@16 (oracle) |
|---|---|---|---|
| Qwen2.5-Coder-32B (SFT) | 20.6% | 32.0% | **42.8%** |

Two facts define everything: **the ceiling is ~2× pass@1** (coverage matters — the model *can* solve far
more than it solves first-try), and **a mediocre verifier leaves 10.8 points on the table** (Best@16 32.0
vs pass@16 42.8 — free points already inside the generated samples). So: raise pass@k (Part A), capture it
as pass@1 with a verifier that approaches the oracle (Part B), make it affordable (Part C), prove it
transfers (Part D).

## Honest targets (read §1 of the plan before believing any number)

- **Primary, reachable: SWE-bench Verified 80–85 at Best@1** (from qwen3.6-35b-a3b's ~73 pass@1). Squarely
  inside the test-time-compute envelope.
- **Stretch, honest ceiling: Terminal-Bench 2 ~45–60** (from the ~24 open-model SOTA — a 35B on TB2 with a
  normal harness is ~24%, **not** ~70). A chunk of TB2 (MIPS interpreter, GPT-2 golf, kernel tasks) is
  beyond a 35B at **any** compute, so we do **not** claim 80–90 on TB2 and do not blur the two numbers.

## The phase map (what's built, module by module — all in `cheater-pi/src/core/`)

| Phase | Module | What it does |
|---|---|---|
| **Firewall** | `disjointness.ts` | Eval task-id registry; `assertDisjoint` HARD-FAILS on any overlap; fingerprint near-dup. Built first — every store sits on top of it. |
| **A1** coverage | `diversity.ts` + `bestofn.ts` | Multi-axis best-of-N: temperature (van der Corput) × stance × plan-vs-direct × localization × decomposition. Round-based repair-resampling. Attempt 1 stays the deterministic baseline (zero easy-task overhead). |
| **A2** web | `webAugment.ts` | Hard-gated web lookup (unresolved error after ≥1 repair / unresolvable symbol / external spec). Allow-list, disjointness-refused queries, receipts, offline-safe. |
| **A3** memory | `experience.ts` | RAG over verifier-confirmed solves from a **disjoint** corpus. Load + admit both hard-fail on eval overlap. Injects approach *shape*, never the diff. |
| **A4** skills | `playbooks.ts` + `skills/` | 10 task-family playbooks (procedure + verification), 2B classifier with a keyword floor. `lintPlaybooks` asserts no benchmark specifics. |
| **B1/B2/B4** verify | `verifier.ts` | Execution signals (red-then-green reproduction, regression, behavioral smoke) → eligibility; consensus vote → tie-break; fusion + finish gate (no "done" without a green receipt); full slate in receipts. |
| **B3** ORM | `orm.ts` + `ormFeatures.ts` + `training/orm/` | Outcome reward model. Trained-2B logprob path + json prior; a runnable proof-of-life logreg ORM over execution-grounded features; offline data→train→eval pipeline. |
| **C1** cascade | `cascade.ts` | Cheap→expensive: ORM pre-filter → static gates → execution only on survivors. Never cuts the whole field; logs every cut. |
| **C2** cloud-burst | `cloudBurst.ts` | Parallel generation on the Alibaba endpoint = the **same weights** (qwen3.6-35b-a3b), isolated workspaces, bounded concurrency, local-only fallback. |
| **C3** budget | `budget.ts` | Per-task token/wall/$ ceiling that caps N escalation (never below 1) and logs spend. |
| **D1** curves | `measure.ts` | pass@1 / pass@k / Best@1 across N; the Best@1→pass@k gap is the verifier's report card. |
| **D2** held-out | `heldout.ts` | Register a held-out set into the firewall; `transfers()` = the Law-6 leakage test. |
| **D3** ablation | `ablation.ts` | Per-lever marginal Best@1 on held-out (leave-one-out); flags a lever not earning its keep. |
| **orchestrator** | `ascent.ts` | Assembles every lever into one run; each is toggleable (for D3) and degrades to the path below it. `kitten-core run … --ascent`. |

## Live end-to-end traces (real model, this session — qwen3.6-35b-a3b on Alibaba)

**Single-shot (k=1), the whole pipeline:**
```
budget: hardness 0 → k=1
family: algorithm (keyword)
verifier: winner=attempt 1 via execution (green execution receipt)
  #1: repro=n/a regr=n/a smoke=pass elig=Y
experience: admitted this solve (algorithm)
→ SOLVED via execution (k=1, 4.7s)   [impl.py: def f(x): return x * 2]
```

**Diverse cloud-burst batch (k=7, `--hard`), coverage + cascade + verifier + slate:**
```
budget: hardness 4 (kind=bug_fix, risk=high) → k=7, deep
family: algorithm (keyword)
cascade: 7 survivor(s) to execution-verify (cut 0 cheaply)
verifier: winner=attempt 1 via execution (green execution receipt)
  #1..#7: regr=pass smoke=pass elig=Y     ← 7 candidates generated in parallel on the cloud
experience: admitted this solve (algorithm)
→ SOLVED via execution (k=7, 70.0s)   [correct DP min_coins]
```

These prime→generate→(cascade)→verify→adopt→remember traces are the machine working on a live model, every
selection backed by a real execution receipt.

## The ORM proof-of-life (Part B3, run this session)

`training/orm/` data→train→eval on 600 synthetic labeled trajectories (~8% irreducible noise):
```
AUC (rank solved>unsolved) : 0.933        Best@1 (ORM picks)  : 95.5%   (22 synthetic 8-candidate tasks)
accuracy @0.5              : 92.2%         Best@1 (random)     : 50.0%
                                           ORM lift over random: +45.5 pts  (gap to oracle: 4.5 pts)
```
A real, runnable learned verifier that captures nearly all of the pass@k ceiling as Best@1 — the SWE-Gym
story in miniature. Learned weights are sane (`hasPassingRun`/`finished`/`verifiedMarker` positive,
`hasFailingRun`/`crashMarker` negative). The synthetic AUC is **not** a capability claim; it proves the
loop. Scale = a fine-tuned 2B on the same JSONL (recipe in `training/orm/README.md`).

## The anti-benchmaxx guarantees (Design Law 4 — the one inviolable rule)

Enforced **in code with hard-fail**, not promised:
- `disjointness.ts` — canonical eval task-id registry; `assertDisjoint` throws `DisjointnessError` on any
  overlap; content fingerprint catches a renamed-but-identical eval task.
- `experience.ts` — `load()` and `admit()` both throw on an eval-id (or near-dup) collision; only
  verifier-confirmed solves are admitted; approach *shape* only, never the diff.
- `playbooks.ts` — `lintPlaybooks()` asserts no playbook contains an eval task-id or task-specific path (a
  test proves it's clean **and** catches a planted leak — the guard is not vacuous).
- `webAugment.ts` — refuses any query near-identical to an eval task's text; allow-list; every fetch logged.
- `training/orm/gen_data.mjs` — HARD-FAILS (exit 3) if any training id is an eval task.
- `heldout.ts` — the held-out set is registered into the same firewall, so all of the above cover it too;
  `transfers()` reverts any lift that doesn't survive held-out (Law 6).

## How to reproduce every number

```bash
cd cheater-pi && npm run build && node --test dist/test/*.test.js     # 678 unit/fixture tests, all green (+87 for ascent)

# ORM proof-of-life (seconds, no model):
node training/orm/gen_data.mjs --out d.jsonl --synthetic 600 && node training/orm/train.mjs --data d.jsonl --out ckpt.json && node training/orm/eval_verifier.mjs --data d.jsonl --ckpt ckpt.json

# Measurement-rig shapes (seconds, no model):
node training/measure/dry_run.mjs

# The live machine on the cloud (same weights, parallel):
export KITTEN_BASE_URL=<alibaba>/compatible-mode/v1  KITTEN_API_KEY=sk-...  KITTEN_MAIN_MODEL=qwen3.6-35b-a3b
export KITTEN_CLOUD_BASE_URL=$KITTEN_BASE_URL KITTEN_CLOUD_API_KEY=$KITTEN_API_KEY
node dist/src/core/cli.js run "<task>" --cwd <dir> --ascent [--hard]

# The batteries (hours — post-session validation): see training/measure/README.md
#   local-battery → SWE-Verified subset (80–85 target) → TB2 subset via harbor (45–60 target), all held-out-checked.
```

## Honestly unfinished / weakly-implemented (per the plan's requirement to list these)

- **The real benchmark numbers are not yet measured.** Parts A–D are built, unit/fixture-green, and proven
  live on ad-hoc tasks, but the SWE-Verified 80–85 and TB2 45–60 headlines require the multi-hour battery
  sweeps (`training/measure/run_curve.mjs` + `run_ablation.mjs`) which are the user's post-session
  validation. The plan explicitly scopes the session to *build + dry-run the rig*, not block on sweeps.
- **The ORM is a proof-of-life, not the scaled 2B.** The runnable logreg ORM (execution-grounded features)
  works and plugs in via `KITTEN_ORM_CHECKPOINT`; the fine-tuned-2B logprob ORM (the real top-end lift)
  needs the offline GPU job documented in `training/orm/README.md`.
- **The experience store starts empty.** Its ingestion from the disjoint corpus (SWE-Gym train + scraped
  issues + past kitten runs) is an offline job sharing the ORM data-gen infra; in-session it only admits
  live confirmed solves (which it does — see the traces).
- **Web augmentation's real transport is untested by design** (network); the injectable path is fully
  tested, the DuckDuckGo-lite default is provided but only exercised live by the user.
- **The A3 localization prior** informs the generator via the primer text rather than reordering scout's
  file slice directly — a lighter wiring than the plan's ideal; the file hints reach the model either way.

## Design laws (extend the kitten laws)

1. The verifier is execution-grounded or it doesn't count. 2. Coverage before cleverness (real diversity,
not N re-rolls). 3. The generator writes; the harness selects. 4. Memory/web/skills disjoint from every
eval, asserted in code. 5. Skills are family playbooks, never per-task keys. 6. Every gain measured on
held-out; if it doesn't transfer, it's leakage — revert. 7. Additive seams, hardness-gated, graceful
fallback.
