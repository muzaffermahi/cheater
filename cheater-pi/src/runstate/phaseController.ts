// Time-aware phase control: EXPLORE -> IMPLEMENT -> VALIDATE -> RESERVE, monotonic.
//
// Small local models loop: they explore forever, or refactor at minute 58 of 60. The phase
// controller gives every run a budget model (wall clock when known, otherwise a tool-action
// budget) and derives a phase from the fraction used. Transitions are monotonic - once in
// VALIDATE the run never drifts back to broad EXPLORE without an explicit, recorded override,
// and RESERVE means "preserve the acceptable result": new state-changing actions get warned
// or blocked, never silently allowed. Phase facts ride in every capsule so a 4K-context
// worker knows what the run can currently afford.

export type RunPhase = "explore" | "implement" | "validate" | "reserve";

const PHASE_ORDER: RunPhase[] = ["explore", "implement", "validate", "reserve"];

const PHASE_BOUNDS: Array<{ phase: RunPhase; upTo: number }> = [
  { phase: "explore", upTo: 0.3 },
  { phase: "implement", upTo: 0.6 },
  { phase: "validate", upTo: 0.9 },
  { phase: "reserve", upTo: 1.0 }
];

export type PhaseActionKind = "read" | "state_changing" | "validation";

export interface PhaseAssessment {
  verdict: "ok" | "warn" | "block";
  message?: string;
}

export interface PhaseSnapshot {
  phase: RunPhase;
  fractionUsed: number;
  actionsUsed: number;
  actionBudget: number;
  overrides: Array<{ at: string; from: RunPhase; to: RunPhase; reason: string }>;
}

export const DEFAULT_ACTION_BUDGET = 60;

