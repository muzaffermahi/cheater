// Commitlet user commands. Everything here renders DIRECTLY from harness state - no command
// sends the model off to call a tool it may not see (the "/command tells the model to call a
// masked-away tool" black hole). The only exceptions are the two flow commands
// (/commitlet-next, /commitlet-revert) whose tools are in every execute mask.

import { defaultCommitletState } from "./state.js";
import { formatCommitletFinalReview, formatCommitletPlan, formatCommitletStatus } from "./ui.js";
import { buildRepoConstraintGraph, queryConstraintFacts } from "./constraintGraph.js";
import { latestReliabilityBenchmark, compareReliabilityBenchmark } from "../reliability/bench.js";

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

  pi.registerCommand("constraint-graph", {
    description: "Show compact repo constraint graph facts",
    handler: async (args: string, ctx: CommandContext) => {
      const queryFile = args.trim();
      const plan = defaultCommitletState.get().currentPlan;
      const files = queryFile
        ? [queryFile]
        : [...new Set(plan?.commitlets.flatMap((commitlet) => commitlet.allowedFiles.filter((file) => !file.startsWith("(") && !file.endsWith("/"))) ?? [])];
      if (!files.length) {
        widget(ctx, "No files to graph: pass a file (/constraint-graph src/foo.ts) or start a plan first.");
        return;
      }
      const graph = buildRepoConstraintGraph(ctx.cwd, files);
      const facts = queryFile ? queryConstraintFacts(graph, queryFile) : [];
      widget(ctx, [
        "Constraint graph",
        `files: ${graph.files.length}, symbols: ${graph.symbols.length}, exports: ${graph.exports.length}, imports: ${graph.imports.length}`,
        `tests: ${graph.tests.length}, testMappings: ${graph.testMappings.length}, verificationHints: ${graph.verificationCommands.length}`,
        facts.length ? `facts:\n- ${facts.join("\n- ")}` : ""
      ].filter(Boolean).join("\n"));
    }
  });

  pi.registerCommand("bench-report", {
    description: "Show latest local reliability benchmark report",
    handler: async (_args: string, ctx: CommandContext) => {
      const results = latestReliabilityBenchmark(ctx.cwd);
      widget(ctx, results.length ? compareReliabilityBenchmark(results) : "No reliability benchmark report found.");
    }
  });
}
