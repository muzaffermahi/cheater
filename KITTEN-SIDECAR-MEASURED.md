# Two measured tasks, and why the sidecar was doing nothing

Live runs against `ornith-1.0-35b` (Q5, experts on CPU, ~20 tok/s) via llama.cpp, and
`qwen3.5-2b` via LM Studio. Hidden behavioral oracles the model never saw; both oracles were
validated against reference implementations first (9/9 and 13/13) **and** against the seeded bug
(6/9), so a passing score means something.

---

## Part 1 — does the harness produce good code?

Yes, on both. The problems are latency and reporting, not correctness.

| | Task A — bug fix | Task B — from scratch |
|---|---|---|
| Prompt | 2 seeded defects, prose report, no visible test | expression evaluator, multi-module, no visible test |
| Lane | `reliable` | `ascent` (k=2) |
| Wall clock | **146 s** | **589 s** |
| Prompt tokens | 9,354 | 30,835 |
| Completion tokens | 1,120 | 3,681 |
| Tool calls | 3 (read, edit, bash) | 0 recorded |
| **Hidden oracle** | **9/9** | **13/13** |

**Task A** produced almost exactly the reference fix: `<` → `<=` for touching intervals, and a
defensive copy to stop mutating the caller's array. Both reported defects fixed, nothing invented.

**Task B** produced four modules — `tokenizer.js`, `parser.js`, `evaluator.js`, `index.js`, 180
lines — with correct precedence, left-associativity, unary minus before parentheses, and throwing
on both unbalanced parens and garbage characters. That is a genuinely correct recursive-descent
parser written from a prose spec.

### What the measurement exposed

**Reasoning tokens are not being counted.** `usage.reasoning` was `0` on both runs while the
reasoning *stream* carried 2,092 characters on Task A. llama.cpp does not report a separate
reasoning-token count, so any budget logic keying on `usage.reasoning` is reading a constant zero.
Not fixed here — flagging it, because it silently disables reasoning-budget accounting.

**Context exceeded at 8k.** Task B hit
`HTTP 500: Context size has been exceeded` mid-run. The server's `n_ctx` is 8192 while Kitten's
default `contextWindowTokens` was 16384 — the harness believed it had twice the room it had. Your
config now sets 8192 explicitly.

**589 s for one task** is the real cost of the Ascent lane on this hardware: two candidates, each a
full agent loop, serialized through one GPU.

### Two reporting bugs, both fixed

1. **`filesChanged: []` on a run that wrote four correct files.** Ascent derives changed files from
   `git diff` against a pre-run snapshot; a non-git workspace has no snapshot, so it reported
   nothing. That silently disables `/undo`, empties the diff view, and skips postflight review — the
   receipt claims nothing happened while the work sits on disk. `adoptWorkspace` now returns what it
   copied, and the runner falls back to it when git cannot answer.

2. **A verified run summarized as a hard failure.** Task B's summary was
   `model call failed: HTTP 500: Context size has been exceeded` — on a run that was correct and
   execution-verified. The winner's summary is simply the last thing its agent said, which after a
   long run is often an error from a turn *after* the work was done. A verified run now leads with
   what it achieved and keeps the error as trailing context, never dropped.

---

## Part 2 — why the sidecar was inert

Four separate causes. Only the first was visible from the code.

### 1. It was never called during a run

Every `runCatalogJob` call site lived in `desktopEngine.ts`. The CLI, TUI, web client and every
subagent run got nothing, and even the desktop app only ran it from its own IPC handler.

**Fixed:** a shared `SidecarAssist` layer wired into `KittenApp`, so every client gets postflight
review and failure triage from one implementation. The desktop engine's duplicate was deleted.

It is **fire-and-forget**: `run.completed` and `receipt.finalized` are emitted first, so a UI shows
the finished run immediately and `submitMessage` never waits on advisory work.

### 2. Structured jobs almost always failed validation

The job prompt said only *"Return a concise JSON object for sidecar job `postflight_review`"*. The
model was never told which fields were expected. Measured live, it returned:

```json
{"id":"...","type":"postflight_review","job_id":"x","status":"approved","summary":"...","verified_files":["src/interval.js"],"notes":"..."}
```

Perfectly reasonable JSON, and not one field the validator requires — so it was rejected and the job
fell back to its regex floor. **This is the main reason the sidecar looked inert: its structured
jobs were rarely usable, and the fallback hid it.**

**Fixed:** every structured job now carries a real JSON schema, sent as `response_format:
json_schema`, which llama.cpp compiles to GBNF — the wrong shape becomes ungeneratable rather than
rejected after the fact. After the fix, on the same input:

```json
{"secrets":[],"warnings":["Change from strict less-than (<) to less-than-or-equal (<=) may alter
interval boundary logic..."],"risk":"low",...}
```

That is a real review: it found the actual semantic change in the diff.

### 3. The deadline was shorter than the work

The 8 s budget expired on nearly every review. Measured on the 35B: `postflight_review` **20.5 s**,
`explain_error` **7.6 s**. So the layer fell back every time while looking like it worked.

**Fixed:** 30 s for assist jobs. They are fire-and-forget with the main model idle, so the budget
costs no foreground latency — and an assist that always times out is strictly worse than one that
takes 30 s.

### 4. A small model echoed Kitten's internal bookkeeping

With a real 2B, a `triage_logs` job returned `signature: "assist-triage-0"` — it had copied the
scheduler's job id straight out of the serialized input. A schema constrains an answer's *shape*,
never its *content*.

**Fixed:** `id`, `premise` and `deadlineMs` are stripped before the payload reaches the model. The
same job now returns `signature: "parser failed at parser.ts:4"`.

### Plus one honesty bug

With no model configured, `runCatalogJob` returned the deterministic floor from inside the job body,
so the scheduler labelled regex output `source: "sidecar"`. Callers were reporting deterministic
analysis as model analysis. It now throws so the declared fallback handles it.

---

## Part 3 — you have a real second tier and it was unused

**Correction to something I said earlier in this session:** I claimed the sidecar was silently the
35B. That was true of your *configuration*, not your machine. LM Studio is running on `:1234`
serving a genuine `qwen3.5-2b`; your config simply had no `sidecarBaseUrl`, so sidecar calls went to
llama.cpp on `:8080` and were answered by the 35B — llama.cpp serves whatever is loaded for an
unknown model name rather than returning 404, so the misconfiguration was invisible.

Measured, same triage job:

| Sidecar target | Latency | Result |
|---|---|---|
| llama.cpp `:8080` (really the 35B) | 7.6 s | correct |
| LM Studio `:1234` (real 2B) | **3.6 s** | correct, and the 35B stays free |

Your `~/.kitten/config.json` now sets `sidecarBaseUrl`, and `kitten doctor` reports the tier:

```
✓ sidecar 'qwen3.5-2b' runs on its own endpoint
```

If the sidecar is really the main model, doctor says so and tells you how to fix it. If LM Studio is
closed, calls fail and fall back to the deterministic floor — degraded, never broken.

---

## What is scheduled where, and why

The report's "hide sidecar work under main-model latency" assumes background work is free. On a
single-model endpoint it is not: the sidecar *is* the main model, competing for the same KV and
memory bandwidth. So assist work runs where the main model is genuinely **idle** — after the run
reaches a terminal state, while the user reads the result. With a separate endpoint (your setup now)
that contention disappears and the two can genuinely overlap.

## Still not done

- **Research / web-search-when-stuck** — not built. `webScout.ts` exists but nothing triggers it
  from a stuck run, and "stuck" has no detector yet. This is the largest of your four suggested
  roles and the honest next milestone.
- **Nothing runs *during* a turn.** File ranking, test selection and next-file prefetch would need a
  scheduler keyed on input hashes with stale-result rejection. Worth doing now that a real second
  endpoint exists.
- **Reasoning-token accounting is broken** (`usage.reasoning` is always 0 on llama.cpp).
- **Runtime benefit is unmeasured.** Every claim above is a latency or correctness measurement of the
  sidecar layer itself. Whether postflight review and triage improve *task success* needs a battery.
