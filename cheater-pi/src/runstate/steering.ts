// Mid-run steering: let the user correct or halt a running task WITHOUT killing it.
//
// The closed loop runs a whole commitlet chain in one tool call, but Pi handles extension commands
// (/steer) immediately - even while that call is streaming. So /steer pushes into this singleton,
// and the closed loop drains it at every commitlet boundary: corrections become global constraints
// the upcoming workers must honor, and a stop request halts gracefully with all state preserved
// (rollbacks, ledger, plan) so the very next message resumes. This is the "steering wheel" a
// minutes-long local run needs when it starts down the wrong path.

class SteeringControl {
  private corrections: string[] = [];
  private applied: string[] = [];
  private stop = false;

  /** Queue a user correction to apply at the next commitlet boundary. */
  pushCorrection(text: string): void {
    const trimmed = (text ?? "").trim().slice(0, 500);
    if (trimmed) this.corrections.push(trimmed);
  }

  /** Ask the run to stop gracefully at the next boundary (state is preserved / resumable). */
  requestStop(): void {
    this.stop = true;
  }

  stopRequested(): boolean {
    return this.stop;
  }

  /** Return and clear the pending corrections (called by the loop at a boundary). */
  drainCorrections(): string[] {
    const out = this.corrections;
    this.corrections = [];
    this.applied.push(...out);
    return out;
  }

  pendingCount(): number {
    return this.corrections.length;
  }

  appliedCount(): number {
    return this.applied.length;
  }

  /** Clear per-task steering state. Call when a new goal starts. */
  reset(): void {
    this.corrections = [];
    this.applied = [];
    this.stop = false;
  }

  statusLine(): string {
    if (this.stop) return "steering: STOP requested (halts at the next commitlet boundary)";
    const parts: string[] = [];
    if (this.corrections.length) parts.push(`${this.corrections.length} correction(s) pending`);
    if (this.applied.length) parts.push(`${this.applied.length} applied`);
    return `steering: ${parts.length ? parts.join(", ") : "no corrections queued"}`;
  }
}

/** Process-level singleton: one steering channel per Cheater session. */
export const steeringControl = new SteeringControl();

type ExtensionAPI = { registerCommand: (name: string, opts: unknown) => void };

/** Register /steer: mid-run guidance and graceful stop. */
export function registerSteeringCommands(pi: ExtensionAPI): void {
  pi.registerCommand("steer", {
    description: "Steer a running task: /steer <correction> adds guidance the upcoming commitlets must honor; /steer stop halts gracefully (state preserved, resumable); /steer status shows the queue.",
    handler: async (args: string, ctx: any) => {
      const notify = (text: string) => { try { ctx?.ui?.notify?.(text, "info"); } catch { /* ignore */ } };
      const text = (args ?? "").trim();
      const lower = text.toLowerCase();
      if (!text || lower === "status") return notify(steeringControl.statusLine());
      if (lower === "stop" || lower === "halt" || lower === "abort") {
        steeringControl.requestStop();
        return notify("Cheater: stop requested. It will halt at the next commitlet boundary; plan, rollbacks, and ledger are preserved, so your next message resumes.");
      }
      steeringControl.pushCorrection(text);
      return notify(`Cheater: steering queued - "${text.slice(0, 120)}". It applies to the next commitlet as a constraint the workers must honor.`);
    }
  });
}
