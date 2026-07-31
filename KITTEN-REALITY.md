# Kitten — Reality Pass report

Proving the product true under the **real local Ornith model**, not mocks. Continues from merged PR #7
(the architecture). Branch `kitten-reality`. Everything below labeled **LIVE** was exercised against
the actual endpoint; everything else is offline/deterministic.

## Live environment used

- **Endpoint:** `http://localhost:8080/v1` — a native **llama.cpp** server (unlocks streaming, grammar,
  logprobs, `/tokenize`).
- **Model:** `ornith-1.0-35b-Q5_K_M.gguf` (35B, `n_ctx=16384`), a heavy reasoning model that emits
  `reasoning_content` separately (with `max_tokens=16` it spent all 16 on reasoning and returned empty
  content — the exact hazard the harness must respect).
- Model id `ornith` is accepted (llama.cpp ignores the id and returns the loaded model).
- Throughput ~ tens of tok/s; runs serialized on the single endpoint (no concurrent main-model loads).

## 1. Claim-to-reality audit — before → after

| Claim | Before (reality) | Fix | After — proof |
|---|---|---|---|
| conversations restore | UI replayed events; the model got only the latest sentence | `core/context.ts` ContextBuilder assembles prior turns + repo truth from the store, injected into every lane | **LIVE**: turn 2 in a **fresh process** answered "Falcon" — knowable only from turn 1's context |
| streaming | LLM client was `stream:false` (whole-response) | `KittenLLM.chatStream` SSE parser + coalesced agent deltas + UI dedup | **LIVE**: a 3-sentence answer streamed as **10 incremental deltas** + one canonical final |
| verified completion | Ascent conflated `finished` with "has receipt"; direct set `verified=finished` | split finished (adopted) vs verified (execution receipt); direct never claims verified; honest grade badges | **LIVE**: correct LRUCache now reads **checked** (finished, not independently verified), not red ✗ |
| worked-example verification | returned [] when the contract missed the symbol → correct solves marked "weak" | discover call-symbols from the example shapes themselves | **LIVE**: int_to_roman went 0→5 examples; verified green |
| cancellation | shell used blocking `spawnSync` — uncancellable, orphaned children | async `bashTool` with process-tree kill; signal in ToolContext; stream abort → "cancelled" | 4 tests: prompt abort, timeout tree-kill, pre-aborted, normal exit |
| approvals cover every lane | interactive approval on direct/reliable; **safety floor on ALL lanes** | (unchanged floor) + honest scoping | floor hard-blocks catastrophic/RCE/exfil in every lane incl. sandboxed candidates |
| doctor model check | exact-matched id vs `/v1/models` → false "not loaded" on llama.cpp | ping-first (authoritative) | **LIVE**: reports "model responds", notes id mismatch |
| changed files / undo | captured Kitten's own `.cheater` + `__pycache__` as "changes" | filter generated/tooling artifacts | clean diff + undo |
| config unified | env only | `core/settings.ts` file+env precedence, validated | 3 tests; doctor shows sources + warnings |
| headless multi-turn | impossible (`run` always made a new conversation) | `kitten run -c <id>` | used to prove restart-resume live |

## 2. Live stress battery (product path: packed `kitten run` → adaptive router → Ascent)

Nine real, failure-prone single-function tasks, each scored by a **hidden oracle** the model never sees
(reset per run; oracle module-name isolated after a false-fail was caught). All routed to **Ascent k=2**
(the "has acceptance examples" signal escalates).

| Task | Oracle | Kitten grade | Notes |
|---|---|---|---|
| int_to_roman (subtractive) | SOLVED | verified | worked examples pass |
| dedup (order-preserving) | SOLVED | verified | |
| is_balanced (bracket order) | SOLVED | verified | proper stack matching |
| reverse (forbidden `[::-1]`/`reversed`) | SOLVED | verified | **ban held** — used a loop |
| LRUCache (stateful class) | SOLVED | **checked** | correct, but no clean worked examples → honest "not independently verified" |
| mutable-default bug | SOLVED | verified | |
| expression evaluator (precedence) | SOLVED | verified | genuinely hard; ~9 min k=2 |
| LRUCache retest (post-§4-fix) | SOLVED | **checked** | confirms finished≠verified split |
| failing-pytest → fix median | SOLVED | verified | red→green project-test path |

**9/9 solved correctly. Zero false-positive verifications.** The two "checked" results are the honest
case (a correct stateful-class solve with no worked examples can't be independently verified) — now
surfaced as *checked* rather than a red failure.

### Honest caveats on these numbers
- These are single-function tasks with acceptance examples — they escalate to Ascent k=2, so they are
  slower (90s–9min each) than a direct pass. A capable 35B one-shots most; the harness's value here is
  the **honest verification**, not extra solves.
- A direct-`k=1` vs adaptive vs forced-Ascent-`k=2` ablation and a real-repo multi-file suite were **not
  completed** this pass (serial single-endpoint throughput; each hard k=2 run is minutes). The numbers
  above are product-path solved/grade, not a lane comparison.

## 3. What was NOT live-verified (be honest)

- The **web UI** streaming was verified by code + the offline SSE test; a live browser session against
  Ornith was deferred (the single endpoint was saturated by the stress battery).
- **Real-repo usability suite** (§10) and the **direct-vs-ascent battery ablation** (§9) are not done.
- **Interactive approval on parallel bon/ascent candidates** is intentionally not wired — candidates run
  in sandboxed workspaces and the catastrophic floor covers them; interactive approval covers the lanes
  that mutate the real workspace.
- Loop-resistance heuristics (§12) beyond the existing empty-turn/verification-spiral caps: not expanded.

## 4. Tests / build

**775 offline tests green** (was 755 at the merge). New: context continuity (5), streaming chunk-parser
over a fake SSE server (6), cancellation/tree-kill (4), settings precedence (3), §4 adversarial
finished≠verified (1), worked-example discovery (2). Build + typecheck clean; package smoke unaffected.

## 5. Smallest next move

1. Run the direct-`k=1` vs adaptive vs Ascent-`k=2` ablation through `kitten run` on the hard subset when
   the endpoint is free; record versioned traces.
2. One live browser session (stream, approve, diff, resume) against Ornith.
3. A small hidden-oracle real-repo suite (multi-file localization, forbidden-test-edit, dirty repo).
