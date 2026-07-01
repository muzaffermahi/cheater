import { blueprintConfig } from "../blueprint/config.js";
import type { CheaterConfig } from "../types.js";
import { LoopGovernor } from "./loopGovernor.js";
import { modelProfile } from "./modelProfile.js";
import { reliabilityStatus } from "./status.js";

type ExtensionAPI = any;
type CommandContext = any;

function notifyBlock(ctx: CommandContext, text: string): void {
  ctx.ui.notify(text.split("\n")[0], "info");
  ctx.ui.setWidget?.("cheater-reliability", text.split("\n").slice(0, 80), { placement: "aboveEditor" });
}

export function registerReliabilityCommands(pi: ExtensionAPI, deps: { config: CheaterConfig }): void {
  pi.registerCommand("reliability-status", {
    description: "Show Cheater Reliability Mode status",
    handler: async (_args: string, ctx: CommandContext) => {
      notifyBlock(ctx, reliabilityStatus(deps.config, ctx.model?.id));
    }
  });

  pi.registerCommand("model-profile", {
    description: "Show Reliability Mode model profile settings",
    handler: async (_args: string, ctx: CommandContext) => {
      notifyBlock(ctx, JSON.stringify(modelProfile(ctx.model?.id, blueprintConfig(deps.config)), null, 2));
    }
  });

  pi.registerCommand("loop-report", {
    description: "Show a mock Loop Governor report for debugging",
    handler: async (_args: string, ctx: CommandContext) => {
      const governor = new LoopGovernor(blueprintConfig(deps.config), "debug");
      const event = governor.observeTools([
        { kind: "read_file", value: "src/example.ts" },
        { kind: "read_file", value: "src/example.ts" },
        { kind: "read_file", value: "src/example.ts" }
      ]);
      notifyBlock(ctx, event ? JSON.stringify(event, null, 2) : "No loop event detected.");
    }
  });
}
