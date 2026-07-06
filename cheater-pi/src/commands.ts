import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandHelp } from "./ui.js";
import { renderSkills } from "./skills.js";
import { saveMemory } from "./tools.js";
import type { CheaterConfig } from "./types.js";

type ExtensionAPI = any;
type CommandContext = any;

const PUBLIC_COMMAND_NAMES = [
  "cheater",
  "autopilot-status",
  "reliability-status",
  "blueprint-show",
  "blueprint-cancel",
  "blueprint-docs",
  "blueprint-memory",
  "commitlet-status",
  "commitlet-plan",
  "commitlet-revert",
  "commitlet-health",
  "rollback-status",
  "constraint-graph",
  "bench-report",
  "model-profile",
  "provider-probe",
  "gym",
  "gym-list",
  "gym-run",
  "gym-run-suite",
  "gym-report",
  "gym-delta",
  "gym-learn",
  "gym-clean",
  "test",
  "map",
  "pi",
  "remember",
  "skills",
  "traces",
  "history",
  "dev",
  "sidecar",
  "steer",
  "settings",
  "doctor"
];

const DEBUG_COMMAND_NAMES = [
  "commitlet-next",
  "commitlet-debug",
  "autopilot-route",
  "autopilot-run"
];

function notifyBlock(ctx: CommandContext, text: string): void {
  ctx.ui.notify(text, "info");
  ctx.ui.setWidget?.("cheater-help", text.split("\n").slice(0, 80), { placement: "aboveEditor" });
}

async function askOrUse(args: string, ctx: CommandContext, title: string, placeholder: string): Promise<string | undefined> {
  const trimmed = args.trim();
  if (trimmed) return trimmed;
  if (!ctx.hasUI) return undefined;
  return ctx.ui.input(title, placeholder);
}

export function registerCheaterCommands(pi: ExtensionAPI, config?: CheaterConfig): void {
  pi.registerCommand("cheater", {
    description: "Show Cheater status and commands",
    handler: async (_args: string, ctx: CommandContext) => {
      notifyBlock(ctx, `${commandHelp(config)}\n\nrepo: ${ctx.cwd}`);
    }
  });

  pi.registerCommand("test", {
    description: "Infer or run a focused test command",
    handler: async (args: string, ctx: CommandContext) => {
      const hint = args.trim();
      const pkg = join(ctx.cwd, "package.json");
      const pyproject = join(ctx.cwd, "pyproject.toml");
      const fallback = existsSync(pyproject) ? "pytest -q" : existsSync(pkg) ? "npm test" : "";
      const request = hint
        ? `Cheater /test: run or refine this focused test command and summarize compactly: ${hint}`
        : `Cheater /test: infer the narrowest useful test command for this repo${fallback ? `, starting from ${fallback}` : ""}. Run it if safe and summarize compactly.`;
      pi.sendUserMessage(request);
    }
  });

  pi.registerCommand("map", {
    description: "Ask Pi for a compact repo overview",
    handler: async (_args: string, _ctx: CommandContext) => {
      pi.sendUserMessage("Cheater /map: build a compact repo overview using Pi's native search/list/read tools. Keep it short and emphasize entry points, tests, and likely edit areas.");
    }
  });

  pi.registerCommand("pi", {
    description: "Toggle pi's raw tool output (Cheater collapses it by default for a clean view)",
    handler: async (_args: string, ctx: CommandContext) => {
      try {
        const expanded = !ctx.ui.getToolsExpanded?.();
        ctx.ui.setToolsExpanded?.(expanded);
        ctx.ui.notify?.(expanded ? "Cheater: raw pi tool output SHOWN" : "Cheater: clean view - pi tool output collapsed", "info");
      } catch { /* best-effort; the toggle is cosmetic */ }
    }
  });

  pi.registerCommand("remember", {
    description: "Save a Cheater project note",
    handler: async (args: string, ctx: CommandContext) => {
      const note = await askOrUse(args, ctx, "Cheater /remember", "Project note to remember");
      if (!note) {
        ctx.ui.notify("No note saved.", "warning");
        return;
      }
      const file = saveMemory(ctx.cwd, note);
      ctx.ui.notify(`Saved Cheater memory: ${file}`, "info");
    }
  });

  pi.registerCommand("skills", {
    description: "List Cheater skills",
    handler: async (_args: string, ctx: CommandContext) => {
      notifyBlock(ctx, renderSkills());
    }
  });

  const historyHandler = async (_args: string, ctx: CommandContext) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    notifyBlock(ctx, `Cheater history\nsession entries: ${entries.length}\nUse Pi's session commands for full history and resume behavior.`);
  };
  pi.registerCommand("traces", { description: "Show recent Cheater/Pi history summary", handler: historyHandler });
  pi.registerCommand("history", { description: "Alias for /traces", handler: historyHandler });

  pi.registerCommand("settings", {
    description: "Show Cheater settings",
    handler: async (_args: string, ctx: CommandContext) => {
      const tools = pi.getActiveTools?.() ?? [];
      notifyBlock(ctx, `Cheater settings\nrepo: ${ctx.cwd}\nactive tools: ${tools.join(", ") || "(none)"}\nCheater package: active`);
    }
  });

  pi.registerCommand("doctor", {
    description: "Run Cheater extension diagnostics",
    handler: async (_args: string, ctx: CommandContext) => {
      const tools = pi.getAllTools?.().map((tool: { name: string }) => tool.name) ?? [];
      const commands = pi.getCommands?.().map((command: { name: string }) => command.name) ?? [];
      // A registered Cheater command not in either bucket used to vanish from doctor output
      // entirely, silently, whenever a new command was added but these lists were not
      // updated (confirmed: commitlet-status/plan/health/revert/verify, rollback-status,
      // health-report, constraint-graph, bench-report, model-profile, loop-report,
      // blueprint-approve/eval, autopilot-route/run were all missing). Any command whose
      // name matches a known Cheater prefix but is not in either list is now surfaced
      // explicitly instead of disappearing, so this diagnostic can never again silently
      // under-report what is loaded.
      const knownCheaterCommands = new Set(PUBLIC_COMMAND_NAMES.concat(DEBUG_COMMAND_NAMES));
      const cheaterCommandPrefixes = ["autopilot-", "blueprint-", "commitlet-", "gym-", "reliability-"];
      const uncategorized = commands.filter((name: string) =>
        !knownCheaterCommands.has(name) && cheaterCommandPrefixes.some((prefix) => name.startsWith(prefix))
      );
      notifyBlock(
        ctx,
        [
          "Cheater doctor",
          `repo: ${ctx.cwd}`,
          `mode: ${ctx.mode}`,
          `project trusted: ${ctx.isProjectTrusted?.() ? "yes" : "no"}`,
          `Cheater tools loaded: ${tools.filter((name: string) => name.startsWith("cheater_")).join(", ")}`,
          `Compacted bug memories: ${tools.includes("cheater_bug_memory_search") ? "enabled" : "missing"}`,
          `Public commands loaded: ${commands.filter((name: string) => PUBLIC_COMMAND_NAMES.includes(name)).join(", ")}`,
          `Debug commands loaded: ${commands.filter((name: string) => DEBUG_COMMAND_NAMES.includes(name)).join(", ") || "(none)"}`,
          uncategorized.length ? `Uncategorized commands loaded (add to PUBLIC_COMMAND_NAMES/DEBUG_COMMAND_NAMES in commands.ts): ${uncategorized.join(", ")}` : ""
        ].filter(Boolean).join("\n")
      );
    }
  });
}
