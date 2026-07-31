# Kitten Task Compiler

A compiler layer between the user's request and the expensive main-model call.

```
Human request  →  minimal task contract + repository evidence + preserved invariants
                  + execution policy + verification contract
```

The governing rule:

> Do not make the expensive model infer anything that deterministic code, repository evidence, an
> established project convention, a small sidecar model, or an explicit user instruction can settle
> first.

On this hardware that rule has teeth. Main-model decode is ~20 tok/s with a 35B-A3B whose experts
stream from CPU, so every token of prompt and every avoidable decision is real wall-clock time.

---

## Where it enters

`KittenApp.submitMessage` (`cheater-pi/src/core/app.ts`) — the single entry every client uses:

```
context.build()            durable history + repo capsule
      ↓
emit user.message
      ↓
compile()                  ← the Task Compiler
      ↓                      persists the IR + trace, emits task.compiled
[clarify?] → ask one question, no model call
      ↓
route()                    the contract may supply a lane hint
      ↓
runner(ctx)                conversationContext = history + sidecar + CONTRACT (contract last)
```

The contract is appended **last**, after durable history and the sidecar capsule. Volatile-last is
the only layout that lets llama.cpp reuse a warm prefix — it has no API to edit mid-prefix KV.

---

## Compilation modes

Selected by **deterministic categorical rules** — explicit missing-field checks, never a numeric
quality score.

| Mode | When | Effect |
|---|---|---|
| `passthrough` | request already states deliverable, scope, constraints **and** verification | injects nothing |
| `enrich` | clear request needing grounding, invariants, or the missing verification | small contract |
| `compile` | deliverable/scope underspecified, or material decisions unresolved | full contract |
| `clarify` | a **blocking** ambiguity survived evidence and safe defaults | asks one question, no model call |

---

## Ambiguity is categorical, never numeric

| Kind | Meaning | Behavior |
|---|---|---|
| `blocking` | changes the deliverable, or cannot be resolved safely | may interrupt the user |
| `material` | could cause substantial rework | resolve from evidence, else defer to the main model |
| `reversible` | cheap to change later | pick a default, record it as an assumption |
| `irrelevant` | needs no resolution | never rendered |

Resolution priority (`RESOLUTION_PRIORITY` in `ir.ts`):

```
explicit user instruction → repository evidence → project convention
→ safe default → main-model judgment → ask the user
```

Asking is **last**. An agent that asks which shade of blue has not started work.

---

## No confidence or score fields

Not on requirements, not on ambiguities, nowhere in the IR. A model emitting `0.87` is not
calibrated; it is decoration that invites downstream code to threshold on noise. Trust comes from
`source` + `evidenceRefs`, both inspectable.

Enforced structurally: `findProhibitedScoreFields()` walks the serialized IR, so a future
`qualityScore` fails a test rather than quietly becoming a number the router reads. This is scoped to
the compiler's semantic layer and does **not** touch Kitten's low-level logprob infrastructure, which
is real telemetry.

---

## Provenance

Every requirement carries where it came from:

```ts
source: "user" | "repository" | "session_memory" | "project_policy" | "default" | "model_inference"
```

The validator enforces two rules that matter more than the rest:

- a `must` may **never** have source `model_inference` — inference must not masquerade as user intent;
- a requirement claiming `repository` provenance must cite evidence that exists.

---

## Verification is compiled before implementation

Checks are generated from the family and repository evidence **before** the model writes code. A
model that knows the completion condition writes toward it; a model asked to justify itself
afterwards writes a defense.

Every check declares whether anything can actually run it:

```ts
provenance: "provided_by_repository" | "added_by_kitten"
          | "requires_model_inspection" | "not_automatically_verifiable"
```

A check with no command and no assertion is marked `not_automatically_verifiable` and never counts as
evidence. Ceremonial acceptance criteria are structurally impossible, and the validator rejects a
check that claims otherwise.

The full IR is persisted (`task_compilations` table), so the verifier evaluates the **original**
compiled task after a restart — never a summary written after implementation.

---

## Constraint slicing

Each consumer receives the smallest relevant slice (`sliceContract(task, slice)`):

| Slice | Receives |
|---|---|
| `localize` | goal, surfaces, repository evidence — **no** verification commands |
| `patch` | behavior, invariants, non-goals, required checks |
| `verify` | requirements, invariants, required + regression + **adversarial** checks |
| `integrate` | invariants, constraints, evidence |
| `full` | the implementer's contract — deliberately **excludes** adversarial probes |

Adversarial probes reach the verifier only. See the finding below for why that is not a stylistic
choice.

---

## Two findings measured against the real model

Both came from live A/B runs on `ornith-1.0-35b` via llama.cpp, not from reasoning about the design.

### 1. The compiler induced scope creep — and the obvious culprit was innocent

Task: *"Make slugify lowercase the string and replace spaces with hyphens in src/slug.js."*

- compiler **off** → `return s.toLowerCase().replace(/ /g, '-')` — correct, minimal.
- compiler **on** → imported `zod`, added a schema, validated the input. Nobody asked for validation.

Three hypotheses, tested in order:

| Hypothesis | Result |
|---|---|
| The wording "reuse the existing zod setup" reads as "use zod" | reworded as a prohibition — **still added zod** |
| Merely naming an available dependency invites its use | roster withheld entirely — **still added zod** |
| The adversarial probe is read as a requirement | probe moved to the verifier slice — **fixed** |

