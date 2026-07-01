import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type BridgeResult = {
  ok: boolean;
  summary: string;
  message?: string;
  sendToAgent?: boolean;
};

export default function cheaterExtension(pi: any) {
  const runDir = process.env.CHEATER_RUN_DIR;
  const projectRoot = process.env.CHEATER_PROJECT_ROOT;
  const python = process.env.CHEATER_PYTHON || "python";

  function appendAgentEvent(label: string, event: unknown) {
    if (!runDir) return;
    try {
      appendFileSync(
        path.join(runDir, "pi_stdout.log"),
        `\n[${label}]\n${JSON.stringify(event, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // Logging must never break the Pi session.
    }
  }

  function updateSummary(updates: Record<string, unknown>) {
    if (!runDir) return;
    const summaryPath = path.join(runDir, "run_summary.json");
    try {
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      Object.assign(summary, updates);
      writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      const sessionPath = path.join(runDir, "session.json");
      const session = JSON.parse(readFileSync(sessionPath, "utf8"));
      Object.assign(session, updates, { updated_at: new Date().toISOString() });
      writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    } catch {
      // Summary persistence is best-effort inside the extension.
    }
  }

  async function bridge(action: string, extraArgs: string[] = []): Promise<BridgeResult> {
    if (!runDir || !projectRoot) {
      return {
        ok: false,
        summary: "Cheater environment is missing. Launch Pi through cheater.py.",
      };
    }
    const bridgePath = path.join(projectRoot, "cheater_bridge.py");
    return await new Promise((resolve) => {
      const child = spawn(
        python,
        [bridgePath, action, "--run-dir", runDir, ...extraArgs],
        { cwd: process.env.CHEATER_REPO || process.cwd(), windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", (error) => {
        resolve({ ok: false, summary: `Cheater bridge failed: ${error.message}` });
      });
      child.on("close", () => {
        try {
          const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
          resolve(JSON.parse(lines.at(-1) || "{}") as BridgeResult);
        } catch {
          resolve({
            ok: false,
            summary: `Cheater bridge returned invalid output. ${stderr || stdout}`.trim(),
          });
        }
      });
    });
  }

  async function handle(
    action: string,
    args: string,
    ctx: any,
    extraArgs: string[] = [],
  ) {
    const result = await bridge(action, extraArgs);
    ctx.ui.notify(result.summary, result.ok ? "info" : "error");
    if (result.sendToAgent && result.message) {
      await ctx.waitForIdle();
      await ctx.sendUserMessage(result.message);
    }
  }

  pi.registerCommand("status", {
    description: "Show Cheater run and memory status",
    handler: async (_args: string, ctx: any) => handle("status", "", ctx),
  });

  pi.registerCommand("memory", {
    description: "Retrieve fresh bug memories; optional argument overrides the query",
    handler: async (args: string, ctx: any) => {
      const extra = args.trim() ? ["--query", args.trim()] : [];
      await handle("memory", args, ctx, extra);
    },
  });

  pi.registerCommand("tests", {
    description: "Run the configured Cheater test command",
    handler: async (_args: string, ctx: any) => handle("tests", "", ctx),
  });

  pi.registerCommand("retry", {
    description: "Retry using latest test and agent failure evidence",
    handler: async (_args: string, ctx: any) => handle("retry", "", ctx),
  });

  pi.registerCommand("logs", {
    description: "Show Cheater run artifact paths",
    handler: async (_args: string, ctx: any) => handle("logs", "", ctx),
  });

  pi.registerCommand("cheater-prompt", {
    description: "Send the saved initial Cheater prompt again",
    handler: async (_args: string, ctx: any) => handle("prompt", "", ctx),
  });

  pi.registerCommand("clip", {
    description: "Fallback: copy the saved Cheater prompt to the clipboard",
    handler: async (_args: string, ctx: any) => handle("clip", "", ctx),
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.setStatus("cheater", runDir ? "Cheater memory attached" : "Cheater inactive");
    updateSummary({ status: "pi_running", pi_extension_active: true });
  });

  pi.on("agent_end", async (event: any) => {
    appendAgentEvent("agent_end", event);
    updateSummary({ last_agent_end_at: new Date().toISOString() });
  });

  pi.on("tool_execution_end", async (event: any) => {
    appendAgentEvent("tool_execution_end", event);
  });

  pi.on("extension_error", async (event: any) => {
    appendAgentEvent("extension_error", event);
  });

  pi.on("session_shutdown", async () => {
    updateSummary({ pi_extension_active: false });
  });
}
