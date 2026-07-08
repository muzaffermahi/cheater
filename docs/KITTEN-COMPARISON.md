# Kitten Code — the comparison: vs base Cheater, vs opencode

*A technical positioning of what Kitten Code is, why it should be better than the base harness it
grew out of, and how it relates to opencode (the strongest "direct" terminal agent we benchmark
against). Grounded in a 2024–2026 literature + harness survey — citations inline. This is a plan and
an argument, not a benchmark report; the measured verification is in
[KITTEN-ITERATION.md](KITTEN-ITERATION.md).*

---

## 0. The one-sentence thesis

**opencode maximizes a capable model's leverage; Kitten minimizes a weak model's blast radius.** The
harness delta is real and — this is the load-bearing empirical claim — **largest exactly where Kitten
operates: a small/mid local model on hard tasks.**

The external evidence that a harness moves a *fixed* model a lot, and moves weak models most:

- **Same model, different harness, +16 points.** "Claude Opus: 77% in Claude Code, 93% in Cursor.
  Same model. Same tasks. 16 points from the harness alone." ([thoughts.jock.pl harness
  comparison](https://thoughts.jock.pl/p/ai-coding-harness-agents-2026))
- **Weakest models gain most from harness fixes.** Changing *only* the edit format (line+content-hash
  addressing instead of whitespace-exact replace) took **Grok Code Fast 1 from 6.7% → 68.3%**, with
  the effect explicitly largest on the weakest models. ([Can.ac, "The Harness
  Problem"](https://blog.can.ac/2026/02/12/the-harness-problem/))
- **A raw small model is nearly useless un-scaffolded.** SWE-Gym: a fixed Qwen2.5-Coder-32B went
  **3.0% → 15.3%** (SWE-bench Lite) purely from harness-collected training, and best-of-N verification
  pushed it to 26–32%. ([SWE-Gym, arXiv:2412.21139](https://arxiv.org/html/2412.21139v1))
- **Structure substitutes for a capability weak models lack — stated explicitly.** "smaller models…
  typically rely on pre-defined workflows (Agentless) to perform reliably and often fail when required
  to operate autonomously (OpenHands)." ([Dissecting the SWE-Bench Leaderboards,
  arXiv:2506.17208](https://arxiv.org/html/2506.17208v2)) And from production: Cursor built guardrails
  "*because* early models were weak… surfacing lint and type errors after every edit, rewriting file
  reads… limiting tools per turn" and then *removed* them as models improved. ([Cursor
  blog](https://cursor.com/blog/continually-improving-agent-harness))

**The honest counter-current (kept front-and-center).** For *strong* models the elaborate scaffolding
is optional and even a tax: `mini-swe-agent`, a ~100-line bare-bash loop with **no** editor/linter/
search, scores **>74%** on SWE-bench Verified. ([mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent))
So Kitten's scaffolding is *overhead* on a frontier model. **Every claim in this document is scoped to
the weak/mid local-model regime.** We do not claim Kitten beats opencode-with-Opus; we claim Kitten
beats a bare loop *on the model we actually run* (ornith-35B-a3b, ~25 tok/s), and that the gap widens
on harder tasks.

---

## 1. Kitten vs base Cheater — what the 7 phases bought, and why the literature says each helps a *weak* model

Base Cheater already had the spine: contract → blueprint → commitlets → capsule workers → grade-in-code
→ finish gate. Kitten's seven phases each take a lever that research shows helps weak models and move
it from *prompt-only / absent* to *enforced in deterministic code*. The through-line, stated by the
small-model reliability literature: **for a weak model, leverage is in the external oracle (execution),
not the model's judgment** — every technique that asks a weak model to introspect plateaus or
degrades; every technique that grounds it in execution helps it at least as much as a strong model.

| Phase | Base Cheater | Kitten | Why it helps a *weak* model (evidence) |
|---|---|---|---|
| **1 · Check-first (red-then-green)** | self-test was a *prompt mandate* (moved a hidden-oracle battery 4/10→6/10) | resolved-by-tier check + **red-then-green mutation screen in code**; garbage checks recorded weak; evidence table at finish | Execution-based validation is the single biggest *structural* lever: Agentless's ablation shows test-based selection adds **+6.3 pts** (majority-vote 25.67% → +regression 27% → +reproduction tests 32%). ([Agentless](https://arxiv.org/abs/2407.01489)) And "**LLMs cannot self-correct reasoning yet**" — without an external signal, self-correction *degrades* results, code included. ([arXiv:2310.01798](https://arxiv.org/abs/2310.01798)) Red-then-green *is* the external signal; making it code-enforced is exactly right. |
| **2 · Noun firewall** | post-edit gates only | **pre-execution** path gate: phantom `/app/tls` → "nearest existing `/app/ssl`" | Terminal-Bench's documented weak-model failure modes are *exactly* hallucinated paths + non-terminating loops. ([Terminal-Bench](https://tbench.ai)) SWE-agent's ACI principle: verify the environment before acting; a bad assumption acted-on is what spirals a weak model. |
| **3 · Scout (deterministic briefing)** | worker explored with read/grep | ranked, byte-budgeted FileBriefs (symbol def/ref + one import hop, function-sliced) | **Localization is the dominant lever.** On raw SWE-bench, oracle retrieval vs BM25 is a **~2.5×** jump (1.96%→4.8%) and *more* context *hurts*. ([SWE-bench, arXiv:2310.06770](https://arxiv.org/pdf/2310.06770)) "**Lost in the Middle**": >30% accuracy drop when the needed info is mid-context — and it hurts smaller models *earlier and harder*. ([arXiv:2307.03172](https://arxiv.org/abs/2307.03172)) Less-but-relevant beats repo-dump, disproportionately for a 35B. |
| **4 · Sidecar clerk** | context-prep only | +failure-card / rerank / triage / drift (advisory, deterministic floor) | The reliable division of labor: a weak model **can extract, cannot reason**. Offloading clerical formatting/ranking to a 2–4B keeps the 35B's context tight and its turns few — validated by the same context-economics that drives Lost-in-the-Middle. |
| **5 · Decoding control** | rode Pi's provider (no temperature/schema/logprobs) | owned OpenAI-compat lane: real temperature jitter, json_schema, logprobs, behind capability probes | Repeated sampling lifts weak models *most* on coverage (Large Language Monkeys: smaller models' sharpest pass@k gains, Gemma-2B 0.02%→7.1%). ([arXiv:2407.21787](https://arxiv.org/abs/2407.21787)) Temperature jitter is the coverage half. Structured/grammar-constrained emission turns "invalid format" — a weak-model-heavy failure class — into zero. ([XGrammar, arXiv:2411.15100](https://arxiv.org/abs/2411.15100)) |
| **6 · Cache prompts + easy lane** | volatile fields early; full ceremony on trivial tasks | volatile trio last (byte-stable prefix); direct lane skips blueprint on trivial | Concise/managed context is a *measured* performance lever, not hygiene: SWE-agent's full-file `cat` costs **−5.3 pts** vs a bounded window; a verbose search is *worse than no search*. ([SWE-agent, arXiv:2405.15793](https://arxiv.org/abs/2405.15793)) Easy-task overhead is extra *turns*, not gate latency — the direct lane cuts the turns. |
| **7 · Receipts + name** | receipt existed | evidence table (item→verified/weak/unverified→proof) | "No done without receipts" is the finish gate refusing the model's opinion. LLM-as-judge biases (self-preference, verbosity, limited reasoning) make a weak self-judge fatal; the interpreter has none of those biases. ([arXiv:2306.05685](https://arxiv.org/abs/2306.05685), [arXiv:2410.21819](https://arxiv.org/abs/2410.21819)) |

**Net:** Kitten > base Cheater is not "more features" — it is *the same levers, but code-enforced and
red-proven instead of prompt-requested*, and every one of those levers is in the set the literature
says helps weak models specifically. The base harness already tied vanilla on hard single-function
tasks; the check-first-in-code enforcement is the piece whose prompt-only version already moved a
hidden-oracle battery 4/10→6/10, and Phase 1 makes it a gate.

---

## 2. Kitten vs opencode — the structural difference, and what to steal

opencode is the reference for a *well-built direct agent*: TS client/server, resumable sessions, LSP
integration, git-snapshot rollback, Build/Plan agents + read-only subagents, 75+ providers. Its
control philosophy is **"LLM in a loop with actions"** — it gives the model an excellent workbench and
trusts the model to run the loop. That is the right bet *for a capable model* and the wrong bet for
ours.

### 2.1 Where Kitten is structurally different (and, for a weak model, better)

| Axis | opencode | Kitten |
|---|---|---|
| **Where judgment lives** | in the **model** — every control decision (what to edit next, is it done, is the error fixed) is the model's; reliability *is* the model reading LSP diagnostics and deciding | in **code** — contract extraction, diff-guard, patch-health, red-then-green, noun/path gate, "no done without receipts" hold even when the model's judgment is poor. This is precisely the layer a weak model lacks. |
| **Accept semantics** | **act-then-continue** — edits apply and the loop advances on the model's say-so; rollback only on hard error | **grade-then-accept** — every edit is graded in code before it counts; progress gates on machine-checkable receipts (red-then-green) |
| **Context** | growing session, auto-summarize at 90% — built to *accumulate* context for a model that can use it | bounded workers, **no transcript**, pre-sliced briefs — built to keep a weak model's context small (Lost-in-the-Middle) |
| **The "contract"** | `AGENTS.md` + the model's reading of the task | a **deterministic acceptance contract** extracted by regex, checked against |
| **Multi-attempt** | `temperature`/`top_p` per agent, **no in-loop N-sampling with a code-side selector** | in-session best-of-N with a deterministic selector (a capable model doesn't need it; a 25 tok/s 3B-active model does) |

The clean framing from the opencode deep-dive: opencode moves the model **up** to the codebase (LSP,
big context, navigation power); Kitten moves the decisions **down** into code (gates, receipts). Both
are coherent — for their respective model tiers.

### 2.2 Where opencode is genuinely ahead (and Kitten shouldn't pretend otherwise)

- **Code-intelligence surface** — hover, go-to-def, find-refs, call hierarchy exposed to the model.
  Kitten narrows the model's surface on purpose, so it can only gain this by having *graders/sidecar*
  consume LSP, never the worker.
- **Provider breadth + a polished resumable server/TUI.** Orthogonal to Kitten's thesis; real product
  surface Kitten doesn't attempt.
- **On a frontier model, opencode is simply better and cheaper** — the harness gets out of the way
  (the mini-swe-agent lesson). Kitten's scaffolding only pays off *because* the model is weak.

### 2.3 The five portable wins (opencode → Kitten)

These are the concrete things to steal, ranked by leverage-for-a-weak-model (details, effect sizes,
and how-to-measure are in [KITTEN-ITERATION.md](KITTEN-ITERATION.md); listed here as the comparison
conclusion):

1. **Promote LSP diagnostics from *hint* to *gate*.** opencode *shows* the model diagnostics after
   every edit and hopes it fixes them; Kitten should **fail the commitlet** on any non-empty
   changed-file diagnostic (via `tsc --noEmit` / pyright / an LSP client) *before* red-then-green even
   runs. Same signal, deterministic enforcement — a strict superset of opencode's mechanism. (SWE-agent
   measured the analogous linter-reject-on-edit at **+3 pts**, and losing the structured editor
   entirely at **−7.7 pts** — the largest single ACI ablation.)
2. **Search/replace edits with an anchor/fuzzy rescue cascade + retry-on-failed-apply.** opencode's
   edit is `oldString`/`newString` with a `SimpleReplacer → BlockAnchor → ContextAware` fallback.
   Kitten's workers should not fail a commitlet for *whitespace* the small model got slightly wrong —
   separate "wrong code" (grade strict) from "wrong whitespace" (apply lenient, then re-ask). Aider's
   data: a lenient applier alone is **−9× editing errors**.
3. **git `write-tree`/`read-tree` snapshots per commitlet** for clean rollback into best-of-N /
   repair-resample — restore to a pristine base with zero history pollution.
4. **File-whitelist as a tool-level permission mask**, not a prompt line (opencode's Plan agent proves
   read/edit/bash gating works cleanly at the tool layer). Deterministic beats "please only touch these
   files."
5. **A per-tool-step time budget** (opencode inherits a 120s/step cap). At ~25 tok/s a worker step
   especially needs an explicit ceiling to keep the loop bounded.

---

## 3. The comparison table (one screen)

| Dimension | base Cheater | **Kitten Code** | opencode |
|---|---|---|---|
| Target model | small/mid local | **small/mid local (35B-a3b @ ~25 tok/s)** | any (75+ providers), tuned for capable |
| Control philosophy | harness-drives, model implements in workers | **same, but gates code-enforced + red-proven** | model-drives-the-loop with a great workbench |
| Judgment | mostly code | **code (contract, gates, receipts)** | model (reads LSP, decides) |
| Accept | grade-then-accept | **grade-then-accept, red-then-green** | act-then-continue, rollback-on-error |
| Localization | agentic read/grep | **deterministic scout briefs** | LSP + grep/glob, model-navigated |
| Edit format | worker's default (often exact) | **(target) search/replace + lenient apply** | search/replace + anchor/fuzzy cascade |
| Type/lint feedback | post-edit gate (advisory) | **(target) hard gate: reject + re-ask** | LSP diagnostics shown to model (hint) |
| Multi-attempt | best-of-N (temp jitter) | **best-of-N + (target) execution-consensus select** | temperature only, no code-side selector |
| Verification | finish gate | **finish gate + evidence table, receipts-only** | model decides "done"; tests if it runs them |
| Best regime | hard tasks, weak model | **hard tasks, weak model** | any task, capable model |
| Overhead on easy/frontier | ~4.5× vanilla | **~4.5× (direct lane trims trivial)** | ~none (gets out of the way) |

---

## 4. Honest conclusion

- **vs base Cheater:** Kitten is a strict improvement *in kind* — it converts research-validated
  weak-model levers from prompt-requested to code-enforced. The unit + fixture tests prove the
  mechanisms; the battery (external rig) must prove the lift. The single most important unproven claim
  is Phase 1: does in-*code* red-then-green beat the prompt-only version that already moved a battery
  4/10→6/10.
- **vs opencode:** Kitten is not competing on opencode's turf (capable models, product polish, LSP
  navigation). It is competing on *"make a weak local model finish a hard task reliably,"* where
  opencode's model-drives-the-loop assumption is its weakness and Kitten's gates are the point. The
  actionable output of the comparison is a **5-item portable-wins list from opencode** and, from the
  broader survey, a ranked improvement backlog — both in [KITTEN-ITERATION.md](KITTEN-ITERATION.md).
- **The discipline that keeps this honest:** every claim is scoped to the weak-local regime; on a
  frontier model the scaffolding is overhead (mini-swe-agent). So the measurement must be run on the
  actual local model and on *genuinely hard* tasks — never on easy/in-distribution work where a capable
  35B already self-verifies and Kitten is pure overhead (the standing finding from ~70 prior battery
  runs).
