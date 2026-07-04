// Silent dev trace: harness-owned instrumentation that records the WHOLE main-session trajectory
// (user prompts, model reasoning/thinking, assistant text, every tool call with args + result,
// and timing) to a plain-text file in the project folder. Toggled by the /dev command.
//
// CRITICAL DESIGN CONSTRAINT: the model must not be aware this exists. This logger ONLY taps
// pure-notification Pi events (agent_start / turn_start / message_start / tool_execution_start /
// tool_execution_end / turn_end / model_select) - events with NO *EventResult type - and its
// handlers return nothing. It never mutates a prompt, a tool result, or the transcript, and never
// injects a message. So it is completely invisible to the agent loop; it is a passive tap, not a
// participant. Every write is wrapped so a logging failure can never break the session.
//
// Scope note: fresh isolated worker sub-sessions are their own createAgentSession instances that
// do NOT load this extension, so their internal reasoning is not captured here - the trace covers
// the main session the user drives (routing, the orchestrator's reasoning, tool calls including
// cheater_run and its grades/receipts, and, in in-session/simulated mode, the actual edits).

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redactSecrets } from "../reliability/redact.js";

const LOG_DIR = join(".cheater", "dev-logs");
const MARKER = ".enabled";
const MAX_FIELD_CHARS = 16000;

function clip(text: string, max = MAX_FIELD_CHARS): string {
  const s = text ?? "";
  return s.length <= max ? s : `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]`;
}

function shortId(id: string | undefined): string {
  return id ? id.slice(-6) : "?";
}

interface MessageLike { role?: string; content?: unknown }

