// Recover tool calls a model wrote as prose instead of emitting natively.
//
// Local models drop out of native tool-calling constantly, and they do it most reliably right after
// something went wrong: a rejected call, an argument parse failure, a long turn. What comes back is a
// perfectly clear intention rendered as text —
//
//   <tool_call>
//   <function=read_file>
//   <parameter=path>
//   /home/user/repo
//   </parameter>
//   </function>
//   </tool_call>
//
// — which the OpenAI-shaped path cannot see, because `message.tool_calls` is empty. The agent then
// counts the turn as "produced text, took no action", nudges once, sees the same thing again, and
// stops with `stalled`. Observed live: one oversized `write` failed to parse, and two turns later the
// whole run was over, with the model still trying to call a tool in every one of them.
//
// Reading these is not a workaround for a broken model. It is accepting an intention the model stated
// unambiguously, in the only format it had left.

import type { ParsedToolCall } from "./llm.js";

/** The formats seen in the wild, most specific first. */
const TOOL_CALL_BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const FUNCTION_TAG = /<function\s*=\s*([A-Za-z0-9_.-]+)\s*>([\s\S]*?)(?:<\/function>|$)/i;
const PARAMETER_TAG = /<parameter\s*=\s*([A-Za-z0-9_.-]+)\s*>([\s\S]*?)(?:<\/parameter>|$)/gi;

/** A fenced ```json block holding {"name": ..., "arguments": {...}} — the other common fallback. */
const JSON_CALL_FENCE = /```(?:json|tool_call)?\s*(\{[\s\S]*?\})\s*```/gi;

/**
 * Tool calls recoverable from assistant prose. Returns [] when the text contains none, which is the
 * overwhelmingly common case and must stay cheap.
 */
export function parseTextToolCalls(text: string): ParsedToolCall[] {
  if (!text || (!text.includes("<tool_call") && !text.includes("<function") && !text.includes("```"))) return [];
  const calls: ParsedToolCall[] = [];

  // 1. <tool_call> blocks, the format the reference model falls back to.
  for (const match of text.matchAll(TOOL_CALL_BLOCK)) {
    const call = parseFunctionBlock(match[1], calls.length);
    if (call) calls.push(call);
  }
  // 2. A bare <function=...> with no wrapper — the same intent, one tag short.
  if (calls.length === 0 && /<function\s*=/.test(text)) {
    const call = parseFunctionBlock(text, 0);
    if (call) calls.push(call);
  }
  // 3. A fenced JSON object naming a tool.
  if (calls.length === 0) {
    for (const match of text.matchAll(JSON_CALL_FENCE)) {
      try {
        const parsed = JSON.parse(match[1]) as { name?: unknown; tool?: unknown; arguments?: unknown; parameters?: unknown };
        const name = typeof parsed.name === "string" ? parsed.name : typeof parsed.tool === "string" ? parsed.tool : "";
        if (!name) continue;
        const rawArgs = parsed.arguments ?? parsed.parameters ?? {};
        const args = typeof rawArgs === "object" && rawArgs !== null ? rawArgs as Record<string, unknown> : {};
        calls.push({ id: `text-${calls.length}`, name, args, raw: match[1] });
      } catch { /* a fenced block that is not a call is just a code block */ }
    }
  }
  return calls;
}

function parseFunctionBlock(block: string, index: number): ParsedToolCall | null {
  const fn = FUNCTION_TAG.exec(block);
  if (!fn) return null;
  const name = fn[1].trim();
  // Some emitters nest a second <function=tool> wrapper around the real one; the inner name wins.
  const inner = FUNCTION_TAG.exec(fn[2]);
  const body = inner && inner[1] !== "tool" ? inner[2] : fn[2];
  const realName = inner && inner[1] !== "tool" ? inner[1].trim() : name === "tool" && inner ? inner[1].trim() : name;

  const args: Record<string, unknown> = {};
  PARAMETER_TAG.lastIndex = 0;
  for (const param of body.matchAll(PARAMETER_TAG)) {
    // The value is the literal text between the tags, trimmed of the newlines the format adds around
    // it. Anything else — parsing it as JSON, unescaping it — would corrupt file contents.
    args[param[1].trim()] = param[2].replace(/^\r?\n/, "").replace(/\r?\n\s*$/, "");
  }
  if (!realName || realName === "tool") return null;
  return { id: `text-${index}`, name: realName, args, raw: block };
}

/**
 * Strip recovered calls out of the prose so the transcript does not show the same action twice — once
 * as markup the user cannot read, and once as the tool card that actually ran it.
 */
export function stripTextToolCalls(text: string): string {
  return text
    .replace(TOOL_CALL_BLOCK, "")
    .replace(/<function\s*=[\s\S]*?<\/function>/gi, "")
    .replace(JSON_CALL_FENCE, (whole, body: string) => (/"(?:name|tool)"\s*:/.test(body) ? "" : whole))
    .trim();
}
