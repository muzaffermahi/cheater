# Kitten — Correctness-Hardening Pass

An overnight, fully-offline correctness pass on branch `kitten-hardening` (off `kitten-reality`).
No live model or Docker was available, so every fix is verified by the deterministic test suite
(**775 → 820 tests green**, +45 regression tests; build + typecheck clean throughout). Run in **three
waves** of adversarial bug-hunters (17 agents total): (1) the freshest reality-pass code; (2) the run
orchestrator, agent loop, planner/resampler, best-of-N, validation ledger, and web server; (3) the
from-scratch scaffolding, routing policy, and the served-page client JS. **34 fix commits** in all (several bundle two related findings). The
first wave's fixes are catalogued below; waves two and three follow near the end.

## Method

Seventeen adversarial bug-hunter agents (across three waves) were fanned out over the hottest and
most-recently-changed subsystems, each instructed to report only defects it could trigger with a concrete input/state
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

## Second wave (run orchestrator, agent loop, planner, best-of-N, ledger, web)

### More false greens / verification honesty

21. **reliable/bon lanes recorded `verified:true` for a force-allowed finish** — `core/agent.ts` +
    `runner.ts`. After the finish-gate rejection budget, finish is force-allowed (anti-loop) but was
    recorded as verified though no receipt was obtained. New `forcedFinish` flag; `verified = finished &&
    !forcedFinish`.
22. **`rm -Rf` deleted verified output** — `runstate/postSuccessGuard.ts`. The broad-destruction pattern
    was case-sensitive, so the BSD/macOS `-Rf` form slipped the block. Now `/i`. (Also: a substring match
    false-blocked `output.json.bak`; now boundary-anchored.)

### Ascent-pipeline correctness

23. **Round-local attempt indices collided across repair rounds** — `core/ascent.ts`. cloudBurst assigns
    round-local `1..k`, but cascade/verifier/measure use `index` as a global identity — round 2 shadowed
    round 1, so the wrong workspace could be adopted and Best@1 mis-scored. Reindex on concat.

### Command gating (false blocks of legitimate commands)

24. **Noun gate false-blocked create-then-use and `mkdir -p`** — `reliability/nounGate.ts`.
    `echo … > t.py && python t.py` blocked (t.py not yet on disk); `mkdir -p a/b` blocked on a missing
    parent it creates. Skip a must-exist path created earlier in the same command; don't parent-gate
    `mkdir -p`.

### Diff accounting / dependency intent

25. **Diff under-count on `---` + dependency-intent over-match** — `commitlet/guard.ts`. An unanchored
    `---` dropped real content lines from the count (feeds the size cap, health, selection tiebreak);
    "package"/"module" as bare nouns demoted an incidental manifest edit. Anchored the header exclusion;
    tightened dependency intent to package-manager commands / the word "dependency" / an article-led
    count-noun.

### Web server security + robustness

26. **Web-augment fetch followed redirects off the allow-list (SSRF-lite)** — `core/webAugment.ts`. The
    allow-list was checked only on the initial URL, and `redirect:"follow"` let a 3xx to an off-list host
    (or `169.254.169.254`) be fetched and injected. Now manual redirects with a per-hop allow-list check.
27. **`readJson` returned null for a JSON `null` body** — `core/web/server.ts`. Handlers destructured null
    → 500. Treat a non-object body as empty.

### Run lifecycle honesty

28. **cancel() deadlocked a run parked on an "ask" approval** — `core/app.ts`. Abort didn't resolve the
    pending approval promise; the agent hung forever. cancel() now denies pending approvals so the run
    reaches a terminal state.
29. **Mid-generation cancel / answer-lane model error mislabeled** — `core/agent.ts` + `runner.ts`. A
    cancel during the LLM call reported `stopReason:"error"` (now `"aborted"`); an answer-lane model error
    was recorded `completed` (now `failed`/`cancelled` like the coding lanes).
30. **Scoped "do not modify X" misrouted a fix request to answer-only** — `autopilot/classifier.ts`. A
    scoped negation suppressed the real "fix" verb. Strip only the negated clause (verb adjacent to the
    negation) before intent tests; a global read-only and a positive "don't forget to fix" are preserved.

### Second-wave finding acknowledged but not changed

- **Web-augment anti-leakage refusal is inert for the id-only eval sets** (`webAugment.ts` +
  `disjointness.ts`) — the TB2 / local-battery sets are registered with ids but no task *texts*, so the
  fingerprint refusal can't fire for them. Low practical impact (the augment query is an error signature,
  not the task text, and web knowledge about error *classes* is explicitly permitted; the actual
  task-solving firewall — `isEvalId` on the experience store — works independently). A full fix needs the
  eval task texts, which are not in the repo; fail-closing would disable the feature. Left as-is.

