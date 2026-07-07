# Kitten Code — what the handler does

The local model is a **kitten**: fast, sharp claws, writes any single piece of code
beautifully — but it wanders, invents doors that don't exist, and never knows when it's
done. The harness is the **handler**: it does every job that doesn't require intelligence
deterministically, hands the kitten one small fully-briefed piece of work at a time,
checks every piece with a real test before trusting it, and only says "done" with
receipts. **Handler drives, kitten writes, checks decide.**

This document summarizes the seven changes that turned the base harness into Kitten Code.
The live path is unchanged in shape — `contract → blueprint → commitlets → capsule workers
→ grade-in-code → finish gate` — each change is an additive seam with a graceful fallback.

## The design laws (violations are bugs)

1. **All clerical work is deterministic harness code.** Never a model-facing meta-tool. The
   kitten reads briefs, writes normal code, and answers multiple-choice.
2. **Prefill is cheap, generation is expensive.** Show, don't ask. Never spend a model turn
   on what a script can gather.
3. **Prevent, don't salvage.** Gates fire *before* execution where possible; feedback is
   repair-ready ("did you mean X?").
4. **Pretraining-native formats only** — unified diffs, search/replace, normal languages,
   trivial JSON. No invented DSLs.
5. **Checks are harness-run, red-then-green, behavior-based** (never stdout-format-based);
   state is reset before scoring. The model never grades itself.
6. **No new user-facing config flags.** Default-on where cheap, hardness-gated where
   expensive. At most one internal kill-switch constant per subsystem.
7. **Additive seams with graceful fallback.** The live path keeps working if any new module
   throws — every one is wrapped and degrades.

## What changed, per phase

**Phase 1 — Check-first (`src/commitlet/checkFirst.ts`).** The #1 measured lever. For each
passing implement commitlet the harness resolves a *real* check by tier — repo tests that
cover the change (1), a worker-synthesized micro-check (2), a behavioral smoke from the
contract (3), or the static floor (4) — and **red-then-green screens it** against the
rollback snapshot: the check must FAIL without the change and PASS with it. A check that
passes pre-implementation is garbage and is recorded *weak*, never proof. The finish gate
renders a **contract evidence table** (item → verified/weak/unverified → the validation that
proves it) and WARNs on weakly-verified commitlets. A **clean-state rule** moves self-test
debris (data files the app wrote while the model tested it) aside before the finish checks.

**Phase 2 — Noun firewall (`src/reliability/nounGate.ts`).** Hallucinated paths die at the
door. Before a bash exec/cd, a shell redirect, or an edit touches a workspace path that must
exist, the harness checks the filesystem and, on a miss, returns *"Path not found:
/app/tls. Nearest existing: /app/ssl"* — one correction turn instead of a stack-trace
spelunking session. Scope-guarded (workspace paths only), fail-open (ambiguous tokens and
repeated phantoms pass), and it never gates plain reads (those error cleanly and are used to
probe).

**Phase 3 — Deterministic scouting (`src/blueprint/scout.ts`).** The handler walks the site
before the kitten arrives. From the contract nouns + the commitlet's target files it does a
bounded scan for definition/reference sites, slices the enclosing function (never mid-block),
follows one import hop, and fills the capsule's `relevantFiles` with ranked, byte-budgeted
briefs — so the worker wanders less with read/grep. Two definitions for one symbol are both
briefed and flagged so the worker *states which it used*. Hardness-gated: deep on hard work,
contract-files-only on the easy lane.

**Phase 4 — Sidecar clerk (`src/sidecar/jobs.ts`).** Four new advisory, fire-and-forget jobs
with deterministic floors: `parse_failure` (structured failure card), `rerank_briefs`
(reorder scout's briefs, never widening), `triage_hint` (a small clamped hardness nudge),
`drift_note` (post-turn off-goal scan). Never-list enforced by construction: results only
ever become capsule text or advisory signals — no tool execution, no writes, no verdicts.

**Phase 5 — Decoding control (`src/providers/localControl.ts`).** An OpenAI-compat client for
the calls the harness already owns (in-session best-of-N), adding the three knobs Pi's
main-session provider doesn't expose — per-call **temperature**, **json_schema** structured
output, and **logprobs** — each behind a probe-record-never-assume latch (a 400 that names a
feature marks it unsupported and retries without it). Best-of-N now gets *real* temperature
jitter when an LM Studio endpoint is configured; it falls back to the SDK path otherwise.

**Phase 6 — Cache-aware prompts + easy lane (`promptCapsule.ts`, `closedLoop.ts`).** The
capsule renders every stable field first and the volatile trio (observed failure, attempt
stance, world diff) *last*, so two resample attempts of one commitlet share a byte-identical
prefix a stateful endpoint can cache. The **direct lane** lets a trivial task (low hardness,
≤1 file, not high-risk) skip the blueprint/inspect/review ceremony entirely and edit
in-session — the easy-task overhead is extra model *turns*, not gate latency.

**Phase 7 — Receipts, bakeoff, and the name.** The finish output carries the evidence table
(Phase 1). A `/bakeoff` command runs the local battery head-to-head and prints a shareable
scorecard. And the mascot cat finally got its name: **Kitten Code**.

## How to run the bakeoff

From an interactive session, inside a project:

```
/bakeoff                      # run the default suite, vanilla-vs-kitten, print a scorecard
/bakeoff --limit 10           # first 10 tasks
/bakeoff --category off_by_one
```

The scorecard shows, per task, pass/fail and wall-clock for each side, plus totals and
head-to-head wins. **Honest caveat:** `/bakeoff` is an *in-session approximation* — both
sides run through the same harnessed session, differing only in prompt strategy (plain-fix
vs the reliability flow). For a **true vanilla baseline** (a separate un-harnessed agent),
use the external `harness-bakeoff/` scripts, which run each side as its own agent against
LM Studio. Neither runs inside a normal work session — batteries take a while and need your
local model up.

## Honest notes (weak / deferred)

- **`parse_failure` and `rerank_briefs`** are implemented and unit-tested but lightly wired:
  the failure path keeps its single sidecar consult (the existing distill), and scout's
  deterministic rank is the floor. They're available for callers; they aren't a second
  consult in the hot path.
- **Decoding control** is wired into best-of-N (temperature). Schema-constrained output for
  check-synthesis and blueprint generation is available on the client but not yet routed
  through it — those paths use the Pi SDK, not a harness-owned direct HTTP call.
- **The rename is user-facing only.** `.cheater/`, the `@cheater/cheater-pi` package, and the
  `cheater_*` tool names are unchanged to avoid migration churn; the receipt labels (e.g.
  "Cheater Finish Gate") are internal and unchanged.
- **Batteries are the user's post-work validation**, not run here: the in-session proof for
  every phase is its unit + fixture-integration tests (≈80 new cases across the seven
  phases). Run `npm test` in `cheater-pi/`.
