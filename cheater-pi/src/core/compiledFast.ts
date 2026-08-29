import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { runAgent, type AgentRunResult } from "./agent.js";
import { postEditSyntaxGate } from "./reliable.js";
import type { KittenLLM } from "./llm.js";
import type { Tool, ToolContext, ToolResult } from "./tools.js";
import { extractAcceptanceContract } from "../runstate/contract.js";

export interface CompiledFastInput {
  task: string;
  cwd: string;
  llm: KittenLLM;
  model?: string;
  tools: Tool[];
  onEvent?: AgentRunResult["events"] extends Array<infer E> ? (event: E) => void : never;
  signal?: AbortSignal;
  allowedFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
}

export interface FastEligibility {
  eligible: boolean;
  target?: string;
  reason?: string;
  newArtifact?: boolean;
}

const HIGH_RISK = /\b(?:dependency|dependencies|install|migration|migrate|secret|credential|deploy|deployment|database|schema|multi[- ]?file|integration|production|delete|remove|destroy|payment|auth)\b/i;
const EXT = /\.[a-z0-9]{1,8}$/i;
const CHECKABLE = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".json", ".css"]);

/** Conservative gate: Fast is a single-file mutation compiler, never a general coding lane. */
export function fastEligibility(task: string, cwd: string, effort: string, allowedFiles?: readonly string[]): FastEligibility {
  if (effort !== "fast") return { eligible: false, reason: "effort is not fast" };
  if (HIGH_RISK.test(task)) return { eligible: false, reason: "task contains integration or high-risk work" };
  const contract = extractAcceptanceContract(task);
  const files = contract.files.filter((f) => EXT.test(f));
  if (files.length !== 1) return { eligible: false, reason: "exactly one writable target is required" };
  const target = normalize(files[0]).replace(/\\/g, "/");
  if (!CHECKABLE.has(extname(target).toLowerCase())) return { eligible: false, reason: "no safe static or language check is available for this artifact" };
  if (allowedFiles?.length && !allowedFiles.some((f) => normalize(f).replace(/\\/g, "/").toLowerCase() === target.toLowerCase())) {
    return { eligible: false, reason: "target is outside the allowed file scope" };
  }
  const full = join(cwd, target);
  const newArtifact = !existsSync(full);
  const localized = /\b(?:fix|change|edit|update|modify|refactor|bug|add to|adjust)\b/i.test(task);
  const newFile = /\b(?:create|write|build|implement|generate|add)\b/i.test(task);
  if (!newFile && !localized) return { eligible: false, reason: "task is not a localized edit or new artifact" };
  return { eligible: true, target, newArtifact };
}

function singleMutationTool(tool: Tool, state: { count: number; multiple: boolean }): Tool {
  return {
    schema: tool.schema,
    execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      if (state.count >= 1) {
        state.multiple = true;
        return { output: "error: compiled Fast permits exactly one mutation; fall back to the reliable loop", isError: true };
      }
      state.count++;
      return await tool.execute(args, ctx);
    }
  };
}

function verifyArtifact(cwd: string, target: string, task: string): { ok: boolean; detail: string } {
  const full = join(cwd, target);
  if (!existsSync(full)) return { ok: false, detail: `target ${target} was not created` };
  const source = readFileSync(full, "utf8");
  if (!source.trim()) return { ok: false, detail: `${target} is empty` };
  const ext = extname(target).toLowerCase();
  try {
    if ([".js", ".mjs", ".cjs"].includes(ext)) new Function(source);
    if (ext === ".json") JSON.parse(source);
    if (ext === ".css" && (source.match(/{/g)?.length ?? 0) !== (source.match(/}/g)?.length ?? 0)) return { ok: false, detail: "CSS braces are unbalanced" };
    if (ext === ".html" || ext === ".htm") {
      if (!/<html\b|<!doctype\s+html/i.test(source)) return { ok: false, detail: "HTML artifact has no html/doctype root" };
      const scripts = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter(Boolean);
      if (!scripts.length) return { ok: false, detail: "HTML artifact has no script block" };
      for (const script of scripts) new Function(script);
      const contract = extractAcceptanceContract(task);
      for (const symbol of contract.symbols.filter((s) => /^[A-Za-z_$][\w$]*$/.test(s)).slice(0, 8)) {
        if (!source.includes(symbol)) return { ok: false, detail: `required symbol ${symbol} is missing` };
      }
    }
  } catch (error) {
    return { ok: false, detail: `static syntax check failed: ${(error as Error).message.slice(0, 240)}` };
  }
  return { ok: true, detail: `harness checks passed for ${target}` };
}

export async function runCompiledFast(input: CompiledFastInput): Promise<{ result: AgentRunResult; eligibility: FastEligibility; verified: boolean; diagnostic?: string }> {
  const eligibility = fastEligibility(input.task, input.cwd, "fast", input.allowedFiles);
  if (!eligibility.eligible || !eligibility.target) return { result: undefined as never, eligibility, verified: false };
  const writeTools = input.tools.filter((t) => t.schema.name === "write" || t.schema.name === "edit");
  const state = { count: 0, multiple: false };
  const existingSnippet = eligibility.newArtifact ? "" : (() => { try { return readFileSync(join(input.cwd, eligibility.target!), "utf8").slice(0, 12000); } catch { return ""; } })();
  const result = await runAgent({
    task: input.task,
    cwd: input.cwd,
    llm: input.llm,
    model: input.model,
    tools: writeTools.map((t) => singleMutationTool(t, state)),
    systemPrompt: `Compiled Fast mode. Make exactly one ${eligibility.newArtifact ? "write" : "edit"} mutation to ${eligibility.target}. Do not read, bash, or narrate. Return the mutation now; the harness will verify it. Keep new artifacts compact (under 5,000 output tokens).${existingSnippet ? `\nCurrent target excerpt (already read):\n${existingSnippet}` : ""}`,
    maxTurns: 1,
    maxTokens: eligibility.newArtifact ? 8192 : 3072,
    effort: "fast",
    inferenceRole: "executor",
    inferenceOverrides: { samplingMode: "instruct", reasoningBudget: 0, maxTokens: eligibility.newArtifact ? 8192 : 3072 },
    disableThinking: true,
    signal: input.signal,
    onEvent: input.onEvent,
    allowedFiles: input.allowedFiles,
    forbiddenFiles: input.forbiddenFiles,
    preReadFiles: eligibility.newArtifact ? [] : [eligibility.target],
    postToolHook: (call, res, ctx) => postEditSyntaxGate(call, res, ctx)
  });
  if (state.multiple || state.count !== 1 || result.filesWritten.length !== 1) {
    return { result, eligibility, verified: false, diagnostic: "compiled Fast required exactly one successful in-scope mutation" };
  }
  const check = verifyArtifact(input.cwd, eligibility.target, input.task);
  if (!check.ok) return { result, eligibility, verified: false, diagnostic: check.detail };
  result.finished = true;
  result.summary = `Completed and verified ${eligibility.target} with one compiled mutation.`;
  result.stopReason = "finish";
  return { result, eligibility, verified: true };
}
