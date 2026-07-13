# Kitten — Correctness-Hardening Pass

An overnight, fully-offline correctness pass on branch `kitten-hardening` (off `kitten-reality`).
No live model or Docker was available, so every fix is verified by the deterministic test suite
(**775 → 802 tests green**, +27 regression tests; build + typecheck clean throughout).

## Method

Eight adversarial bug-hunter agents were fanned out across the hottest and most-recently-changed
subsystems, each instructed to report only defects it could trigger with a concrete input/state
(the project's cardinal rule: **zero false positives**). Every finding was then re-verified by hand
against the real code before any change, fixed with a regression test that fails without the fix, and
committed on its own. Two findings were independently confirmed by two agents, one by three — those
are the highest-confidence items below.

## Fixes (most-severe first)

### Verification honesty — false greens (the project's crown-jewel concern)

1. **Weakly-eligible winner credited with a green execution receipt** — `core/verifier.ts`.
   `winnerHasExecutionReceipt` OR'd in `usedExecution && win.executionEligible`, true whenever *any*
   candidate had execution evidence — so a winner that only passed the finish gate was reported
   "verified" because a *different* candidate had a signal. The ranking also had no weak-vs-strong key,
   so a weakly-eligible candidate could win on index order and be applied over a truly-verified one.
   *(confirmed by 2 independent passes)*
2. **Command-less commitlet reported "verified" with zero commands run** — `commitlet/kernel.ts`.
   `runFocusedVerification` returns a vacuous `passed:true` when there is no command-backed step; the
   kernel recorded it as `focused_tests: ok`, so the finish gate claimed "verified" though nothing ran,
   and defeated the honest `noRunnableCheck` path. Now records `skipped` + `noCommandAvailable`.
   *(confirmed by 3 independent passes)*
3. **Bookkeeping-only stages satisfied "verified"** — `reliability/lifecycle.ts` + `verificationRunner.ts`.
   `isTerminalVerified` accepted any `ok` stage, but CLI/webapp plans record `prepare_env` /
   `collect_artifacts` / `summarize` as ok-by-construction. A project with every real test skipped
   reported PASSED. Now requires an ok stage from the EVIDENCE set (build/smoke/focused_tests/
   full_tests/scoring/typecheck); no-command skips carry `noCommandAvailable` so uncheckable projects
   finish honestly-unverified instead of blocking forever.
4. **`>>` append redirects not recorded as mutations** — `runstate/mutationLedger.ts`. The regex matched
   `>` truncation but not `>>`, so an append after a passing check never staled that validation — a
   stale green could be repeated as fresh.
5. **Un-loadable candidate folded as a passing self-probe** — `core/verifier.ts`. `runFnProbes` returns
   null for a module that won't load, leaving `crashes[i]=0`, so the fold recorded `probe="pass"` for
   code that never loaded. Now gated on a non-null outcome.
6. **Red-green screen left contract artifacts reverted** — `commitlet/checkFirst.ts`. The screen restored
   only source files, so the red re-run's clobber of an app-written deliverable (e.g. `output.json`)
   was left stale on disk. Now snapshots/restores the contract's output artifacts too.

### Verification honesty — false reds (a correct solution wrongly rejected)

7. **Worked-example parser truncated numeric expecteds** — `core/workedExamples.ts`. `1e6` captured only
   `1` (and `1_000`→`1`, `6.02e23`→`6.02`), so a correct solution returning 1000000 failed against `==1`.
   Also added the `...` ellipsis guard to `extractSetupVars` (abbreviated setup ran as Python `Ellipsis`).

### Data loss / durability

8. **`/undo` permanently deleted pre-existing untracked files** — `core/undo.ts`. `git stash create`
   captures only tracked content, so an untracked file was absent from the snapshot and undo deleted it
   as "run-created" — erasing a user file the run merely edited. Now captures pre-run untracked paths +
   content and restores (never deletes) them.
9. **Store migration was not atomic** — `core/store/conversationStore.ts`. Version read/apply/set spanned
   the transaction boundary, so two concurrent first-opens (TUI + web) could crash on "table already
   exists", and a mistimed crash bricked the DB. Now all inside one `BEGIN IMMEDIATE`.

### Client robustness

10. **LLM per-call timeout disabled when a caller passed a signal** — `core/llm.ts`. The timeout timer
    aborted an internal controller while `fetch` listened to the caller's signal — so the normal
    agent/stream path had *no* timeout; a stalled model hung indefinitely. Now composes both with
    `AbortSignal.any`. *(also independently confirmed)*
11. **SSE parser dropped the whole stream on CRLF framing** — `core/llm.ts`. Splitting only on `\n\n`
    never matched `\r\n\r\n`, returning a silent empty `ok:true`; a final frame without a trailing blank
    line was also dropped. Now matches any SSE separator and flushes at EOF.
12. **bash: NaN timeout instant-kill + multibyte corruption** — `core/tools.ts`. A non-numeric
    `timeout_seconds` made `setTimeout(NaN)`≈0ms (instant kill, false timeout); per-chunk `toString`
    mangled multibyte chars across chunk boundaries. Fixed with a finite-number guard + `StringDecoder`.
13. **edit tool: lenient match dead on CRLF + silent wrong-region edit** — `core/tools.ts`. The
    whitespace-lenient matcher rejoined lines with `\n` and `indexOf`'d that against raw text (never
    matched a `\r\n` file), and applied the first of multiple normalized matches. Now maps line spans to
    exact offsets (CRLF-safe) and errors on 2+ matches like the exact path.

