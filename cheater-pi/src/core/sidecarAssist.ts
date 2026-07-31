// Kitten Core — the sidecar assist layer. NO Pi.
//
// THE PROBLEM THIS SOLVES: the sidecar did nothing during a run. Every `runCatalogJob` call site
// lived in `desktopEngine.ts`, so postflight review and failure triage existed only for the native
// desktop app. The CLI, the TUI, the web client and every subagent run got nothing — and even in the
// desktop app, nothing ran while the main model was working. A control plane that only runs in one
// client is not a control plane.
//
// SCHEDULING, HONESTLY. On this workstation llama-server holds ONE model: a request naming
// `qwen3.5-2b` is silently answered by the 35B (llama.cpp ignores an unknown model field rather than
// rejecting it). So "sidecar" work is a real forward pass through the same weights, competing for the
// same KV and the same memory bandwidth. Running it CONCURRENTLY with main-model decode would slow
// both — the hosted-agent assumption that background work is free does not hold here.
//
// Therefore assist work is scheduled where the main model is genuinely IDLE: after the run reaches a
// terminal state. That is a real window (the user is reading the result), it costs no main-model
// latency, and it is honest about the hardware. When a SEPARATE sidecar endpoint is configured
// (`sidecarBaseUrl`), the contention argument disappears and the deadlines can be looser.
//
// Everything here is bounded, deadline-capped, falls back to a deterministic floor, and can never
// change a run's grade or fail a run. Advisory means advisory.

import type { KittenLLM } from "./llm.js";
import type { WorkspaceIndex } from "./workspaceIndex.js";
import { SidecarControlPlane } from "./sidecarControlPlane.js";
import { runCatalogJob } from "./sidecarJobs.js";
import { inspectWorkspaceChanges } from "./workspaceChanges.js";

/** What the assist layer produced for one finished run. Advisory only — never a grade. */
export interface PostflightAssessment {
  source: "sidecar" | "deterministic";
  secrets: string[];
  warnings: string[];
  evidenceWarnings: string[];
  recommendedTests: string[];
  suggestedCommands: string[];
  risk: "low" | "medium" | "high";
  riskReasons: string[];
  generatedTestCases: string[];
}

/** Per-step labels over one run's trajectory, plus how much of it was productive. */
export interface StepCritique {
  source: "sidecar" | "deterministic";
  steps: Array<{ step: number; label: string; why: string }>;
  /**
   * Share of labelled steps that were NOT mistakes. SRFT's central observation is that this stays
   * high (~0.76) even in failed runs — which is why discarding a failed trajectory wholesale throws
   * away mostly-good data.
   */
  productiveRatio: number;
}

export interface FailureAssessment {
  source: "sidecar" | "deterministic";
  severity: "error" | "warning" | "info";
  signature: string;
  likelyCause: string;
  salientLines: string[];
}

/** Whether the configured "sidecar" is a genuinely separate model, or the main model in disguise. */
export interface SidecarIdentity {
  /** The model name Kitten asks for. */
  configured: string;
  /** What the endpoint actually reports serving. */
  served: string;
  /**
   * True when sidecar work runs on the SAME weights/process as the main model. This is not a
   * failure — it works, and with thinking disabled a short classification returns in about a second —
   * but it means sidecar work is not free and must not be scheduled against main-model decode.
   */
  sharedWithMain: boolean;
  /** A separate endpoint was configured, so the contention argument does not apply. */
  separateEndpoint: boolean;
  /** Human-readable explanation for `kitten doctor` and the desktop status line. */
  detail: string;
}

export interface SidecarAssistOptions {
  llm: KittenLLM | null;
  /** Shared scheduler; one is created if absent. */
  scheduler?: SidecarControlPlane;
  index?: (projectRoot: string) => WorkspaceIndex | undefined;
  /** Wall-clock budget for a single assist job. */
  deadlineMs?: number;
}

export interface RunFacts {
  runId: string;
  status: string;
  summary: string;
  verified: boolean;
  filesChanged: string[];
  projectRoot: string;
  /** Receipt lines + any captured failure text — the raw material for triage. */
  evidence: string[];
  error?: string;
}

const strings = (entry: unknown, max: number): string[] =>
  Array.isArray(entry) ? entry.map(String).filter(Boolean).slice(0, max) : [];

export class SidecarAssist {
  private readonly llm: KittenLLM | null;
  private readonly scheduler: SidecarControlPlane;
  private readonly index?: (projectRoot: string) => WorkspaceIndex | undefined;
  private readonly deadlineMs: number;
  private counter = 0;
  private identity: SidecarIdentity | null = null;

