// Task Compiler — canonical prompt rendering.
//
// The renderer's job is SUBTRACTION. Everything in the IR is true; almost none of it earns its tokens
// on a 16k context. A fact is rendered only if it answers one of six questions:
//   what must change · what must not change · what repository fact affects implementation ·
//   what decision is already settled · how this will be verified · what execution policy applies.
//
// So the output is a compact contract, never a paraphrase of the request with adjectives. In
// particular it never contains: compiler commentary, resolved-ambiguity discussion, difficulty
// language, sidecar reasoning, confidence words, or generic engineering advice. `render.ts` is the
// last gate before those reach the main model, and the tests assert on their absence.
//
// Output bytes are canonical: fixed section order, deduplicated lines, sorted-where-order-is-not-
// meaningful, `/` paths, LF newlines. Two structurally equal contracts render identically, which is
// what lets llama.cpp reuse a prefix across retries and typed subagents.

import { normalizePathForPrompt, normalizeText } from "../promptEpoch.js";
import { approxTokens, type CompiledTask, type Requirement, type VerificationCheck } from "./ir.js";

/** Which slice of the contract a consumer receives. Constraint slicing (report §"typed agents"):
 *  a localizer does not need the verification commands, and a verifier does not need the rendered
 *  goal prose — sending them anyway is context the model must read past. */
export type ContractSlice = "full" | "localize" | "patch" | "verify" | "integrate";

const MAX_LINE = 220;

function line(text: string): string {
  const one = normalizeText(text).replace(/\s+/g, " ").trim();
  return one.length > MAX_LINE ? `${one.slice(0, MAX_LINE - 1)}…` : one;
}

/** Deduplicate case-insensitively while preserving first-seen order (order carries meaning here). */
function uniqueLines(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const rendered = line(value);
    const key = rendered.toLowerCase();
    if (!rendered || seen.has(key)) continue;
    seen.add(key);
    out.push(rendered);
  }
  return out;
}

function section(label: string, items: string[]): string {
  return items.length ? `${label}:\n${items.map((item) => `  - ${item}`).join("\n")}\n` : "";
}

function requirementLines(requirements: Requirement[], strength: Requirement["strength"]): string[] {
  return uniqueLines(requirements.filter((r) => r.strength === strength).map((r) => r.text));
}

function checkLine(check: VerificationCheck): string {
  if (check.command) return `${check.claim} (run: ${check.command})`;
  if (check.provenance === "not_automatically_verifiable") return `${check.claim} — not automatically verifiable; state this explicitly rather than claiming it passed.`;
  return check.claim;
}

/**
 * Render the contract for the main model. Trimming order is fixed and lowest-value-first, so a
 * contract that must shrink loses preferences before it loses obligations:
 *   may → should → assumptions → non-goals → repository evidence → adversarial checks.
 * `must`, `must not`, and the required checks are never dropped — if those do not fit, the contract
 * is already telling the truth about the task being too big for one turn.
 */
