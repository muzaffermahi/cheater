import { ConversationStore } from "./store/conversationStore.js";
import type { KittenEvent, Lane } from "./events.js";
import { writeFileSync } from "node:fs";

function pad2(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDur(ms: number): string {
  if (ms < 1000) return ms + "ms";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m " + (s % 60) + "s";
}

function fmtTok(n: number): string {
  if (n < 1000) return n + " tok";
  return (n / 1000).toFixed(1) + "k tok";
}

interface RunMeta {
  lane?: Lane;
  k: number;
  model?: string;
  finished: boolean;
  verified: boolean;
  cancelled: boolean;
  interrupted: boolean;
  wallMs?: number;
  usage?: { prompt: number; completion: number; reasoning: number };
  error?: string;
}

interface ToolCall {
  name: string;
  args: string;
  output: string;
  durationMs: number;
  ok: boolean;
}

interface Check {
  check: string;
  passed: boolean;
  durationMs: number;
  proves?: string;
}

export function exportConversationMarkdown(store: ConversationStore, conversationId: string): string {
  const conv = store.getConversation(conversationId);
  if (!conv) throw new Error(`conversation not found: ${conversationId}`);
  const events = store.readEvents(conversationId);

  const runMeta = new Map<string, RunMeta>();
  for (const e of events) {
    if (!("runId" in e)) continue;
    const rid = (e as KittenEvent & { runId: string }).runId;
    if (!runMeta.has(rid)) runMeta.set(rid, { k: 1, finished: false, verified: false, cancelled: false, interrupted: false });
    const m = runMeta.get(rid)!;
    switch (e.type) {
      case "route.selected": m.lane = e.lane; m.k = e.k; break;
      case "run.started": m.model = e.model; break;
      case "run.completed": m.finished = e.finished; m.verified = e.verified; m.wallMs = e.wallMs; m.usage = e.usage; m.model ??= e.model; break;
      case "run.failed": m.error = e.error; break;
      case "run.cancelled": m.cancelled = true; break;
      case "run.interrupted": m.interrupted = true; break;
    }
  }

  const lines: string[] = [];
  const md = (s: string) => lines.push(s);

  md(`# ${conv.title}`);
  const metaParts = [`_kitten conversation ${conv.id}`];
  if (conv.projectRoot) metaParts.push(`project root: ${conv.projectRoot}`);
  metaParts.push(`model: ${conv.model}`);
  if (conv.provider) metaParts.push(`provider: ${conv.provider}`);
  metaParts.push(fmtDate(conv.createdAt) + "_");
  md(metaParts.join(" · "));
  md("");

  let userTs = 0;
  let userText = "";
  let runId = "";
  let assistantTs = 0;
  let assistantText = "";
  const tools: ToolCall[] = [];
  const checks: Check[] = [];
  let verWhat = "";
  let verPassed = "";
  let verFailed = "";
  let failureCard = "";

  function flush(): void {
    if (!userTs && !assistantText && !runId) return;
    if (userText) {
      md("## You — " + fmtTime(userTs));
      md(userText);
      md("");
    }
    if (assistantText || runId) {
      const rm = runId ? runMeta.get(runId) : undefined;
      const parts: string[] = [];
      if (rm?.lane) parts.push("lane: " + rm.lane);
      if (rm && rm.k > 1) parts.push("k=" + rm.k);
      if (rm?.finished) parts.push(rm.verified ? "✓ verified" : "~ checked");
      else if (rm?.cancelled) parts.push("cancelled");
      else if (rm?.interrupted) parts.push("interrupted");
      if (rm?.wallMs != null) parts.push(fmtDur(rm.wallMs));
      if (rm?.usage) { const t = rm.usage.prompt + rm.usage.completion + rm.usage.reasoning; if (t > 0) parts.push(fmtTok(t)); }

      md("## Kitten — " + fmtTime(assistantTs || userTs) + (parts.length ? " · " + parts.join(" · ") : ""));
      if (assistantText) md(assistantText);
      md("");

      if (tools.length > 0) {
        md("<details>");
        md("<summary>Tools</summary>");
        md("");
        for (const tc of tools) {
          md("**" + tc.name + "**" + (tc.durationMs > 0 ? " (" + fmtDur(tc.durationMs) + ")" : ""));
          if (tc.args) { md("```"); md(tc.args); md("```"); }
          if (tc.output) { md("```"); md(tc.output); md("```"); }
          md(tc.ok ? "_completed_" : "_failed_");
          md("");
        }
        md("</details>");
        md("");
      }

      if (checks.length > 0 || verWhat || verPassed || verFailed) {
        md("<details>");
        md("<summary>Verification</summary>");
        md("");
        if (verWhat) md("**" + verWhat + "**" + "");
        for (const c of checks) {
          md("- " + (c.passed ? "✓" : "✗") + " `" + c.check + "`" + (c.proves ? " — " + c.proves : "") + " (" + fmtDur(c.durationMs) + ")");
        }
        if (verPassed) { md(""); md("_" + verPassed + "_"); }
        if (verFailed) { md(""); md("_" + verFailed + "_"); }
        md("");
        md("</details>");
        md("");
      }

      if (rm?.error) { md("**Error:** " + rm.error); md(""); }
      if (failureCard) { md("<details>"); md("<summary>Sidecar failure card (advisory)</summary>"); md(""); md(failureCard); md(""); md("</details>"); md(""); }
    }

    userTs = 0; userText = ""; runId = ""; assistantTs = 0; assistantText = "";
    tools.length = 0; checks.length = 0; verWhat = ""; verPassed = ""; verFailed = ""; failureCard = "";
  }

  for (const e of events) {
    const rid = "runId" in e ? (e as KittenEvent & { runId: string }).runId : "";
    switch (e.type) {
      case "conversation.created":
      case "conversation.renamed":
      case "conversation.archived":
        break;
      case "user.message":
        flush();
        userTs = e.ts;
        userText = e.text;
        break;
      case "route.selected":
      case "run.started":
        if (!runId) runId = rid;
        break;
      case "assistant.final":
        runId = rid;
        assistantTs = e.ts;
        assistantText = e.text;
        break;
      case "tool.proposed":
        tools.push({ name: e.name, args: e.args, output: "", durationMs: 0, ok: false });
        break;
      case "tool.started":
        break;
      case "tool.completed": {
        const t = tools.find(tc => tc.name === e.name);
        if (t) { t.durationMs = e.durationMs; t.ok = e.ok; t.output = e.output; }
        break;
      }
      case "verification.started":
        verWhat = e.what;
        break;
      case "verification.evidence":
        checks.push({ check: e.check, passed: e.passed, durationMs: e.durationMs, proves: e.proves });
        break;
      case "verification.failed":
        verFailed = e.detail;
        break;
      case "verification.passed":
        verPassed = e.detail;
        break;
      case "sidecar.failure":
        failureCard = `Source: ${e.source}\nSeverity: ${e.severity}\nSignature: ${e.signature}\nLikely cause: ${e.likelyCause}${e.salientLines.length ? `\nSalient lines:\n${e.salientLines.map((line) => `- ${line}`).join("\n")}` : ""}`;
        break;
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.interrupted":
        break;
    }
  }
  flush();

  return lines.join("\n");
}

export function exportToFile(store: ConversationStore, conversationId: string, outPath: string): string {
  const markdown = exportConversationMarkdown(store, conversationId);
  writeFileSync(outPath, markdown, "utf8");
  return outPath;
}