  constructor(opts: SidecarAssistOptions) {
    this.llm = opts.llm;
    this.scheduler = opts.scheduler ?? new SidecarControlPlane();
    this.index = opts.index;
    // MEASURED, not guessed. On this workstation (35B-A3B Q5, experts on CPU, ~20 tok/s) a
    // schema-constrained `postflight_review` over a small diff takes ~20s and `explain_error` ~7.6s.
    // The previous 8s budget expired on nearly every review, so the layer fell back to its
    // deterministic floor and looked like it was working while producing nothing a model had seen.
    // This work is fire-and-forget with the main model idle, so a longer budget costs no foreground
    // latency — and an assist that always times out is strictly worse than one that takes 30s.
    this.deadlineMs = opts.deadlineMs ?? 30_000;
  }

  /**
   * Ask the endpoint what it actually serves, so Kitten stops believing it has a cheap tier it does
   * not have. Cached: the answer cannot change without a runtime restart.
   *
   * This exists because the failure is SILENT. llama.cpp answers a request for `qwen3.5-2b` with
   * whatever is loaded instead of returning 404, so a misconfigured sidecar looks exactly like a
   * working one — right up until someone reasons about latency budgets on the assumption that a 2B
   * is answering.
   */
  async probeIdentity(): Promise<SidecarIdentity> {
    if (this.identity) return this.identity;
    const configured = this.llm?.models.sidecar ?? "";
    const separateEndpoint = Boolean(this.llm?.models.sidecarBaseUrl?.trim());
    if (!this.llm || !configured) {
      this.identity = { configured, served: "", sharedWithMain: true, separateEndpoint,
        detail: "no sidecar model configured — clerical work runs on the main model" };
      return this.identity;
    }
    let served = "";
    try {
      const base = (this.llm.models.sidecarBaseUrl?.trim() || this.llm.models.baseUrl).replace(/\/$/, "");
      const res = await fetch(`${base}/models`, { headers: { "Content-Type": "application/json" } });
      if (res.ok) {
        const json = await res.json() as { data?: Array<{ id?: string }> };
        served = String(json?.data?.[0]?.id ?? "");
      }
    } catch { /* an unreachable endpoint is reported as unknown, not as agreement */ }

    // Match on the tail of the served id: llama.cpp reports a full filesystem path, not a bare name.
    const normalize = (value: string): string => value.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
    const servedName = normalize(served);
    const wantedName = configured.toLowerCase();
    const main = (this.llm.models.main ?? "").toLowerCase();
    const servesWanted = Boolean(servedName) && servedName.includes(wantedName);
    const servesMain = Boolean(servedName) && Boolean(main) && servedName.includes(main);
    const sharedWithMain = separateEndpoint ? false : (!servesWanted || configured === this.llm.models.main);

    this.identity = {
      configured, served, sharedWithMain, separateEndpoint,
      detail: !served
        ? `could not read the model list — assuming sidecar work shares the main runtime`
        : servesWanted && !servesMain
          ? `sidecar "${configured}" is served independently`
          : `endpoint serves "${servedName}"; requests for "${configured}" are answered by the main model — sidecar work is a full main-model pass, so it is scheduled only while the main model is idle`,
    };
    return this.identity;
  }

  /**
   * Review a finished, file-changing run: secrets, risk, evidence gaps, tests worth running.
   * This is the "reporting" role — it tells the user what the change actually touched, which is
   * exactly the work a small model is good at and the main model should not spend a turn on.
   */
  async reviewRun(facts: RunFacts): Promise<PostflightAssessment> {
    if (!facts.filesChanged.length) {
      return { source: "deterministic", secrets: [], warnings: [], evidenceWarnings: ["no files changed"],
        recommendedTests: [], suggestedCommands: [], risk: "low", riskReasons: [], generatedTestCases: [] };
    }
    let diff = "";
    try { diff = inspectWorkspaceChanges(facts.projectRoot, { maxBytes: 40_000, maxFiles: 40 }).diff.slice(0, 36_000); }
    catch { /* a workspace we cannot diff still gets the deterministic floor */ }

    const index = this.index?.(facts.projectRoot);
    const tests = index ? index.list().filter((record) => record.isTest).map((record) => record.path).slice(0, 80) : [];
    const result = await runCatalogJob(this.scheduler, this.llm, index, {
      id: this.nextId("review"), type: "postflight_review", premise: facts.runId, diff,
      files: facts.filesChanged.slice(0, 40), tests,
      facts: [`status=${facts.status}`, `verified=${facts.verified}`, facts.summary.slice(0, 500)],
      text: `${facts.summary}\n${diff.slice(0, 12_000)}`,
      deadlineMs: this.deadlineMs,
    });
    const value = result.value.value && typeof result.value.value === "object" ? result.value.value as Record<string, unknown> : {};
    return {
      source: result.source,
      secrets: strings(value.secrets, 12),
      warnings: strings(value.warnings, 12),
      evidenceWarnings: strings(value.evidenceWarnings, 12),
      recommendedTests: strings(value.recommendedTests, 12),
      suggestedCommands: strings(value.suggestedCommands, 8),
      risk: value.risk === "high" || value.risk === "medium" ? value.risk : "low",
      riskReasons: strings(value.riskReasons, 12),
      generatedTestCases: strings(value.generatedTestCases, 12),
    };
  }