function phaseIndex(phase: RunPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

export class PhaseController {
  private actionsUsed = 0;
  private readonly actionBudget: number;
  private readonly wallClockMs?: number;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  /** Monotonic floor: the run never reports a phase earlier than this. */
  private latched: RunPhase = "explore";
  private overrides: Array<{ at: string; from: RunPhase; to: RunPhase; reason: string }> = [];

  constructor(opts: { actionBudget?: number; wallClockMs?: number; now?: () => number } = {}) {
    this.actionBudget = Math.max(8, opts.actionBudget ?? DEFAULT_ACTION_BUDGET);
    this.wallClockMs = opts.wallClockMs && opts.wallClockMs > 0 ? opts.wallClockMs : undefined;
    this.now = opts.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  /** Record budget-consuming action(s). A READ is how the model earns the right to act (exploring the
   *  repo), so it costs only a fraction of a state-changing action toward phase progress - otherwise a
   *  long, legitimate read-heavy exploration drains the budget into RESERVE before the first edit and
   *  then can't install or do a large edit. Edits/validations cost full. A numeric arg charges that
   *  many full actions at once (used to fast-forward the phase). */
  noteAction(kind: PhaseActionKind | number = "state_changing"): void {
    if (typeof kind === "number") {
      this.actionsUsed += Math.max(0, kind);
      return;
    }
    this.actionsUsed += kind === "read" ? 0.25 : 1;
  }

  fractionUsed(): number {
    const actionFraction = this.actionsUsed / this.actionBudget;
    const wallFraction = this.wallClockMs ? (this.now() - this.startedAtMs) / this.wallClockMs : 0;
    return Math.min(1, Math.max(actionFraction, wallFraction));
  }

  currentPhase(): RunPhase {
    const fraction = this.fractionUsed();
    let derived: RunPhase = "reserve";
    for (const bound of PHASE_BOUNDS) {
      if (fraction < bound.upTo) { derived = bound.phase; break; }
    }
    // Monotonic: whichever is later wins; budget progress can only move forward.
    const winner = phaseIndex(derived) >= phaseIndex(this.latched) ? derived : this.latched;
    if (phaseIndex(winner) > phaseIndex(this.latched)) this.latched = winner;
    return winner;
  }

  /**
   * Explicit transition. Forward moves need no reason; a BACKWARD move requires one and is
   * recorded as an override (the only sanctioned way to return to broad exploration).
   */
  advanceTo(phase: RunPhase, reason?: string): { ok: boolean; message?: string } {
    const current = this.currentPhase();
    if (phaseIndex(phase) >= phaseIndex(current)) {
      this.latched = phase;
      return { ok: true };
    }
    if (!reason || !reason.trim()) {
      return { ok: false, message: `Phase is monotonic: cannot move ${current} -> ${phase} without an explicit override reason.` };
    }
    this.overrides.push({ at: new Date().toISOString(), from: current, to: phase, reason: reason.trim().slice(0, 200) });
    this.latched = phase;
    return { ok: true, message: `Phase override recorded: ${current} -> ${phase} (${reason.trim().slice(0, 80)})` };
  }

  /** Can the run afford this action right now? */
  assessAction(kind: PhaseActionKind, detail?: string): PhaseAssessment {
    const phase = this.currentPhase();
    const remaining = Math.max(0, 1 - this.fractionUsed());
    if (phase === "reserve" && kind === "state_changing") {
      // Only truly DESTRUCTIVE commands (that could wipe the working result) are blocked in RESERVE.
      // Installs/refactors/migrations are often a legitimate LATE need of a real build (add a dep,
      // finish a file); blocking them was a top "never finishes" cause, and the command-classifier
      // path (controlledExec) already only WARNS on install - this twin must match. Matching on a
      // whitespace-anchored command shape also stops a filename that merely contains "install" or
      // "migrate" from false-blocking an ordinary edit.
      const destructive = detail ? /\b(rm\s+-rf|reset\s+--hard|clean\s+-f|drop\s+table|checkout\s+--)\b/i.test(detail) : false;
      if (destructive) {
        return { verdict: "block", message: `RESERVE phase (${Math.round(remaining * 100)}% budget left): destructive commands are blocked - preserve the current result and run final cheap checks only.` };
      }
      return { verdict: "warn", message: `RESERVE phase: prefer preserving the current acceptable result over new state-changing work.` };
    }
    if (phase === "validate" && kind === "state_changing" && detail && /\b(refactor|rewrite|restructure)\b/i.test(detail)) {
      return { verdict: "warn", message: "VALIDATE phase: fix only validation blockers; broad refactors belong to a fresh run." };
    }
    return { verdict: "ok" };
  }

  /** Compact phase facts for capsules and controller.md. */
  capsuleLines(): string[] {
    const phase = this.currentPhase();
    const remaining = Math.max(0, Math.round((1 - this.fractionUsed()) * 100));
    const allowed: Record<RunPhase, string> = {
      explore: "inspect contract, locate relevant files, plan; avoid broad implementation",
      implement: "make the primary changes; keep file scope tight",
      validate: "targeted verification against the exact contract; fix only validation blockers",
      reserve: "final cheap checks only; preserve the acceptable result"
    };
    const forbidden: Record<RunPhase, string> = {
      explore: "large speculative edits",
      implement: "scope creep outside allowed files",
      validate: "broad refactors, new features",
      reserve: "refactors, new dependencies, risky cleanup, long commands"
    };
    return [
      `phase: ${phase.toUpperCase()} (${remaining}% budget remaining)`,
      `allowed now: ${allowed[phase]}`,
      `forbidden now: ${forbidden[phase]}`
    ];
  }

  snapshot(): PhaseSnapshot {
    return {
      phase: this.currentPhase(),
      fractionUsed: this.fractionUsed(),
      actionsUsed: this.actionsUsed,
      actionBudget: this.actionBudget,
      overrides: [...this.overrides]
    };
  }

  /** Rebuild from a persisted snapshot (controller reincarnation). */
  static fromSnapshot(snapshot: Partial<PhaseSnapshot>, opts: { actionBudget?: number; wallClockMs?: number; now?: () => number } = {}): PhaseController {
    const controller = new PhaseController({ ...opts, actionBudget: opts.actionBudget ?? snapshot.actionBudget });
    controller.actionsUsed = snapshot.actionsUsed ?? 0;
    if (snapshot.phase && PHASE_ORDER.includes(snapshot.phase)) controller.latched = snapshot.phase;
    controller.overrides = Array.isArray(snapshot.overrides) ? [...snapshot.overrides] : [];
    return controller;
  }
}
