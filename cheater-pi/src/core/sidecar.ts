import { KittenLLM } from "./llm.js";

export interface SidecarJob {
  name: string;
  run(llm: KittenLLM, context: Record<string, unknown>): Promise<{ ok: boolean; result?: string; source: "sidecar" | "deterministic" }>;
}

const queue: Array<{ job: SidecarJob; context: Record<string, unknown>; resolve: (r: { ok: boolean; result?: string; source: "sidecar" | "deterministic" }) => void }> = [];
let running = false;

export async function enqueueSidecar(llm: KittenLLM, job: SidecarJob, context: Record<string, unknown>): Promise<{ ok: boolean; result?: string; source: "sidecar" | "deterministic" }> {
  return new Promise((resolve) => {
    queue.push({ job, context, resolve });
    processNext(llm);
  });
}

async function processNext(llm: KittenLLM): Promise<void> {
  if (running || !queue.length) return;
  running = true;
  const item = queue.shift()!;
  try {
    const result = await item.job.run(llm, item.context);
    item.resolve(result);
  } catch (e) {
    item.resolve({ ok: false, result: (e as Error).message, source: "deterministic" });
  }
  running = false;
  processNext(llm);
}

export const titleJob: SidecarJob = {
  name: "title",
  async run(llm, ctx) {
    const msg = String(ctx.message ?? "");
    if (!msg) return { ok: true, result: "New conversation", source: "deterministic" };
    try {
      const r = await llm.sidecar({ messages: [{ role: "user", content: `Generate a short title (max 6 words) for this coding conversation: "${msg}"` }], maxTokens: 20 });
      if (r.ok && r.content.trim()) return { ok: true, result: r.content.trim().slice(0, 60), source: "sidecar" };
    } catch { /* fall through */ }
    return { ok: true, result: msg.slice(0, 40), source: "deterministic" };
  }
};

export const compactJob: SidecarJob = {
  name: "compact",
  async run(llm, ctx) {
    const turns = String(ctx.turns ?? "");
    if (!turns) return { ok: true, result: "", source: "deterministic" };
    try {
      const r = await llm.sidecar({ messages: [{ role: "user", content: `Summarize these conversation turns into 2-3 sentences, preserving key decisions, file changes, and results:\n\n${turns.slice(0, 4000)}` }], maxTokens: 256 });
      if (r.ok && r.content.trim()) return { ok: true, result: r.content.trim(), source: "sidecar" };
    } catch { /* fall through */ }
    return { ok: true, result: `[${turns.length} chars of conversation]`, source: "deterministic" };
  }
};

export const failureCardJob: SidecarJob = {
  name: "failureCard",
  async run(llm, ctx) {
    const error = String(ctx.error ?? "");
    if (!error) return { ok: true, result: "", source: "deterministic" };
    try {
      const r = await llm.sidecar({ messages: [{ role: "user", content: `Summarize this error in one sentence for a failure card: ${error.slice(0, 500)}` }], maxTokens: 100 });
      if (r.ok && r.content.trim()) return { ok: true, result: r.content.trim(), source: "sidecar" };
    } catch { /* fall through */ }
    return { ok: true, result: error.slice(0, 100), source: "deterministic" };
  }
};

export const triageJob: SidecarJob = {
  name: "triage",
  async run(llm, ctx) {
    const task = String(ctx.task ?? "");
    if (!task) return { ok: true, result: "general", source: "deterministic" };
    try {
      const r = await llm.sidecar({ messages: [{ role: "user", content: `Classify this coding task into one word (bug/feature/refactor/question/other): ${task.slice(0, 500)}` }], maxTokens: 10 });
      if (r.ok && r.content.trim()) return { ok: true, result: r.content.trim().toLowerCase(), source: "sidecar" };
    } catch { /* fall through */ }
    return { ok: true, result: "general", source: "deterministic" };
  }
};

// Legacy backward-compatible exports
export async function failureCard(llm: KittenLLM, raw: string): Promise<{ card: string }> {
  const r = await enqueueSidecar(llm, failureCardJob, { error: raw });
  return { card: r.result ?? raw.slice(0, 200) };
}

export function renderCard(card: string): string {
  return `\n  \u2554\u2557 Failure card \u2554\u2557\n  ${card.replace(/\n/g, "\n  ")}\n  \u255a\u255d\u255a\u255d\n`;
}

export const editRepairJob: SidecarJob = {
  name: "editRepair",
  async run(llm, ctx) {
    const content = String(ctx.content ?? "");
    if (!content) return { ok: true, result: "", source: "deterministic" };
    try {
      const r = await llm.sidecar({ messages: [{ role: "user", content: `Fix this malformed edit to make it valid. Return only the corrected version:\n${content.slice(0, 1000)}` }], maxTokens: 500 });
      if (r.ok && r.content.trim()) return { ok: true, result: r.content.trim(), source: "sidecar" };
    } catch { /* fall through */ }
    return { ok: true, result: "", source: "deterministic" };
  }
};
