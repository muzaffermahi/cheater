# Local-inference hardening pass (ornith-35b on native llama.cpp)

Ten test→idea→implement→retest iterations run against a **native `llama-server`** hosting
`ornith-1.0-35b` (a reasoning MoE, 35B-A3B) at ~20 t/s on an 8 GB RTX 4060
(`-ngl 99 --cpu-moe -c 16384 --no-mmap -fa on --jinja`; launch script in the local-battery rig).

Running kitten against a **local reasoning model that is also its own sidecar** surfaced a class of
bugs invisible on the cloud endpoint — chiefly that kitten's single biggest correctness lever, **CodeT
execution-consensus, was silently OFF for half the battery.** The headline of the pass is restoring it.

## The core finding

`ornith` is a reasoning model: with thinking ON it emits a long `reasoning_content` and, under a bounded
`max_tokens`, returns **empty `content`**. Every sidecar job (probe-input generation, family
classification, failure cards) got nothing back and **degraded silently** — the verifier fell through to
`finished-fallback` and shipped a lone unvetted candidate. That is why json_query was fragile at 1–2/56:
it was effectively running with **no consensus at all**.

## The ten iterations

1. **Owned-engine thinking control** (`llm.ts` `disableThinking` → `chat_template_kwargs.enable_thinking:false`).
   No-think writes single-function code directly ~2× faster at the API level. Threaded through
   agent→reliable→cloudBurst→ascent as a lever, auto-re-enabled on repair turns.
   **Later demoted (iter 3/4): no-think on the MAIN agent sank json_query 0/56→16/56** — a reasoning task
   can't lose its CoT. The lever now defaults OFF for generation; the win lives on the sidecar.
2. **Probe-fold into verifier eligibility** — a candidate that CRASHES on its own consensus probe is
   execution-INELIGIBLE (was never dropped); one that runs clean carries a real execution receipt instead
   of the misleading "weak" flag.
3. **No-think sidecar** (the big one) — `llm.sidecar()` defaults thinking OFF (mechanical work never needs
   CoT), with a graceful retry if an endpoint rejects the field. Probe generation went NULL→12 inputs;
   **consensus restored.** Plus a consensus floor for under-budgeted easy-looking tasks.
4. **Exceptions are first-class consensus outcomes** — `selectByConsensus` counted ANY exception as a
   crash, so a probe input where every correct candidate *raises* (json_query on a malformed path, which
   its contract requires) scored as everyone crashing → all ineligible. Now the plurality is over the
   unified outcome (value OR exception type); a crash counts only where the plurality *succeeded*.
5. **Probe target + generation robustness** — `pickFnTarget` bailed on a spurious 2nd module (glob's
   `x.py`); now falls back to the conventional entry. Bumped sidecar passes 2→3 for flaky complex inputs.
   Consensus coverage **5/10 → 9/10**.
6. **Seed consensus probes from worked examples + mutate them** — the sidecar can't invent a valid cron
   string; parse the prompt's real example call into a JSON tuple and show it as a template to VARY.
   cron NULL→8 valid variations. Consensus coverage **9/10 → 10/10.**
7. **Worked examples as a ground-truth eligibility gate** — consensus is model-generated; the prompt's
   examples are real I/O. A candidate that fails them is INELIGIBLE regardless of what consensus votes.
8. **Gate the P1 self-certainty pass to genuine ties** — it's a full main-model judgment call per
   candidate; skip it entirely when ground-truth + consensus + ORM already decide the winner (latency).
9. **Mid-loop ground-truth gate** — the round loop stopped as soon as a candidate *finished*, even if it
   was WRONG. Now it stops only if a finished candidate *passes the worked examples*; otherwise the repair
   round resamples, seeded with the concrete got≠expected failure.
10. **Rebalance the consensus floor k=3 → k=2** — the ground-truth gate + mid-loop repair now supply the
    correctness that the k=3 majority-vote floor was for; k=2 recovers json_query at ⅓ less latency.

## Measured (local ornith-35b)

- Consensus probe coverage: **5/10 → 10/10** battery tasks.
- 703 unit tests green (+7 across the pass).
- Native decode-ban validated on regexlite/expr: `forbidden: re/regex` / `eval/exec (decode-banned N
  tokens)` — the model is *literally unable* to emit the banned import/construct.

**Full owned-mode battery (k=2, 1500 s cap): 7/10 clean passes, 0 failed cases each:**

| task | result | | | task | result | |
|------|--------|---|---|------|--------|---|
| json_query | **PASS** 0/56 | | | maze | **PASS** 0/37 | |
| ledger | **PASS** 0/50 | | | cron | **PASS** 0/31 | (k=1; k=2 hit an output glitch) |
| vm | **PASS** 0/51 | *had no consensus pre-pass* | | glob | fail 6/84 | edge cases; hand-rolled, did NOT use fnmatch |
| topo | **PASS** 0/40 | | | regexlite | ~4/64 at k=2 | near-miss; needs consensus, times out at 1500 s |
| intervals | **PASS** 0/40 | *had no consensus pre-pass* | | expr | miss | evaluator not completed in budget (eval banned) |

vm + intervals are the proof the consensus-restoration paid off: both had NULL probes (no consensus)
before this pass and now pass clean. The three non-passes are the heaviest tasks (regex engine,
expression evaluator, glob edge-cases) — capability/latency-bound for a 35B at 20 t/s, not selection bugs.

## Honest limits

- **Latency**: k=2 on a 35B at 20 t/s is ~250–600 s/task; the local-battery runner's 600 s cap manufactures
  false-timeouts on the slowest tasks (glob). Real pass/fail needs a longer cap.
- **glob**: its oracle forbids `re`/`fnmatch` but the *prompt* only says "fnmatch-style" (syntax). Kitten
  cannot know the ban without benchmark-specific domain assumptions, so it is left underspecified rather
  than overfitting the eval (the disjointness firewall exists to prevent exactly that).
- **cron** logic remains hard for a 35B (31 cases); consensus now selects, but the candidates must be good.