The actual cause was the line *"The new behavior fails cleanly on invalid input instead of appearing
to succeed."* A model reads every rendered line as an instruction. A probe describes how the work
will be **checked**; it is the verifier's business, not a requirement to build defenses.

The first two changes were kept anyway — the dependency roster genuinely fails the "does this change
an implementation decision" test for a bounded edit to a named file.

### 2. The repository capsule is not conversation history

`ContextBuilder.build()` returns a non-empty preamble on a brand-new conversation in any git repo,
because it includes the repo capsule. Treating that as "has history" would have disabled the
blocking-ambiguity check on exactly the first-turn requests that need it. `BuiltContext.hasPriorTurns`
now states the fact directly.

---

## Configuration

`~/.kitten/config.json`, project `.kitten/config.json`, or `KITTEN_TASK_COMPILER`:

```json
{ "taskCompiler": "auto" }
```

| Value | Behavior |
|---|---|
| `off` | true no-op — no compilation, no event, no store write, no context change |
| `auto` | **default**; mode selected categorically |
| `force` | never selects `passthrough`; still cannot override a blocking ambiguity |

Runtime: `app.setTaskCompiler(flag)` — no restart needed.

**Failure containment:** a compiler that throws, or produces a contract that fails validation, is
discarded and the run proceeds unchanged. A malformed contract is worse than none — it points the
model somewhere specific and wrong with a contract's authority behind it.

---

## Observability

`task.compiled` records stage facts — mode, family, counts, tokens in/out, repository queries, stage
timings, prompt epoch, validation warnings. Never an aggregate score.

`task.clarification_requested` records the one question and the ambiguity that forced it.

---

## Evaluation

`measureCompileSide()` + `renderEvaluation()` compare three arms over `EVALUATION_FIXTURES`:

- **A `raw`** — the request, unmodified (today's behavior)
- **B `contract`** — structured contract, no repository reads
- **C `grounded`** — full repository-grounded compile (production)

Compile-side metrics need no model and run in CI. Current numbers against this repository:

```
arm        cases  contract tok  inflation  clarify%  invented  misfamily  inflated-precise
raw            8             0       0.00        0%         0          0                 0
contract       8            77       5.19       13%         0          0                 0
grounded       8         211.5      11.86       13%         0          0                 0
```

`invented = 0` is the one that matters: no arm leaked a forbidden term on any fixture.

**Runtime metrics are not measured here.** Verified completion, main-model calls, repair iterations
and wall clock require running the arms against a real model on real tasks. The harness accepts them
through `EvaluationOutcome` and prints *"not measured in this run"* rather than zeros that would read
as results.

---

## Files

| Path | Role |
|---|---|
| `src/core/taskCompiler/ir.ts` | typed IR, canonical serialization |
| `src/core/taskCompiler/extract.ts` | Stage 1 — literal extraction |
| `src/core/taskCompiler/family.ts` | Stage 2 — family + typed templates |
| `src/core/taskCompiler/grounding.ts` | Stage 3 — repository evidence |
| `src/core/taskCompiler/ambiguity.ts` | Stage 4 — categorical resolution |
| `src/core/taskCompiler/verification.ts` | verification-contract synthesis |
| `src/core/taskCompiler/validate.ts` | spec validation + score-field scan |
| `src/core/taskCompiler/render.ts` | canonical rendering + slicing |
| `src/core/taskCompiler/compile.ts` | the pipeline |
| `src/core/taskCompiler/evaluate.ts` | A/B/C harness + fixtures |
| `src/core/promptEpoch.ts` | canonical JSON, path/text normalization, prompt epochs |

Integration: `src/core/app.ts`, `src/core/events.ts`, `src/core/store/conversationStore.ts` (v5),
`src/core/settings.ts`, `src/core/context.ts`, `src/core/desktopEngine.ts`.

Tests: `test/task-compiler.test.ts`, `test/task-compiler-integration.test.ts`,
`test/task-compiler-eval.test.ts`.

---

## Known limitations

- **No sidecar participation.** Every stage is deterministic. The 2B is not called, so `sidecarCalls`
  is honestly always 0. This is deliberate: a blocking 2B call before every turn would add latency to
  buy a classification the deterministic floor already produces. Sidecar refinement belongs under the
  hidden-latency scheduler, where it can run *beneath* main-model decode rather than in front of it.
- **Family classification is regex-based.** It inherits the shared autopilot classifier, which is
  loose in places — `replace X with Y` was being called a migration. The compiler now requires
  corroborating evidence, but the underlying classifier was deliberately left alone (the router and
  other callers depend on its behavior).
- **Grounding does not use an LSP.** Manifests, directory conventions, named-file existence, and
  optional workspace-index ranking only. No symbol resolution, no reference counts.
- **The workspace index must already be populated.** The desktop engine passes one only when it has
  files; otherwise candidate ranking silently degrades to deterministic grounding.
- **Runtime effectiveness is unmeasured.** Compile-side properties are enforced by tests. Whether
  contracts improve *verified completion rate* on real tasks needs a battery run against the real
  model, per task family. Two single-task live A/Bs are evidence of specific defects, not of overall
  benefit.