export function renderCompiledTask(task: CompiledTask, slice: ContractSlice = "full"): string {
  const budget = task.contextPolicy.maxContractTokens;
  const wants = (part: ContractSlice[]): boolean => slice === "full" || part.includes(slice);

  // Prompt-minimality rule: never state the goal twice. When the only `must` IS the goal (the common
  // shape for a short request), the `task:` line already carries it and the section is pure noise.
  const goalKey = line(task.goal).toLowerCase().replace(/[.\s]+$/, "");
  const musts = requirementLines(task.requirements, "must")
    .filter((text) => text.toLowerCase().replace(/[.\s]+$/, "") !== goalKey);
  const mustNots = requirementLines(task.requirements, "must_not");
  let shoulds = wants(["patch"]) ? requirementLines(task.requirements, "should") : [];
  let mays = wants(["patch"]) ? requirementLines(task.requirements, "may") : [];

  const renderedEvidence = wants(["localize", "patch", "integrate"])
    ? task.repositoryEvidence
        // An absence is only worth a line when it changes what the model does next; a bare "x does not
        // exist" for a file nobody asked about is noise.
        .filter((ref) => ref.kind !== "index" || task.affectedSurfaces.length <= 3)
        .slice(0, task.contextPolicy.maxEvidenceLines)
    : [];
  let repository = uniqueLines(renderedEvidence.map((ref) => ref.detail));

  // Assumptions are rendered only when they affect visible behavior or architecture — AND only when
  // the evidence they rest on is not already stated above. An assumption that merely repeats a
  // rendered repository fact ("use the node stack" under "Project stack is node") is the same
  // sentence twice, which is precisely the inflation this layer exists to prevent.
  const renderedEvidenceIds = new Set(renderedEvidence.map((ref) => ref.id));
  let assumptions = wants(["patch", "integrate"])
    ? uniqueLines(task.assumptions
        .filter((a) => a.basis !== "main_model_decision")
        .filter((a) => {
          const refs = a.evidenceRefs ?? [];
          return refs.length === 0 || !refs.every((ref) => renderedEvidenceIds.has(ref));
        })
        .map((a) => a.text))
    : [];

  // Non-goals earn their place only when they prevent a LIKELY scope expansion — which is exactly
  // when the user stated a prohibition or the scope was unbounded.
  let nonGoals = wants(["patch", "verify"]) ? uniqueLines(task.nonGoals.map((n) => n.text)) : [];

  const invariants = wants(["patch", "verify", "integrate"]) ? uniqueLines(task.invariants.map((i) => i.text)) : [];
  const constraints = wants(["patch", "integrate"]) ? uniqueLines(task.constraints.map((c) => c.text)) : [];

  const verifyRequired = wants(["patch", "verify"]) ? uniqueLines(task.verification.requiredChecks.map(checkLine)) : [];
  const verifyRegression = wants(["patch", "verify"]) ? uniqueLines(task.verification.regressionChecks.map(checkLine)) : [];
  // Adversarial probes go to the VERIFIER ONLY — never to the implementer, and not in the `full`
  // slice either. They are falsification attempts, and a model reads every rendered line as an
  // instruction: shown "the new behavior fails cleanly on invalid input", ornith-1.0-35b imported a
  // schema library and wrapped a one-line string transform in validation nobody asked for. Removing
  // the dependency roster did NOT stop it; removing this line is what stops it. A probe describes how
  // the work will be CHECKED, which is the verifier's business, not a requirement to build defenses.
  let verifyAdversarial = slice === "verify" ? uniqueLines(task.verification.adversarialChecks.map(checkLine)) : [];

  const surfaces = wants(["localize", "patch"])
    ? uniqueLines(task.affectedSurfaces.map((s) => `${normalizePathForPrompt(s.path)} — ${s.reason}`)).slice(0, 8)
    : [];

  const assemble = (): string => {
    const parts = [
      `task: ${line(task.goal)}\n`,
      section("must", musts),
      section("must not", mustNots),
      section("invariants", invariants),
      section("constraints", constraints),
      section("should", shoulds),
      section("may", mays),
      section("files", surfaces),
      section("repository", repository),
      section("assumptions", assumptions),
      section("non-goals", nonGoals),
      section("verify", verifyRequired),
      section("regression", verifyRegression),
      section("adversarial", verifyAdversarial),
    ];
    return parts.filter(Boolean).join("\n");
  };

  // Trim lowest-value material first until the soft budget is met. Each step is a whole category, so
  // the result stays a coherent contract rather than a truncated one.
  const trims: Array<() => void> = [
    () => { mays = []; },
    () => { shoulds = []; },
    () => { verifyAdversarial = []; },
    () => { assumptions = assumptions.slice(0, 2); },
    () => { nonGoals = nonGoals.slice(0, 2); },
    () => { repository = repository.slice(0, Math.max(2, Math.floor(repository.length / 2))); },
    () => { assumptions = []; },
    () => { repository = repository.slice(0, 2); },
  ];
  let rendered = assemble();
  for (const trim of trims) {
    if (approxTokens(rendered) <= budget) break;
    trim();
    rendered = assemble();
  }
  return normalizeText(rendered);
}

/**
 * Wrap the contract for injection into the conversation context. The header names what the block is
 * so the model does not mistake a contract for the user's literal words, and the block is placed
 * AFTER stable material by the caller (volatile-last, so the warm prefix survives).
 */
export function renderContractBlock(task: CompiledTask, slice: ContractSlice = "full"): string {
  const body = renderCompiledTask(task, slice);
  if (!body.trim()) return "";
  return normalizeText(
    `## Compiled task contract\nThis contract was derived from the user's request and this repository. ` +
    `Treat "must"/"must not" as binding, and satisfy every "verify" item before claiming completion.\n\n${body}`,
  );
}

/** Render the clarifying question. Exactly one question, no preamble, no apology. */
export function renderClarification(task: CompiledTask): string {
  const blocking = task.ambiguities.find((a) => a.kind === "blocking" && a.resolution.type === "ask_user");
  if (blocking && blocking.resolution.type === "ask_user") return blocking.resolution.question;
  return "I need one detail before starting: what should change, and what should be true when it works?";
}
