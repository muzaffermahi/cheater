// Typed context fragments: context is state with a type, a cap, and a freshness - never
// transcript soup.
//
// Every piece of text that enters a capsule or brief passes through makeFragment, which
// clamps to the kind's cap, refuses poisoned content (think blocks, raw logs, stack dumps),
// and stamps freshness. Capsules record the fragment ids that entered them, so what a worker
// saw is auditable from the run directory. There is deliberately no fragment kind for a
// transcript, a system prompt, or raw logs - the type system is the exclusion mechanism.

import type { TaskRunState } from "./runState.js";
import { FRAGMENT_HARD_CAP, looksPoisoned } from "./sanitize.js";

export type ContextFragmentKind =
  | "acceptance_contract"
  | "workspace_digest"
  | "mutation_ledger"
  | "validation_ledger"
  | "phase"
  | "worker_plan"
  | "worker_report"
  | "risk_warning"
  | "protected_artifact"
  | "rule_pack"
  | "environment"
  | "reincarnation"
  | "world_state_diff";

export type FragmentFreshness = "fresh" | "stale" | "unknown";

export interface ContextFragment {
  id: string;
  kind: ContextFragmentKind;
  sourcePath?: string;
  priority: number;
  maxChars: number;
  freshness: FragmentFreshness;
  text: string;
  /** Deterministic: same fragment, same render. */
  render(): string;
}

export interface FragmentMeta {
  id: string;
  kind: ContextFragmentKind;
  chars: number;
  freshness: FragmentFreshness;
}

/** Per-kind caps. Workers prefer <500-char fragments; anything above 1000 must be justified. */
const KIND_CAPS: Record<ContextFragmentKind, number> = {
  acceptance_contract: 800,
  workspace_digest: 1500,
  mutation_ledger: 500,
  validation_ledger: 500,
  phase: 300,
  worker_plan: 900,
  worker_report: 500,
  risk_warning: 500,
  protected_artifact: 400,
  rule_pack: 900,
  environment: 400,
  reincarnation: 2000,
  world_state_diff: 600,
};

/** Over-1000-chars kinds that carry a standing justification for the size report. */
const LARGE_KIND_JUSTIFICATION: Partial<Record<ContextFragmentKind, string>> = {
  workspace_digest: "the digest is the worker's only state truth; it replaces all logs",
  reincarnation: "one-time controller rebirth brief; replaces an entire dead session"
};

export interface MakeFragmentInput {
  id?: string;
  kind: ContextFragmentKind;
  text: string;
  sourcePath?: string;
  priority?: number;
  maxChars?: number;
  freshness?: FragmentFreshness;
}

let fragmentSeq = 0;

/**
 * The only fragment constructor. Returns null (refuses) for poisoned or empty content -
 * callers must treat null as "this may not enter context", not as an error to route around.
 */
export function makeFragment(input: MakeFragmentInput): ContextFragment | null {
  const raw = (input.text ?? "").trim();
  if (!raw) return null;
  const poison = looksPoisoned(raw);
  if (poison) return null;
  const cap = Math.min(input.maxChars ?? KIND_CAPS[input.kind], FRAGMENT_HARD_CAP);
  const text = raw.length <= cap ? raw : raw.slice(0, cap - 12) + "\n[clipped]";
  const id = input.id ?? `${input.kind}-${(++fragmentSeq).toString(36)}`;
  return {
    id,
    kind: input.kind,
    sourcePath: input.sourcePath,
    priority: input.priority ?? 5,
    maxChars: cap,
    freshness: input.freshness ?? "unknown",
    text,
    render: () => text
  };
}

export function fragmentMeta(fragments: ContextFragment[]): FragmentMeta[] {
  return fragments.map((fragment) => ({
    id: fragment.id,
    kind: fragment.kind,
    chars: fragment.text.length,
    freshness: fragment.freshness
  }));
}

