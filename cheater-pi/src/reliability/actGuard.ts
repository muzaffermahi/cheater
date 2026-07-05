// Answered-without-acting guard (finding #5).
//
// A small/mid model handed an ACTIONABLE task ("write a regex to /app/regex.txt", "create the cert
// files") sometimes emits the answer as CHAT TEXT and calls ZERO tools - so the agent ends with
// nothing written and the task fails, even though the model "knew" the answer. Live-observed:
// qwen3.5-35b answered the regex-log task in chat with 0 tool calls (its ONLY miss across 5 tasks);
// qwen3-8b/qwen3-30b did the same. The empty-turn detector only catches no-text-AND-no-tools (a
// frozen/prefill-stalled model); this catches text-BUT-no-work. On agent end we ask: did the model
// call any tool this session, and does the goal actually demand an action? If it answered an
// actionable task without acting, nudge it ONCE to do the work with its tools.

interface LooseMessage { role?: string; content?: unknown; toolCalls?: unknown[] }

/** True if any assistant message in the transcript issued a tool call. */
export function assistantMadeToolCall(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages as LooseMessage[]) {
    if (m?.role && m.role !== "assistant") continue;
    if (Array.isArray(m?.toolCalls) && m.toolCalls.length) return true;
    if (Array.isArray(m?.content)) {
      for (const c of m.content as Array<{ type?: string }>) {
        if (c?.type === "toolCall" || c?.type === "tool_use" || c?.type === "tool_call") return true;
      }
    }
  }
  return false;
}

/** True if any assistant message produced non-empty text (so this is an ANSWER, not a frozen turn). */
export function assistantProducedText(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages as LooseMessage[]) {
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string" && m.content.trim()) return true;
    if (Array.isArray(m.content)) {
      for (const c of m.content as Array<{ type?: string; text?: string }>) {
        if (c?.type === "text" && (c.text ?? "").trim()) return true;
      }
    }
  }
  return false;
}

/** First user text message in the transcript (the task/goal). */
export function firstUserGoal(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const m of messages as LooseMessage[]) {
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") {
      if (m.content.trim()) return m.content;
      continue;
    }
    if (Array.isArray(m.content)) {
      const text = (m.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c?.type === "text" && c.text)
        .map((c) => c.text)
        .join(" ")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

// A message that OPENS with a question word is a genuine ask, not a task - never nudge it to "act".
const QUESTION_OPENER = /^\s*(what|what's|whats|how|why|where|when|which|who|whose|is|are|was|were|do|does|did|can|could|should|would|will|explain|describe|tell me|show me|summar|give me an overview|walk me through|list|name|identify|count how)\b/i;

// The strongest signal: the task says to WRITE/SAVE output somewhere - a path or a filename.
const FILE_OUTPUT = /\b(write|save|store|output|put|place|dump|export|record|append)\b[\s\S]{0,80}?\b(to|in|into|at|as)\b[\s\S]{0,50}?(\/[\w./-]+|\b[\w-]+\.(txt|json|jsonl|csv|tsv|md|py|js|ts|tsx|jsx|c|cpp|h|hpp|go|rs|java|rb|sh|bash|yaml|yml|toml|ini|conf|cfg|xml|html|css|sql|env|pem|crt|key|log|out|answer)\b|\bfile\b)/i;

// An imperative build/fix/produce verb: an actionable task rather than a question.
const CREATE_ARTIFACT = /\b(create|generate|produce|make|build|scaffold|set up|configure|install|implement|add|fix|repair|compile|extract|convert|migrate|refactor|rename|move|delete|remove|patch|modify|edit|update|solve|complete|download|apply)\b/i;

/**
 * Does the goal ask the model to DO something (produce/modify a file, run commands, complete a task)
 * rather than answer a question? Conservative: a clear question opener disqualifies unless the goal
 * also explicitly names a file to write.
 */
export function goalDemandsAction(goal: string): boolean {
  const g = (goal ?? "").trim();
  if (!g) return false;
  if (FILE_OUTPUT.test(g)) return true; // "save X to /path" wins even over a question opener
  if (QUESTION_OPENER.test(g)) return false;
  return CREATE_ARTIFACT.test(g);
}

/**
 * Should the agent-end handler nudge the model to act? True only when: the feature is enabled, the
 * model produced an answer (text) but called ZERO tools, and the goal demands an action.
 */
export function shouldNudgeToAct(opts: { enabled: boolean; messages: unknown; goal: string }): boolean {
  if (!opts.enabled) return false;
  if (assistantMadeToolCall(opts.messages)) return false;
  if (!assistantProducedText(opts.messages)) return false; // no text + no tools = frozen turn (other detector)
  return goalDemandsAction(opts.goal);
}

export const ANSWERED_WITHOUT_ACTING_NUDGE = [
  "Cheater: you produced an answer but performed NO actions this turn - no file was created or edited and no command was run.",
  "This is a task to COMPLETE with your tools, not a question to answer in chat.",
  "If it asks you to write/save output to a file (e.g. a specific path), CREATE that file now with the write tool. If it needs shell commands, run them with bash. Then verify the result actually exists on disk.",
  "Do NOT just re-post the answer as text - the task is only done when the file/edit/command really exists."
].join("\n");