## Third wave (from-scratch scaffolding, routing policy, served-page client JS)

### From-scratch build path (the flagship natural-prompt → app use case)

31. **Scaffold stamped an un-runnable app when the model relocated the entry set** — `blueprint/stackTemplates.ts`.
    The Vite entry triple (index.html → /src/main.*, main.* → ./index.css) is stamped with hardcoded
    canonical cross-links, but the model's own non-canonical paths (flat layout, public/index.html) were
    honored — so `vite build` failed on inconsistent bytes the harness wrote. Skip stamping the entry
    group when a coupled file is relocated; the model then authors them coherently.
32. **`npm install` hardcoded for any manifest** — `blueprint/scaffold.ts` + planner/executor. A
    Python/Go/Rust build (the literal Flask+React case) got a JS-only install instruction. Pick the
    command from the manifest (`installCommandForManifest`).
33. **isFromScratchBuild false-positived over an existing repo** — `blueprint/scaffold.ts`. repoHasManifest
    checked only the root (missing a monorepo's `frontend/package.json`), and the verb-less branch fired on
    fix goals. Check one subdir level; exclude edit/fix verbs.
34. **Non-`src/` React entry mis-ordered** — `commitlet/planner.ts`. `index.{jsx,tsx}` in any directory is
    now the app `entry` (built last), not `foundation`.

### Worker prompt / impact classifier

35. **Contradictory multi-file acceptance criteria** — `commitlet/spec.ts`. A multi-file phase got one
    "X is the only edit target" line PER file (mutually exclusive), rendered into the model's prompt. Name
    them jointly. (Same commit: two benchmark-scoped impact-classifier regex mislabels — keyword-less TS
    signatures missed, `a/b` flagged as a command registration.)

### Web UI honesty

36. **Prose collapsed above tool cards + fake approvals** — `core/web/page.ts`. Assistant deltas keyed by
    runId reused one bubble, so all of a run's prose rendered above the tool cards it followed; and the
    approval card showed "Approved" even when the server reported nothing pending. Track a single open
    bubble closed by any non-streaming event; check the approve response's `ok`.

### Third-wave findings acknowledged but not changed

- **TUI mascot state is tracked but never live-rendered** (`core/tui.ts`) — the streaming terminal writes
  content inline and has no cursor-based status redraw, so the compact face is shown only at boot / via
  `/cat`; the `st.mascot` transitions (thinking/working/verifying) drive nothing. A proper fix is a TUI
  status-redraw feature, not a correctness change — left as a known limitation.
- **A web approval replayed from history renders as actionable** — the deeper fix (stop showing a fake
  success, done in #36) is landed; making a *historical* approval non-actionable needs an
  approval-resolution event in the log, deferred.

## Not changed (verified clean)

`core/bestofn.ts`, `core/selfCertainty.ts`, `commitlet/rollback.ts`, `reliability/failureCompressor.ts`,
`autopilot/policy.ts`, and `blueprint/worker.ts`
were read in full and found correct. Several tempting hypotheses were refuted during verification rather
than shipped (e.g. the ascent `verdict.winner` index is 1-based, not an off-by-one; crash/exception paths
correctly mark `failed`; the validation-ledger/computeBudget/phaseController "suspicions" were unreachable
in the live wiring).

## What was NOT done (during the hardening pass)

- No live-model or browser verification (endpoint down, Docker off) — all fixes are offline-verified.

## Polish pass (post-hardening, 821 tests green)

After the hardening pass, a UI polish pass addressed the remaining gaps:

- `blueprint/webScout.ts` — added module-level documentation (8 trigger kinds, regex detection)
- `commitlet/executor.ts` — added module-level documentation (7-step prompt assembly pipeline)
- `core/web/page.ts` — Markdown overhaul (headings, lists, code blocks with copy/syntax-highlight,
  rename modal, typing indicator, timestamps, keyboard shortcuts, favicon, conversation delete,
  retry/regenerate, model badge, SVG icons), offline banner debounce, jump-to-bottom button
- `core/tui.ts` — live status line with mascot/spinner/elapsed time, tab completion, history
  persistence, multi-line messages, `/search` and `/status` commands, Ctrl+C feedback
- All entry points — `unhandledRejection` crash handlers
- Web server — conversation validation before `submitMessage`, `/api/status` endpoint
- `cheater-pi/RELEASING.md` — created with release gates, tagging, and trusted-publishing procedure
- `kitten init` command — guided first-time setup with provider-specific endpoint diagnostics
- Doctor — endpoint failure classification (refused/auth/timeout) with actionable guidance