/** All text-bearing parts of a message, split into reasoning ("thinking") vs visible ("text"). */
export function extractParts(message: MessageLike | undefined): Array<{ kind: "thinking" | "text"; text: string }> {
  const out: Array<{ kind: "thinking" | "text"; text: string }> = [];
  const content = message?.content;
  if (typeof content === "string") {
    if (content.trim()) out.push({ kind: "text", text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as { type?: string; text?: string; thinking?: string; content?: string };
    const type = String(part.type ?? "text");
    if (/think|reason/i.test(type)) {
      const text = part.thinking ?? part.text ?? part.content;
      if (text) out.push({ kind: "thinking", text: String(text) });
    } else if (type === "text" && part.text) {
      out.push({ kind: "text", text: String(part.text) });
    }
    // tool_use / tool_result parts are captured via the dedicated tool events, not here.
  }
  return out;
}

export function messageText(message: MessageLike | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  return extractParts(message).filter((part) => part.kind === "text").map((part) => part.text).join("\n");
}

export function roleOf(message: MessageLike | undefined): string {
  return String(message?.role ?? "");
}

/** Render a tool's arguments compactly - shell commands as `$ cmd`, everything else as JSON. */
function renderArgs(toolName: string, args: unknown): string {
  const a = args as Record<string, unknown> | undefined;
  if (a && typeof a.command === "string") return `$ ${a.command}`;
  if (a && typeof a.path === "string") {
    const extra = typeof a.startLine === "number" ? `:${a.startLine}-${a.endLine ?? a.startLine}` : "";
    return `${toolName} ${a.path}${extra}`;
  }
  try { return JSON.stringify(args); } catch { return String(args); }
}

/** Render a tool result - prefer a text/content payload, else JSON. */
function renderResult(result: unknown): string {
  if (result == null) return "(no result)";
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { text?: string } => Boolean(part) && typeof part === "object")
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  const output = (result as { output?: unknown }).output;
  if (typeof output === "string") return output;
  try { return JSON.stringify(result); } catch { return String(result); }
}

class DevLog {
  private enabled = false;
  private file: string | null = null;
  private start = 0;
  private count = 0;
  private readonly toolStart = new Map<string, { at: number; name: string }>();

  isEnabled(): boolean { return this.enabled; }
  currentFile(): string | null { return this.file; }
  eventCount(): number { return this.count; }
  markerPath(cwd: string): string { return join(resolve(cwd), LOG_DIR, MARKER); }

  private stamp(at: number): string {
    return `[+${((at - this.start) / 1000).toFixed(3).padStart(8)}s]`;
  }

  private write(text: string): void {
    if (!this.enabled || !this.file) return;
    try {
      // A shareable trace must never leak secrets, even though the model itself saw them.
      const safe = redactSecrets(text);
      appendFileSync(this.file, safe.endsWith("\n") ? safe : `${safe}\n`, "utf8");
      this.count += 1;
    } catch {
      // Logging must NEVER break the session.
    }
  }

  private line(text: string, at = Date.now()): void {
    this.write(`${this.stamp(at)} ${text}`);
  }

  private block(label: string, body: string, at = Date.now()): void {
    const indented = clip(body).split(/\r?\n/).map((l) => `    ${l}`).join("\n");
    this.write(`${this.stamp(at)} ${label}\n${indented}`);
  }

  private openFile(cwd: string, model?: string): void {
    const dir = join(resolve(cwd), LOG_DIR);
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join(dir, `dev-trace-${ts}.log`);
    this.start = Date.now();
    this.enabled = true;
    this.count = 0;
    this.toolStart.clear();
    try {
      appendFileSync(this.file, `${[
        "=".repeat(80),
        " Cheater dev trace - silent instrumentation (the model is NOT aware of this file)",
        ` started: ${new Date().toISOString()}`,
        ` cwd:     ${resolve(cwd)}`,
        ` model:   ${model ?? "(default)"}`,
        " legend:  USER / THINK / ASSISTANT / TOOL / RESULT / TURN - [+elapsed s] since start",
        "=".repeat(80),
        ""
      ].join("\n")}\n`, "utf8");
    } catch {
      // header is best-effort
    }
  }

  /** Turn logging ON: persist the marker (survives restarts) and open a fresh per-session file. */
  enable(cwd: string, model?: string): string {
    mkdirSync(join(resolve(cwd), LOG_DIR), { recursive: true });
    try { writeFileSync(this.markerPath(cwd), "", "utf8"); } catch { /* marker is best-effort */ }
    this.openFile(cwd, model);
    return this.file ?? "(unavailable)";
  }

  /** Turn logging OFF: stop writing and remove the marker so it stays off across restarts. */
  disable(cwd: string): void {
    if (this.enabled) this.line("DEV LOG STOPPED");
    try { const marker = this.markerPath(cwd); if (existsSync(marker)) rmSync(marker); } catch { /* best-effort */ }
    this.enabled = false;
    this.file = null;
  }

  /** If enabled in a prior session (marker present), open a fresh file for THIS session. */
  resumeIfMarked(cwd: string, model?: string): boolean {
    if (this.enabled) return true;
    if (existsSync(this.markerPath(cwd))) {
      this.openFile(cwd, model);
      return true;
    }
    return false;
  }

  statusText(cwd: string): string {
    if (this.enabled) return `Cheater /dev: ON - ${this.count} event(s) -> ${this.file}`;
    return existsSync(this.markerPath(cwd))
      ? "Cheater /dev: armed (marker present) - a fresh trace opens on the next prompt."
      : "Cheater /dev: OFF. Run /dev on to start silently logging reasoning, commands, and timing.";
  }

  // --- event taps (all no-ops when disabled) --------------------------------------------------
  runStart(): void { this.line("RUN START"); }
  turnStart(index: number): void { this.line(`TURN ${index} START`); }
  model(id: string): void { this.line(`MODEL ${id}`); }
  userInput(text: string): void { this.block("USER", text); }

  toolStartEvent(toolCallId: string, name: string, args: unknown): void {
    const at = Date.now();
    this.toolStart.set(toolCallId, { at, name });
    this.block(`TOOL ${name} #${shortId(toolCallId)}`, renderArgs(name, args), at);
  }

  toolEndEvent(toolCallId: string, name: string, result: unknown, isError: boolean): void {
    const at = Date.now();
    const started = this.toolStart.get(toolCallId);
    this.toolStart.delete(toolCallId);
    const dur = started ? `${((at - started.at) / 1000).toFixed(2)}s` : "?";
    this.block(`RESULT ${name} #${shortId(toolCallId)} (${dur}, ${isError ? "ERROR" : "ok"})`, renderResult(result), at);
  }

  assistant(message: MessageLike | undefined): void {
    for (const part of extractParts(message)) {
      this.block(part.kind === "thinking" ? "THINK" : "ASSISTANT", part.text);
    }
  }

  turnEnd(index: number, toolCount: number): void {
    const at = Date.now();
    this.line(`TURN ${index} END (elapsed ${((at - this.start) / 1000).toFixed(2)}s, tools=${toolCount})`, at);
  }
}

/** Process-level singleton: one dev trace per Cheater session. */
export const devLog = new DevLog();

type ExtensionAPI = { registerCommand: (name: string, opts: unknown) => void; on: (event: string, handler: (...args: unknown[]) => unknown) => void };

async function devCommand(args: string, ctx: any): Promise<void> {
  const arg = (args ?? "").trim().toLowerCase();
  const notify = (text: string) => { try { ctx?.ui?.notify?.(text, "info"); } catch { /* ignore */ } };
  if (arg === "off" || arg === "stop" || arg === "disable") {
    const kept = devLog.currentFile();
    devLog.disable(ctx.cwd);
    notify(`Cheater /dev: logging OFF.${kept ? ` Trace kept at ${kept}` : ""}`);
    return;
  }
  if (arg === "status") { notify(devLog.statusText(ctx.cwd)); return; }
  // Bare /dev toggles; /dev on forces on.
  if (!arg && devLog.isEnabled()) {
    const kept = devLog.currentFile();
    devLog.disable(ctx.cwd);
    notify(`Cheater /dev: logging OFF.${kept ? ` Trace kept at ${kept}` : ""}`);
    return;
  }
  const file = devLog.enable(ctx.cwd, ctx?.model?.id);
  notify([
    "Cheater /dev: silent logging ON.",
    "Recording every prompt, reasoning/thinking trace, tool call, result, and timing to:",
    file,
    "The model is NOT aware of this file. Run /dev off to stop (the trace is kept)."
  ].join("\n"));
}

/**
 * Register the /dev command and the silent event taps. Taps ONLY pure-notification events (no
 * result type), so this is invisible to the agent loop and cannot interfere with any other
 * handler. Call once from the extension factory.
 */
export function registerDevLog(pi: ExtensionAPI): void {
  pi.registerCommand("dev", {
    description: "Toggle a silent dev trace (reasoning, commands, timing) written to .cheater/dev-logs/ in the project. /dev [on|off|status]",
    handler: devCommand
  });

  // agent_start: arm from a persisted marker (so it survives restarts) and mark the run boundary.
  pi.on("agent_start", async (_event: any, ctx: any) => {
    try { devLog.resumeIfMarked(ctx?.cwd ?? process.cwd(), ctx?.model?.id); devLog.runStart(); } catch { /* never break the run */ }
  });
  pi.on("turn_start", async (event: any) => {
    try { devLog.turnStart(Number(event?.turnIndex ?? 0)); } catch { /* ignore */ }
  });
  pi.on("message_start", async (event: any) => {
    try { if (roleOf(event?.message) === "user") devLog.userInput(messageText(event.message)); } catch { /* ignore */ }
  });
  pi.on("tool_execution_start", async (event: any) => {
    try { devLog.toolStartEvent(String(event?.toolCallId ?? ""), String(event?.toolName ?? "tool"), event?.args); } catch { /* ignore */ }
  });
  pi.on("tool_execution_end", async (event: any) => {
    try { devLog.toolEndEvent(String(event?.toolCallId ?? ""), String(event?.toolName ?? "tool"), event?.result, Boolean(event?.isError)); } catch { /* ignore */ }
  });
  pi.on("turn_end", async (event: any) => {
    try { devLog.assistant(event?.message); devLog.turnEnd(Number(event?.turnIndex ?? 0), Array.isArray(event?.toolResults) ? event.toolResults.length : 0); } catch { /* ignore */ }
  });
  pi.on("model_select", async (event: any) => {
    try { devLog.model(String(event?.model?.id ?? "?")); } catch { /* ignore */ }
  });
}
