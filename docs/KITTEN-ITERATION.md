# Kitten Code — the iteration & testing matrix

*A technical deep plan for how to test Kitten and what to build next, driven by a 2024–2026 research
survey (SWE-bench/Terminal-Bench harnesses, small-model reliability, opencode). This is the
improvement backlog + the measurement protocol; the positioning argument is in
[KITTEN-COMPARISON.md](KITTEN-COMPARISON.md). **Nothing here is run yet — this is the plan.***

The organizing principle, from the literature and from ~70 prior battery runs: **for a weak model,
leverage lives in the external deterministic oracle (execution), not the model's judgment.** Every lever
below either (a) grounds the model in execution, (b) constrains its structure without taxing its
reasoning, or (c) shrinks/sharpens its context. Levers that ask a weak model to introspect are flagged
SKIP.

---

## Part I — The improvement backlog (ranked, research-driven)

Each lever: **what**, **kitten piece**, **evidence + effect**, **latency verdict** (decisive at
~25 tok/s), and **current state in kitten** (so we build the delta, not a rewrite). Ranked by
`leverage × fit-for-25-tok/s` — cheap-and-powerful first.

### Tier A — free / near-free, do first (no extra model samples)

**A1. Search/replace edit format + lenient applier + retry-on-failed-apply.** ⭐ biggest single
weak-model win.
- *Kitten piece:* worker edit tool + grade-in-code (diff guard).
- *Evidence:* edit format alone swings a fixed model **20% → 61%** (GPT-4-Turbo, Aider); a lenient
  applier is **−9× editing errors**; weak models fail unified diff *pathologically* (GPT-3.5 whole 46%
  vs diff 19–30%; puts the whole file in the search block). ([Aider edit
  formats](https://aider.chat/docs/more/edit-formats.html), [unified-diffs
  post](https://aider.chat/2023/12/21/unified-diffs.html)) opencode ships exactly this cascade
  (`SimpleReplacer → BlockAnchor → ContextAware`).
- *Latency:* free — it's a format + applier choice. The retry costs occasional samples only on
  malformed edits.
- *Current:* kitten has `cheater_replace` (literal find/replace) and `cheater_line_edit`, but bounded
  workers can still emit whitespace-exact edits that the grade rejects as "bad patch" when the *code*
  was fine. **Delta:** default workers to search/replace anchored on a unique snippet; add a fuzzy/
  anchor apply + a "anchor not found / matched N times → re-ask with the specific error" loop; keep
  the *grade* strict (separate wrong-code from wrong-whitespace).

**A2. Type/lint/import gate as a HARD reject-and-re-ask (promote from advisory).**
- *Kitten piece:* check-first / post-edit gates.
- *Evidence:* SWE-agent's editor-with-linter is its **largest ACI ablation** — removing the linter is
  **−3 pts**, removing the structured editor entirely **−7.7 pts**; the mechanism is "apply only if it
  doesn't introduce major errors, else discard and re-ask," which **breaks the edit-the-same-broken-
  snippet death spiral.** ([SWE-agent](https://arxiv.org/abs/2405.15793)) opencode feeds LSP
  diagnostics after every edit — but only as a *hint*. Cursor confirms "surface lint+type errors after
  every edit" as a core weak-model guardrail.
- *Latency:* near-zero (local `tsc --noEmit` / pyright / parse). Highest ROI/latency ratio in the whole
  list.
- *Current:* kitten has `postEditSyntaxGate`, `postEditImportGate`, `typeCheckGate` — some advisory.
  **Delta:** for the changed file only, make a non-empty diagnostic a **hard commitlet failure that
  re-asks the worker with the diagnostic**, *before* red-then-green runs. (Kitten's importGate already
  does the resolution; this is promoting it to a gate + wiring the re-ask.)

**A3. Command-output truncation + "verify the path, don't assume it."**
- *Kitten piece:* noun gate (Phase 2) + worker tool-result handling.
- *Evidence:* SWE-agent — a **verbose search is worse than no search** (12.0% vs 15.7%), full-file
  `cat` **−5.3 pts** vs a 100-line window; "informative but concise" is *measured*. Terminal-Bench's
  weak-model failure modes: hallucinated dirs, drowning in output, non-terminating loops.
- *Latency:* free.
- *Current:* kitten's noun gate already **proves** a must-exist path via `existsSync` before executing
  (this is exactly the "verify before assume" guardrail). **Delta:** truncate/stream long command
  output before it reaches the worker's context (a middle-out clip with a "+N lines hidden" marker);
  extend the noun gate's suggestions to use the failing traceback (below).

**A4. Coarse-to-fine localization + traceback-as-SBFL.**
- *Kitten piece:* scout (Phase 3).
- *Evidence:* localization is the dominant lever (oracle vs BM25 ≈ **2.5×** on raw SWE-bench). Agentless
  does it in explicit tiers — file **81.67%** → function **58.33%** → edit-line — and "directly going
  from file to edit locations, both cost and performance are worse." ([Agentless](https://arxiv.org/abs/2407.01489))
  AutoCodeRover adds spectrum-based fault localization for **+3 pts**; the **failing traceback *is* the
  spectrum** for a single failing test, and it's free. ([AutoCodeRover](https://arxiv.org/abs/2404.05427))
- *Latency:* cheap — short prompts, zero extra samples.
- *Current:* scout is single-pass (nouns → briefs). **Delta:** two explicit passes for hard commitlets
  (repo/skeleton → files, then file-skeleton → functions/lines); for a *repair* commitlet, feed the
  failing traceback frames straight into scout as the localizer.

**A5. Bounded-but-progress-aware loop budget.**
- *Kitten piece:* loopGovernor + `hardTaskLoopBudget`.
- *Evidence:* Terminal-Bench lesson — cutting legit iteration and letting spinning run are *both* fatal;
  distinguish them by *evidence of progress* (distinct files edited + distinct failing commands).
- *Latency:* free.
- *Current:* `hardTaskLoopBudget` already keys on ≥2 distinct edited files AND ≥2 distinct failing
  commands (default off). **Delta:** enable + validate on the friction subset; this is a measurement,
  not new code.

### Tier B — the one expensive lever worth building carefully (gate to hard tasks)

**B1. ⭐ Synthetic test selection / execution-consensus best-of-N.** *The #1 unbuilt lever.*
- *Kitten piece:* red-then-green (Phase 1) + best-of-N (Phase 5) + finish gate.
- *The recipe (Agentless + CodeT):* (1) sample k candidate patches; (2) generate reproduction test(s)
  and **keep only those that are RED on the pre-edit tree** (a validity filter — auto-tests are noisy,
  so this gate is non-negotiable); (3) select a small regression subset that currently passes; (4) run
  every candidate against the surviving red test + regressions; **pick the candidate that turns the red
  test green without breaking regressions, tie-break by patch-normalized majority.** CodeT generalizes
  the tie-break to **dual execution agreement** — cluster candidates by which produce the same outputs,
  score a cluster by (#passing tests × #agreeing solutions); **robust to bad tests by construction** (a
  lone wrong test can't dominate).
- *Evidence:* Agentless's test-based selection is **+6.3 pts** over "take the first patch"; CodeT is
  **+6.2 to +15.9 pp pass@1 on the *weaker* base models** (InCoder, CodeGen), not just frontier.
  ([CodeT, arXiv:2207.10397](https://arxiv.org/abs/2207.10397))
- *Latency:* **the most expensive technique in the corpus.** The frontier "40 patches × many tests"
  config is a non-starter at 25 tok/s. **The budget-safe version:** k=2 patches, 1–2 reproduction-test
  candidates, keep only red-on-original, run against a *small* regression subset. N=2-with-a-valid-
  discriminative-test captures most of the benefit (the first correct/incorrect split is where the vote
  matters). **Gate to hard tasks only** (`computeBudget` hardness ≥ threshold or first-patch-fails);
  easy commitlets take the single-shot path.
- *Current:* kitten's red-then-green *confirms one check*; best-of-N picks by a score-rank-vector (a
  code-side selector, but not execution-consensus). **Delta:** extend red-then-green from *confirm-one*
  to *select-among-candidates* via behavioral clustering over contract-derived, red-validated tests;
  make the finish gate the vote. Prefer **assertion tests derived from the acceptance contract** (a
  better oracle than a weak model's invented test) and require red-then-green to discard vacuous ones.

### Tier C — structural, build after A/B (moderate cost, only on failure)

**C1. Adaptive decomposition (ADaPT): fail twice → split, don't resample the same chunk.**
- *Kitten piece:* commitlets + `computeBudget`.
- *Evidence:* ADaPT's as-needed recursive decomposition (split only when the executor fails) reports up
  to **+28 pts** and helps **weaker executors disproportionately** (they hit the "too hard, split"
  trigger more). ([ADaPT, arXiv:2311.05772](https://arxiv.org/abs/2311.05772))
- *Latency:* moderate; only on repeated failure.
- *Current:* kitten repair-resamples the *same-sized* commitlet. **Delta:** on a 2nd grade failure,
  split the commitlet smaller rather than resampling.

**C2. Constrain the editable file/symbol at decode time to the localization set.**
- *Kitten piece:* noun/path gate + localControl (Phase 5).
- *Evidence:* grammar-constrained decoding turns "touched the wrong file" into an impossibility;
  **CRANE** says constrain the *structured emission*, leave the *reasoning* free (reason-then-constrain)
  to avoid the format-tax. ([XGrammar](https://arxiv.org/abs/2411.15100),
  [CRANE, arXiv:2502.09061](https://arxiv.org/abs/2502.09061))
- *Latency:* near-free where the owned lane streams (localControl); n/a for Pi-driven main turns.
- *Current:* the noun gate is a *post-hoc* check. **Delta:** on the owned decoding lane, constrain the
  patch envelope + editable path to the whitelist; route sidecar cards through `json_schema` (kitten
  already has the probe).

**C3. git `write-tree`/`read-tree` per-commitlet snapshots for clean rollback.**
- *Kitten piece:* rollback + best-of-N.
- *Evidence:* opencode's clean-rollback-without-history-pollution; the standard "revert to a pristine
  base between samples" the stronger harnesses use.
- *Current:* kitten snapshots allowed files to a dir. **Delta:** consider git plumbing for whole-tree
  transactionality when the workspace is a git repo (falls back to the file snapshot otherwise).

### Explicitly SKIP (frontier-only or biased — do not spend effort)

- **Intrinsic self-critique / self-refine without ground truth** — flat-to-negative on weak models
  ("LLMs cannot self-correct reasoning yet", [arXiv:2310.01798](https://arxiv.org/abs/2310.01798)).
- **LLM-as-judge / self-ranking as the best-of-N selector** — self-preference + verbosity + limited-
  reasoning biases; a weak model judging code *is* the hard task it can't do. Use execution instead.
- **Trained process/outcome reward models (PRM/ORM)** — strong in papers, impractical to train/serve
  locally; the test runner is your verifier.
- **Repair fed model self-critique** — the model may edit, the interpreter must diagnose; feed the
  failing test id + expected-vs-actual + traceback file:line (+ LDB-style intermediate variables if
  cheap), never a free-form "here's what's wrong". (Kitten's `parse_failure`/distill already extract
  from *real* failure output — keep it that way.)

---

## Part II — The comparison & iteration matrix

### II.1 The three axes

**Agents (columns) — same local model for all, to isolate the harness:**
1. **vanilla Pi** — the baseline; the "harness = nothing" control.
2. **Kitten Code** — the harness under test.
3. **opencode** — the strong *direct* agent; the "good workbench, model-drives" comparator (already
   observed at ~6/10 on a hard battery, tying the base harness).

Run all three on **ornith-35B-a3b @ ~25 tok/s** (the real target). For breadth/speed on a full sweep,
a cloud `qwen3.6-35b-a3b` (ornith's base) may screen candidates → confirm winners locally.

**Task classes (rows) — chosen so the harness delta can actually appear:**

| Class | What | Why it can show a delta | Trap it avoids |
|---|---|---|---|
| **T1 · Terminal-Bench 2 curated hard** | real Docker tasks, hidden test suites | genuinely hard for a 35B; the **friction subset** (path-hallucination, loop-lockout) is where Phases 1/2/A2/A3 bite | visible-test leakage (tests are hidden) |
| **T2 · Large multi-file from-scratch apps** | "like a regular person: flask+react weather app…", hidden end-to-end smoke | vanilla single-threads and ships one broken piece; Kitten's decomposition + per-piece verify is the edge | small-task vanilla-easiness |
| **T3 · Held-out algorithmic** | single function, test **NOT** copied into the workspace, hidden behavior oracle | isolates the self-test / red-then-green lever (the model can't just read+iterate the test) | the visible-test 0/10 finding |
| ~~T4 · small single-fn, visible test~~ | **DO NOT USE** | vanilla reads the test and iterates (informal verify→repair) → 0/10 hard; measures nothing | — |

**Metrics (cells) — behavior first, then cost:**
- **Correctness:** pass@1 and **majority-solved @3** against the *hidden behavior oracle* (outcome/
  data-file state / does-it-run end-to-end — **never stdout format**).
- **Cost:** wall-clock, **model turns** (the real easy-task overhead), tool-call count, tokens.
- **Harness health (Kitten only, from receipts):** malformed-edit rate, red-then-green-proven rate,
  noun-gate blocks + corrections, type-gate blocks, best-of-N applied-attempt, weakly-verified count.

### II.2 The measurement protocol (and the traps it encodes)

Hard-won rules from prior passes — violating any of these manufactures a fake result:

1. **Score BEHAVIOR, not stdout format.** A capable 35B makes reasonable-but-varied choices (extra
   columns, a global data path); brittle format-based acceptance FALSE-FAILS and manufactures fake
   "hard tasks." Check outcomes: does it run end-to-end, is the data-file state correct.
2. **Reset app data between the model's self-test and scoring.** The model test-runs its own app,
   leaving state (e.g. `expenses.json`); the oracle must reset before scoring or it reads leftover data.
3. **Hidden oracle, never in the workspace.** If the acceptance test is copied in, vanilla reads it and
   iterates — the harness delta vanishes (the T4 finding).
4. **≥3 trials, report majority-solved.** n=1 is noise (a lone semver "fail" was noise).
5. **Serialize the runs.** LM Studio serves one request at a time; a parallel probe starves the agent
   (the "0-byte stall" was contention, not a dead model). One agent at a time; pin the runner.
6. **Scope to the weak model + hard tasks.** On easy/in-distribution work a capable 35B self-verifies
   and Kitten is pure ~3–5× overhead (mini-swe-agent's frontier lesson, mirrored locally). Never A/B a
   lever on easy tasks — the signal is zero and the overhead reads as regression.

### II.3 Per-lever A/B protocol

For each backlog lever: it ships **behind an internal kill-switch** (the standing design law — no new
CheaterConfig flags), unit + fixture tested in-session, then measured by the user:

1. Pick the **task subset where the lever should bite** (e.g. A2 type-gate → tasks with a compiler; B1
   test-selection → hard multi-candidate tasks; A3 path-verify → the TB2 path-hallucination fails).
2. Toggle **one** lever, hold everything else, run vanilla / kitten-off / kitten-on, ≥3 trials.
3. Read the delta on **correctness** *and* **turns/wall-clock** — a lever that adds turns without
   correctness is a regression (the promote-A rule: keep it default-on only if A beats B).
4. Record the harness-health metric the lever targets (e.g. malformed-edit rate for A1) — the mechanism
   should move even when the top-line is noisy.

---

## Part III — Phased rollout (build order)

Ordered by ROI/latency and by dependency. Each phase = build behind a kill-switch → unit/fixture test →
hand to the user for a battery A/B on the relevant subset. **Do not batch-ship; measure between
phases** (the promote-A discipline).

- **Phase α — the free wins (Tier A).** A1 search/replace + lenient apply, A2 hard type/lint gate, A3
  output truncation, A4 scout coarse-to-fine + traceback localizer. These are the highest ROI/latency
  and several map to *already-diagnosed* frictions (path hallucination, edit-format failures). Expect
  the clearest, cheapest gains here. Validate A5 (loop budget) as a measurement.
- **Phase β — the expensive lever (Tier B1), carefully.** Synthetic test selection / execution-
  consensus best-of-N, hard-gated at k=2 with the red-on-original validity filter and contract-derived
  assertions. This is the one with the clearest measured contribution in the literature and the one most
  likely to move *hard* tasks — but also the one most able to waste tokens if built loosely. Build the
  red-validated filter *first*; it's the safety valve against noisy auto-tests.
- **Phase γ — structural (Tier C).** Adaptive decomposition (C1), decode-time file constraint (C2),
  git-tree snapshots (C3). Lower-urgency; do after α/β prove out.

**The stop condition / definition of a win:** on the **T1 friction subset + T2 multi-file apps**,
Kitten beats vanilla Pi by a clear margin (target: kitten ≥ 2–3× vanilla's solved count on the subset
where its levers apply) at a wall-clock the user accepts (~15 min/hard-task budget), with the
harness-health metrics confirming the *mechanism* fired (malformed-edit rate down, red-then-green-
proven up, path-gate corrections replacing spelunking). We explicitly do **not** chase parity on easy
tasks or on frontier models — that is a category error the whole plan is built to avoid.

---

*Sources are cited inline and consolidated in [KITTEN-COMPARISON.md](KITTEN-COMPARISON.md) §0–2. The
five research briefs (opencode architecture; SWE-bench harness techniques; weak-model ACI design;
localization + patch-format; small-model reliability SOTA) converge on one message: **ground the weak
model in execution, constrain its structure not its reasoning, and shrink its context — and gate the
one expensive lever (test-based selection) to hard tasks.** That is the plan.*