export interface FragmentBundleSizeReport {
  count: number;
  totalChars: number;
  estimatedTokens: number;
  overTargetIds: string[];
  /** Fragments over 1000 chars, each with its standing justification (or a flag). */
  largeFragments: Array<{ id: string; chars: number; justification: string }>;
}

export function fragmentBundleSizeReport(fragments: ContextFragment[]): FragmentBundleSizeReport {
  const totalChars = fragments.reduce((sum, fragment) => sum + fragment.text.length, 0);
  return {
    count: fragments.length,
    totalChars,
    estimatedTokens: Math.ceil(totalChars / 4),
    overTargetIds: fragments.filter((fragment) => fragment.text.length > 500).map((fragment) => fragment.id),
    largeFragments: fragments
      .filter((fragment) => fragment.text.length > 1000)
      .map((fragment) => ({
        id: fragment.id,
        chars: fragment.text.length,
        justification: LARGE_KIND_JUSTIFICATION[fragment.kind] ?? "UNJUSTIFIED - shrink this fragment"
      }))
  };
}

/** Render a bundle deterministically, highest priority first, stable within priority. */
export function renderFragmentBundle(fragments: ContextFragment[], header = ""): string {
  const ordered = [...fragments].sort((a, b) => b.priority - a.priority);
  const parts = ordered.map((fragment) => fragment.render());
  return [header, ...parts].filter(Boolean).join("\n");
}

export interface WorkerFragmentInput {
  goalSeed: string;
  ruleLines: string[];
  priorReports: string[];
}

/**
 * The fragment set a WORKER capsule is built from. Only run-state truth: phase, contract,
 * digest, ledger summaries, protections, risks, rules, prior report one-liners, and the
 * world-state diff since the last capsule. No other kind may enter a worker capsule.
 */
export function collectFragmentsForWorker(run: TaskRunState, input: WorkerFragmentInput): ContextFragment[] {
  const staleCount = run.validations.summary().stalePasses;
  const candidates: Array<ContextFragment | null> = [
    makeFragment({ kind: "phase", text: run.phase.capsuleLines().join("\n"), priority: 10, freshness: "fresh" }),
    makeFragment({
      kind: "acceptance_contract",
      text: `contract (literal - keep exact names/paths):\n${run.contractSummaryText()}`,
      sourcePath: "contract.json",
      priority: 9,
      freshness: "fresh"
    }),
    makeFragment({
      kind: "mutation_ledger",
      text: `changes so far: ${run.mutations.renderSummaryLines().join(" | ")}`,
      sourcePath: "mutation-ledger.json",
      priority: 7,
      freshness: "fresh"
    }),
    makeFragment({
      kind: "validation_ledger",
      text: `validation: ${run.validations.renderSummaryLines().join(" | ")}`,
      sourcePath: "validation-ledger.json",
      priority: 7,
      freshness: staleCount > 0 ? "stale" : "fresh"
    }),
    ...(run.guard.hasProtections()
      ? [makeFragment({ kind: "protected_artifact", text: run.guard.warningLine() ?? "", sourcePath: "guards/protected-artifacts.json", priority: 8, freshness: "fresh" })]
      : []),
    ...(input.priorReports.length
      ? [makeFragment({ kind: "worker_report", text: `prior workers: ${input.priorReports.join(" | ")}`, priority: 5, freshness: "fresh" })]
      : []),
    ...(input.ruleLines.length
      ? [makeFragment({ kind: "rule_pack", text: `rules:\n${input.ruleLines.map((rule) => `- ${rule}`).join("\n")}`, priority: 4, freshness: "unknown" })]
      : [])
  ];
  const worldDiff = run.consumeWorldStateDiffLines();
  if (worldDiff.length) {
    candidates.push(makeFragment({ kind: "world_state_diff", text: `since last worker:\n${worldDiff.join("\n")}`, sourcePath: "world-state.json", priority: 6, freshness: "fresh" }));
  }
  return candidates.filter((fragment): fragment is ContextFragment => Boolean(fragment));
}
