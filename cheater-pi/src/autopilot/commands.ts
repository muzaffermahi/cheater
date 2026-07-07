import { routeAutopilot, buildAutopilotInstruction } from "./router.js";
import { defaultAutopilotState } from "./status.js";
import { formatAutopilotDecision, formatAutopilotStatus } from "./ui.js";

type ExtensionAPI = any;
type CommandContext = any;

function widget(ctx: CommandContext, key: string, text: string): void {
  ctx.ui.notify(text.split("\n")[0], "info");
  ctx.ui.setWidget?.(key, text.split("\n").slice(0, 80), { placement: "aboveEditor" });
}

export function registerAutopilotCommands(pi: ExtensionAPI): void {
  pi.registerCommand("autopilot-status", {
    description: "Show the latest Cheater Autopilot routing decision",
    handler: async (_args: string, ctx: CommandContext) => {
      widget(ctx, "cheater-autopilot", formatAutopilotStatus(defaultAutopilotState.get()));
    }
  });

  pi.registerCommand("autopilot-route", {
    description: "Debug: route a request without executing it",
    handler: async (args: string, ctx: CommandContext) => {
      const message = args.trim();
      if (!message) {
        widget(ctx, "cheater-autopilot", "Usage: /autopilot-route <request>");
        return;
      }
      const decision = routeAutopilot({ cwd: ctx.cwd, message });
      defaultAutopilotState.setDecision(message, decision);
      widget(ctx, "cheater-autopilot", formatAutopilotDecision(decision));
    }
  });

  pi.registerCommand("autopilot-run", {
    description: "Debug: route a request and send the routed instruction",
    handler: async (args: string, ctx: CommandContext) => {
      const message = args.trim();
      if (!message) {
        widget(ctx, "cheater-autopilot", "Usage: /autopilot-run <request>");
        return;
      }
      const decision = routeAutopilot({ cwd: ctx.cwd, message });
      defaultAutopilotState.setDecision(message, decision);
      widget(ctx, "cheater-autopilot", formatAutopilotDecision(decision));
      pi.sendUserMessage(buildAutopilotInstruction(decision, message));
    }
  });
}
