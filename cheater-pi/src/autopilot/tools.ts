import { Type } from "typebox";
import { routeAutopilot, buildAutopilotInstruction } from "./router.js";
import { defaultAutopilotState } from "./status.js";
import { formatAutopilotDecision } from "./ui.js";

type ExtensionAPI = any;
type ExtensionContext = any;

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text", text }], details };
}

export function registerAutopilotTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "cheater_autopilot_route",
    label: "Cheater Autopilot Route",
    description: "Route a normal user request to answer_only, cheater_reliability_start for code-changing work, or Mission Control for repro/evidence.",
    promptSnippet: "cheater_autopilot_route - call before code-changing tasks, then call cheater_reliability_start; use Mission Control only for repro/evidence.",
    promptGuidelines: [
      "Call this before normal code-changing work.",
      "For code-changing tasks, call cheater_reliability_start after routing.",
      "Use Mission Control only when the task needs repro/evidence gathering.",
      "Never ask the user to type /blueprint or manually chain blueprint/commitlet tools."
    ],
    parameters: Type.Object({
      message: Type.String({ description: "The user's normal request" }),
      recentErrors: Type.Optional(Type.String({ description: "Recent error output or failing test text" })),
      previousFastPathFailed: Type.Optional(Type.Boolean()),
      repeatedFailure: Type.Optional(Type.Boolean())
    }),
    async execute(_id: string, params: { message: string; recentErrors?: string; previousFastPathFailed?: boolean; repeatedFailure?: boolean }, _sig: unknown, _upd: unknown, ctx: ExtensionContext) {
      const decision = routeAutopilot({
        cwd: ctx.cwd,
        message: params.message,
        recentErrors: params.recentErrors,
        repoHints: {
          previousFastPathFailed: params.previousFastPathFailed,
          repeatedFailure: params.repeatedFailure
        }
      });
      defaultAutopilotState.setDecision(params.message, decision);
      return textResult(
        `${formatAutopilotDecision(decision)}\n\n${buildAutopilotInstruction(decision, params.message)}`,
        decision
      );
    }
  });
}
