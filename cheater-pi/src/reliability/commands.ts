import { blueprintConfig } from "../blueprint/config.js";
import type { CheaterConfig } from "../types.js";
import { modelProfile } from "./modelProfile.js";
import { reliabilityStatus } from "./status.js";
import { activeTaskRun } from "../runstate/runState.js";

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
      const base = reliabilityStatus(deps.config, ctx.model?.id);
      // Local-only run telemetry: what the hidden harness machinery did this run.
      const run = activeTaskRun();
      const runLines = run
        ? [
          "",
          `active run: ${run.taskId} (phase ${run.currentPhase()}, ${run.budgetRemainingPercent()}% budget left)`,
          `capsules: ${run.capsuleMetrics().count} built, max ~${run.capsuleMetrics().maxTokens} tokens`,
          ...Object.entries(run.telemetrySnapshot())
            .filter(([, count]) => count > 0)
            .map(([key, count]) => `${key}: ${count}`)
        ]
        : [];
      notifyBlock(ctx, [base, ...runLines].join("\n"));
    }
  });

  pi.registerCommand("model-profile", {
    description: "Show Reliability Mode model profile settings",
    handler: async (_args: string, ctx: CommandContext) => {
      notifyBlock(ctx, JSON.stringify(modelProfile(ctx.model?.id, blueprintConfig(deps.config)), null, 2));
    }
  });

}
