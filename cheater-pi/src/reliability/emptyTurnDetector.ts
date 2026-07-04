// Empty-turn detector: catch the "runs for minutes, produces nothing, retries forever" failure.
//
// When a model never responds - most often because a large prompt cannot finish PREFILL before
// the request times out (a big model on limited VRAM), or the backend is wedged - the agent loop
// ends turn after turn with no assistant text and no tool calls, and Pi auto-retries. To the user
// it looks frozen. This detector notices consecutive empty turns and surfaces ONE clear, actionable
// diagnostic instead of silence. It is advisory (a notification); it never blocks or aborts.

import { messageText } from "../dev/devLog.js";

class EmptyTurnDetector {
  private consecutive = 0;
  private notified = false;

  /** Reset on a fresh user turn so the counter measures one continuous model loop. */
  reset(): void {
    this.consecutive = 0;
    this.notified = false;
  }

  /**
   * Observe a finished turn. Returns a one-time diagnostic string once the model has produced
   * nothing (no text AND no tool calls) for two turns in a row, else null.
   */
  observeTurn(hadText: boolean, hadTools: boolean): string | null {
    if (hadText || hadTools) {
      this.consecutive = 0;
      this.notified = false;
      return null;
    }
    this.consecutive += 1;
    if (this.consecutive >= 2 && !this.notified) {
      this.notified = true;
      return [
        `Cheater: the model produced no output for ${this.consecutive} turns in a row - it appears stuck, not working.`,
        "Most common cause: the prompt is too large for the model to finish processing (prefill) before the request times out - typical for a big model (e.g. a 35B) on limited VRAM, where most layers run on CPU.",
        "Try one of:",
        "  - a smaller / faster local model, or a shorter request",
        "  - raise the HTTP idle timeout (Cheater already defaults it to 30 min in ~/.pi/agent/settings.json - set \"httpIdleTimeoutMs\" higher, or 0 for no limit)",
        "  - check your local server (LM Studio / Ollama) logs for \"Prompt processing\" - if it sits at 0% for minutes, prefill is the bottleneck"
      ].join("\n");
    }
    return null;
  }
}

export const emptyTurnDetector = new EmptyTurnDetector();

type ExtensionAPI = { on: (event: string, handler: (...args: unknown[]) => unknown) => void };

/** Register the detector: reset on a user message, evaluate each finished turn, notify once. */
export function registerEmptyTurnDetector(pi: ExtensionAPI): void {
  pi.on("message_start", async (event: any) => {
    try { if (String(event?.message?.role ?? "") === "user") emptyTurnDetector.reset(); } catch { /* ignore */ }
  });
  pi.on("turn_end", async (event: any, ctx: any) => {
    try {
      const hadText = (messageText(event?.message) ?? "").trim().length > 0;
      const hadTools = Array.isArray(event?.toolResults) && event.toolResults.length > 0;
      const diagnostic = emptyTurnDetector.observeTurn(hadText, hadTools);
      if (diagnostic) ctx?.ui?.notify?.(diagnostic, "error");
    } catch {
      // detection must never break a turn
    }
  });
}