  /**
   * Triage a failed or unverified run into a compact signature and likely cause — the "assessing
   * bugs" role. A structured failure card is worth far more than the raw log to the NEXT turn, and
   * deriving it is exactly the bounded, externally-checkable work a small model does well.
   *
   * It is never verification evidence and never changes a grade: a plausible cause is a hypothesis.
   */
  async triageFailure(facts: RunFacts): Promise<FailureAssessment> {
    const text = [facts.error ?? "", ...facts.evidence].filter(Boolean).join("\n").slice(-12_000)
      || facts.summary.slice(0, 2000);
    const result = await runCatalogJob(this.scheduler, this.llm, undefined, {
      id: this.nextId("triage"), type: "triage_logs", premise: facts.runId, output: text, text,
      deadlineMs: this.deadlineMs,
    });
    const triage = result.value.value && typeof result.value.value === "object" ? result.value.value as Record<string, unknown> : {};
    const severity = triage.severity === "warning" || triage.severity === "info" ? triage.severity : "error";
    const signature = typeof triage.signature === "string" ? triage.signature : "";

    // A second bounded job supplies the likely cause. Kept separate so a malformed answer to one
    // does not discard the other — and so each keeps its own deterministic floor.
    const explained = await runCatalogJob(this.scheduler, this.llm, undefined, {
      id: this.nextId("explain"), type: "explain_error", premise: facts.runId, output: text, text,
      deadlineMs: this.deadlineMs,
    });
    const explain = explained.value.value && typeof explained.value.value === "object" ? explained.value.value as Record<string, unknown> : {};

    return {
      // "sidecar" only when a model actually answered; a deterministic floor must not be dressed up
      // as model analysis, because the next turn reads this as evidence of thought.
      source: result.source === "sidecar" && explained.source === "sidecar" ? "sidecar" : "deterministic",
      severity,
      signature: (signature || String(explain.signature ?? "unknown failure")).slice(0, 240),
      likelyCause: String(explain.likelyCause ?? "inspect the cited file and reproduce the failure").slice(0, 500),
      salientLines: strings(triage.lines, 12).map((line) => line.slice(0, 500)),
    };
  }

  /**
   * Label each step of a run's trajectory good / unnecessary / mistake / recover.
   *
   * Step Rejection Fine-Tuning (JetBrains, 2026, Qwen2.5-Coder-32B on SWE-bench Verified) found that
   * standard rejection-sampling discards ~61% of collected runs — every unsuccessful one — while only
   * about 24% of the steps in those runs are actually going the wrong way. The other ~76% is
   * productive exploration thrown away with the failure. Masking the loss on the harmful steps and
   * keeping the rest moved 30.9% → 32.2%; training on masked unresolved trajectories ALONE reached
   * 29.7%.
   *
   * Kitten already persists every run — including failures — as durable receipts with execution
   * evidence and terminal grades. That is exactly the corpus SRFT needs, and until now it was written
   * and never read. This produces the labels: immediately useful as a failure explanation, and later
   * the training signal, without committing to fine-tuning anything today.
   *
   * One cheap call per trajectory, as in the paper. Never a grade, never a gate.
   */
  async critiqueSteps(facts: RunFacts, steps: readonly string[]): Promise<StepCritique> {
    const bounded = steps.slice(0, 64).map((step) => step.slice(0, 400));
    if (!bounded.length) return { source: "deterministic", steps: [], productiveRatio: 1 };
    const result = await runCatalogJob(this.scheduler, this.llm, undefined, {
      id: this.nextId("critique"), type: "critique_steps", premise: facts.runId,
      facts: [...bounded],
      text: `Task outcome: ${facts.status}. ${facts.summary.slice(0, 400)}`,
      deadlineMs: this.deadlineMs,
    });
    const value = result.value.value && typeof result.value.value === "object" ? result.value.value as { steps?: Array<{ step: number; label: string; why: string }> } : {};
    const labelled = (value.steps ?? []).filter((step) => step.step >= 1 && step.step <= bounded.length);
    // The headline number from the paper, computed for THIS run: how much of a failed trajectory was
    // actually productive. A low ratio means the run went wrong early; a high one means it was close.
    const harmful = labelled.filter((step) => step.label === "mistake").length;
    return {
      source: result.source,
      steps: labelled,
      productiveRatio: labelled.length ? 1 - harmful / labelled.length : 1,
    };
  }

  /** Did this run leave a signal worth assessing? Keeps the layer silent on clean, trivial turns. */
  static needsTriage(facts: RunFacts): boolean {
    return facts.status === "failed" || (facts.status === "completed" && !facts.verified && facts.filesChanged.length > 0);
  }

  static needsReview(facts: RunFacts): boolean {
    return facts.filesChanged.length > 0;
  }

  private nextId(kind: string): string {
    return `assist-${kind}-${(this.counter++).toString(36)}`;
  }
}