### Routing / config / contract parsing

14. **Router over-escalated on a single complexity keyword** — `core/router.ts`. One generic signal
    ("test", "config") sent ordinary tasks through best-of-N. Now requires ≥2 signals, matching the
    classifier/policy threshold.
15. **Invalid/empty `KITTEN_*` env silently overrode valid config** — `core/settings.ts`. `??`-based
    precedence kept `""` and `NaN`, discarding valid file values. Now normalizes env (blank→unset,
    invalid number→warn+fall through).
16. **Contract parser: input files tagged as outputs + prose extracted as symbols** — `runstate/contract.ts`.
    An input in a sentence with a write verb became an output artifact; `SYMBOL_DECL_RE` turned
    "a function that…" into the symbol "that". Now the output verb must govern the file, and a symbol
    must be code-shaped.
17. **Filesystem paths extracted as HTTP endpoints** — `runstate/contract.ts`. `/var/tmp/cache` became
    an endpoint (even the primary evaluator hint). Now excludes well-known FS roots.

### Conversation history honesty

18. **Cancelled/interrupted run described as "in progress"** — `core/context.ts`. `digestTurns` ignored
    the `run.cancelled` / `run.interrupted` terminal events, so the model's context implied an aborted
    run was still running. Now surfaces them honestly.
19. **Search index kept the oldest text** — `core/store/conversationStore.ts`. `substr(…, 1, 20000)`
    dropped every message past the first 20k chars; recent messages became unsearchable. Now keeps the
    newest tail.

### Efficiency / correctness edge

20. **Scaffold incomplete-counter leaked across runs** — `commitlet/kernel.ts`. A module-global counter
    keyed by a non-plan-scoped id let an interrupted build's counts skip the grace re-asks of a later
    same-process build. Now reset at the start of each run.

## Not changed (verified clean)

`core/bestofn.ts` and `core/selfCertainty.ts` were read in full and found correct (the selection-index
bookkeeping across rounds is consistent; the self-certainty math is careful). Several tempting
hypotheses were refuted during verification rather than shipped (e.g. the ascent `verdict.winner` index
is 1-based, not an off-by-one; crash/exception paths correctly mark `failed`).

## What was NOT done

- No live-model or browser verification (endpoint down, Docker off) — all fixes are offline-verified.
- Uncovered subsystems (`blueprint/*`, `sidecar/jobs`, `core/web/page.ts`, `core/app.ts`, `core/agent.ts`,
  parts of `commitlet/`) were not deeply hunted in the first wave.
