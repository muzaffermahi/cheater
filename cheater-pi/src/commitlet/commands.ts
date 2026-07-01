import { defaultCommitletState } from "./state.js";
import { formatCommitletFinalReview, formatCommitletPlan, formatCommitletStatus } from "./ui.js";

type ExtensionAPI = any;
type CommandContext = any;

function widget(ctx: CommandContext, text: string): void {
  ctx.ui.setWidget?.("cheater-commitlet", text.split("\n").slice(0, 80), { placement: "aboveEditor" });
  ctx.ui.notify?.(text.split("\n")[0], "info");
}

export function registerCommitletCommands(pi: ExtensionAPI): void {
  pi.registerCommand("commitlet-status", {
    description: "Show Reliability Kernel commitlet status",
    handler: async (_args: string, ctx: CommandContext) => widget(ctx, formatCommitletStatus(defaultCommitletState.get().currentPlan))
  });
  pi.registerCommand("commitlet-plan", {
    description: "Show active commitlet plan",
    handler: async (_args: string, ctx: CommandContext) => {
      const plan = defaultCommitletState.get().currentPlan;
      widget(ctx, plan ? formatCommitletPlan(plan) : "No active Cheater commitlet plan.");
    }
  });
  pi.registerCommand("commitlet-next", {
    description: "Run the next commitlet manually",
    handler: async (_args: string, _ctx: CommandContext) => {
      pi.sendUserMessage("Cheater /commitlet-next: call cheater_commitlet_next and execute only the returned fresh-call commitlet.");
    }
  });
  pi.registerCommand("commitlet-health", {
    description: "Show latest commitlet health/final review",
    handler: async (_args: string, ctx: CommandContext) => {
      const review = defaultCommitletState.get().currentPlan?.finalReview;
      widget(ctx, review ? formatCommitletFinalReview(review) : "No commitlet health report yet.");
    }
  });
  pi.registerCommand("commitlet-revert", {
    description: "Revert current or named commitlet if safe",
    handler: async (args: string, _ctx: CommandContext) => {
      const suffix = args.trim() ? ` commitletId=${args.trim()}` : "";
      pi.sendUserMessage(`Cheater /commitlet-revert: call cheater_commitlet_revert${suffix} and report rollback status compactly.`);
    }
  });
  pi.registerCommand("commitlet-verify", {
    description: "Run focused verification for current or named commitlet",
    handler: async (args: string, _ctx: CommandContext) => {
      const id = args.trim();
      pi.sendUserMessage(id
        ? `Cheater /commitlet-verify: call cheater_commitlet_verify with commitletId=${id}.`
        : "Cheater /commitlet-verify: identify the current running commitlet, call cheater_commitlet_verify, and report compactly.");
    }
  });
  pi.registerCommand("commitlet-finalize", {
    description: "Run commitlet final review manually",
    handler: async (_args: string, _ctx: CommandContext) => {
      pi.sendUserMessage("Cheater /commitlet-finalize: call cheater_commitlet_finalize and report the final review compactly.");
    }
  });
  pi.registerCommand("commitlet-debug", {
    description: "Show active commitlet JSON",
    handler: async (_args: string, ctx: CommandContext) => {
      widget(ctx, JSON.stringify(defaultCommitletState.get().currentPlan ?? { status: "none" }, null, 2));
    }
  });

  pi.registerCommand("rollback-status", {
    description: "Show commitlet rollback snapshot status",
    handler: async (args: string, _ctx: CommandContext) => {
      const cleanup = /\bcleanup\b/i.test(args);
      pi.sendUserMessage(`Cheater /rollback-status: call cheater_rollback_status${cleanup ? " with cleanup=true" : ""} and report compactly.`);
    }
  });

  pi.registerCommand("health-report", {
    description: "Show latest Reliability Kernel health report",
    handler: async (_args: string, _ctx: CommandContext) => {
      pi.sendUserMessage("Cheater /health-report: call cheater_health_report and report compactly.");
    }
  });

  pi.registerCommand("constraint-graph", {
    description: "Show compact repo constraint graph facts",
    handler: async (args: string, _ctx: CommandContext) => {
      const file = args.trim();
      pi.sendUserMessage(file
        ? `Cheater /constraint-graph: call cheater_constraint_graph with queryFile=${file}.`
        : "Cheater /constraint-graph: call cheater_constraint_graph for the active commitlet files.");
    }
  });

  pi.registerCommand("bench-report", {
    description: "Show latest local reliability benchmark report",
    handler: async (_args: string, _ctx: CommandContext) => {
      pi.sendUserMessage("Cheater /bench-report: call cheater_bench_report and report compactly.");
    }
  });
}
