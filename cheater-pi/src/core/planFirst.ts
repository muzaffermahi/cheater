// Plan-diversity instead of implementation-diversity.
//
// Ascent's best-of-N runs the WHOLE task k times in isolated workspaces and keeps the winner. On a
// cloud endpoint those k runs are concurrent, so the cost is one run's wall-clock — that is what
// `cloudBurst` was built for. On a local single-slot llama.cpp server `concurrency` is 1, so the k
// runs SERIALIZE: k full implementations, one after another, at whatever the GPU does.
//
// Observed live: a single-file Pac-Man clone on `balanced` (k=2, up to 2 rounds) spent its entire
// 10-minute ceiling producing FOUR complete implementations, none of which finished. 178k prompt
// tokens against 10k completion — almost all of it re-reading context for candidates that were
// thrown away.
//
// The diversity is worth having; paying for it with whole implementations is not. Generating k short
// PLANS costs a few hundred tokens each, picking one costs one more call, and then the expensive part
// — writing the code — happens exactly ONCE. Same "explore several approaches, commit to the best"
// shape, at a fraction of the wall clock.

import type { KittenLLM } from "./llm.js";

export interface CandidatePlan {
  index: number;
  text: string;
  /** The stance that produced it, for receipts. */
  label: string;
}

export interface PlanSelection {
  chosen: CandidatePlan | null;
  /** Every plan considered, so receipts can show what was rejected. */
  considered: CandidatePlan[];
  reason: string;
}

/** Distinct angles of attack. Diversity has to come from the PROMPT here — k samples at one
 *  temperature converge, which is the same reason the implementation batch rotates stances. */
const APPROACHES: readonly string[] = [
  "Favour the most direct, conventional implementation. Prefer boring, well-understood structure.",
  "Identify the part most likely to be got wrong, and design specifically to avoid that failure.",
  "Think about structure first: what are the pieces, and what is the cleanest boundary between them?",
  "Consider the edge cases and failure states first, then design the happy path around them.",
];

const PLAN_TOKENS = 700;

function planPrompt(task: string, approach: string): string {
  return `You are planning — NOT writing code. Read the task and produce a short implementation plan.

${approach}

Answer with at most 8 numbered steps. Each step is one line: what to build, and the one detail that
matters for it. Name the files you will create or change. Do not write code. Do not explain your
reasoning. Do not restate the task.

TASK:
${task}`;
}

/**
 * Generate k short plans for the task, each from a different angle.
 *
 * Sequential on purpose: the caller's runtime is the reason this function exists, and firing k
 * concurrent requests at a single-slot server just queues them while making the failure modes worse.
 * Each plan is small, so k of them is still a small fraction of one implementation.
 */
export async function generatePlans(llm: KittenLLM, task: string, k: number, signal?: AbortSignal): Promise<CandidatePlan[]> {
  const plans: CandidatePlan[] = [];
  for (let i = 0; i < Math.max(1, k); i++) {
    if (signal?.aborted) break;
    const approach = APPROACHES[i % APPROACHES.length];
    try {
      const r = await llm.chat({
        messages: [{ role: "user", content: planPrompt(task, approach) }],
        // A plan is not a place for the model to think at length; the plan IS the thinking.
        maxTokens: PLAN_TOKENS,
        temperature: i === 0 ? 0.2 : 0.7,
        disableThinking: true,
        signal,
      });
      const text = (r.content ?? "").trim();
      if (r.ok && text) plans.push({ index: i + 1, text, label: `plan${i + 1}` });
    } catch { /* a plan that fails to generate is simply not a candidate */ }
  }
  return plans;
}

/** Strip a leading "2" / "Plan 2" / "#2" from a judge's reply and return the 1-based index. */
export function parseChoice(reply: string, max: number): number | null {
  const m = /(?:plan\s*)?#?\s*(\d+)/i.exec((reply ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/**
 * Pick the plan to implement.
 *
 * One plan needs no judge, and a judge that fails must not sink the run — a bad selection costs some
 * quality, while a thrown error costs the whole task. Both degrade to the first plan, which is the
 * baseline (lowest temperature, most conventional approach).
 */
export async function selectPlan(llm: KittenLLM, task: string, plans: CandidatePlan[], signal?: AbortSignal): Promise<PlanSelection> {
  if (!plans.length) return { chosen: null, considered: [], reason: "no plan was generated" };
  if (plans.length === 1) return { chosen: plans[0], considered: plans, reason: "only one plan" };

  const rendered = plans.map((p) => `PLAN ${p.index}:\n${p.text}`).join("\n\n---\n\n");
  try {
    const r = await llm.chat({
      messages: [{
        role: "user",
        content: `A task and ${plans.length} competing plans. Choose the ONE most likely to produce a correct, complete, working result.

Reply with the plan number and nothing else.

TASK:
${task}

${rendered}`,
      }],
      maxTokens: 16,
      temperature: 0,
      disableThinking: true,
      signal,
    });
    const pick = r.ok ? parseChoice(r.content, plans.length) : null;
    if (pick) return { chosen: plans[pick - 1], considered: plans, reason: `judge chose plan ${pick} of ${plans.length}` };
  } catch { /* fall through to the baseline */ }
  return { chosen: plans[0], considered: plans, reason: `judge unavailable — kept the baseline plan of ${plans.length}` };
}

/** Render the winning plan as a directive the implementing agent is held to. */
export function planDirective(plan: CandidatePlan): string {
  return `Follow this implementation plan. It was selected from several competing plans as the most likely to work.

${plan.text}

Implement it completely. If a step turns out to be wrong, fix it and continue — do not restart from a different design.`;
}
