// Blueprint user commands. Blueprint planning runs INSIDE cheater_reliability_start - it is
// an internal planning engine, not a model-driven flow - so the only commands here are
// read-only inspection (/blueprint-show, /blueprint-docs, /blueprint-memory) and /blueprint-cancel.
// The old packet-dispatch commands (/blueprint-step, /blueprint-force, ...) drove a parallel
// execution path that competed with the reliability flow and were removed with it.

import { defaultBlueprintState } from "./state.js";
import { scoutOfficialDocs } from "./docsScout.js";
import { blueprintConfig } from "./config.js";
import { retrievePlanningMemory } from "./memory.js";
import { formatBlueprintRunState } from "./ui.js";
import type { CheaterConfig } from "../types.js";

type ExtensionAPI = any;
type CommandContext = any;

function widget(ctx: CommandContext, key: string, text: string, level: "info" | "warning" = "info"): void {
  ctx.ui.notify(text.split("\n")[0], level);
  ctx.ui.setWidget?.(key, text.split("\n").slice(0, 100), { placement: "aboveEditor" });
}

export function registerBlueprintCommands(pi: ExtensionAPI, deps: { config: CheaterConfig }): void {
  pi.registerCommand("blueprint-show", {
    description: "Show the current internal Autonomous Blueprint plan",
    handler: async (_args: string, ctx: CommandContext) => {
      widget(ctx, "cheater-blueprint", formatBlueprintRunState(defaultBlueprintState.get()));
    }
  });

  pi.registerCommand("blueprint-cancel", {
    description: "Cancel the current internal blueprint run",
    handler: async (_args: string, ctx: CommandContext) => {
      defaultBlueprintState.cancel();
      widget(ctx, "cheater-blueprint", "Cheater Blueprint cancelled.");
    }
  });

  pi.registerCommand("blueprint-docs", {
    description: "Search configured official/local docs facts",
    handler: async (args: string, ctx: CommandContext) => {
      const query = args.trim();
      if (!query) {
        widget(ctx, "cheater-blueprint-docs", "Usage: /blueprint-docs <query>", "warning");
        return;
      }
      const facts = await scoutOfficialDocs({ cwd: ctx.cwd, query, config: blueprintConfig(deps.config) });
      widget(ctx, "cheater-blueprint-docs", facts.map((fact) => `${fact.sourceTitle}: ${fact.claim}`).join("\n") || "No docs facts found.");
    }
  });

  pi.registerCommand("blueprint-memory", {
    description: "Show blueprint planning memories for a query",
    handler: async (args: string, ctx: CommandContext) => {
      const query = args.trim() || defaultBlueprintState.get().currentPlan?.userGoal || "";
      if (!query) {
        widget(ctx, "cheater-blueprint-memory", "No blueprint memory query available.", "warning");
        return;
      }
      const hits = retrievePlanningMemory(ctx.cwd, query, blueprintConfig(deps.config).blueprintMemoryEnabled);
      widget(ctx, "cheater-blueprint-memory", hits.map((hit) => `${hit.id}: ${hit.summary}`).join("\n") || "No blueprint memories found.");
    }
  });
}
