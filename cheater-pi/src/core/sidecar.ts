// Kitten Core — the sidecar clerk. Keep qwen3.5-2b (fast, CPU, parallel to the GPU) BUSY.
//
// Doctrine from the small-model research: a weak model can EXTRACT but cannot REASON; ground the main
// model in execution artifacts, never in another model's opinion. So the sidecar never decides — it
// turns noisy execution output into the tight, structured grounding the main model repairs against.
// It runs on the CPU in parallel with the GPU main model, so its calls are ~free wall-clock. Every
// job has a deterministic fallback, so a slow/absent sidecar never blocks a run.

import type { KittenLLM } from "./llm.js";

export interface FailureCard {
  file?: string;
  test?: string;
  assertion?: string;
  salient: string[];
}

const ERROR_LINE = /(error|failed|failure|assert(ion)?|exception|traceback|cannot|not found|undefined|[A-Za-z]*(Error|Exception))/i;
const FILE_LINE = /(?:File "([^"]+)", line \d+|([\w./-]+\.[A-Za-z]{1,4}):(\d+))/;
const ASSERT_LINE = /(assert\b.*|AssertionError.*|expected.*|.* != .*|.* == .*)/i;

/** Deterministic failure card from raw test/command output. */
export function deterministicCard(raw: string): FailureCard {
  const lines = (raw || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let file: string | undefined, assertion: string | undefined;
  for (const l of lines) {
    if (!file) { const m = l.match(FILE_LINE); if (m) file = (m[1] ?? m[2])?.replace(/\\/g, "/"); }
    if (!assertion) { const m = l.match(ASSERT_LINE); if (m) assertion = m[0].slice(0, 200); }
  }
  const salient = lines.filter((l) => ERROR_LINE.test(l)).slice(-5);
  return { file, assertion, salient: salient.length ? salient : lines.slice(-5) };
}

const CARD_SCHEMA = {
  name: "failure_card",
  schema: {
    type: "object",
    properties: {
      file: { type: "string" },
      test: { type: "string" },
      assertion: { type: "string" },
      salient: { type: "array", items: { type: "string" } }
    },
    required: ["assertion", "salient"]
  }
} as const;

/**
 * Turn raw failing output into a tight card. The sidecar sharpens the extraction (json_schema, clean
 * on qwen-2b); the deterministic scan is the floor. Advisory — this is grounding text, never a verdict.
 */
export async function failureCard(llm: KittenLLM, raw: string): Promise<{ card: FailureCard; source: "sidecar" | "deterministic" }> {
  const det = deterministicCard(raw);
  if (!raw.trim()) return { card: det, source: "deterministic" };
  try {
    const r = await llm.sidecar({
      messages: [{ role: "user", content: `Extract the essence of this failing test/command output into the JSON schema. Copy exact names/paths; salient = up to 5 most informative lines verbatim.\n\n${raw.slice(0, 3000)}` }],
      jsonSchema: CARD_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
      maxTokens: 400,
      timeoutMs: 30000
    });
    if (r.ok && r.content.trim()) {
      const obj = JSON.parse(r.content);
      const card: FailureCard = {
        file: typeof obj.file === "string" && obj.file ? obj.file : det.file,
        test: typeof obj.test === "string" ? obj.test : undefined,
        assertion: typeof obj.assertion === "string" && obj.assertion ? obj.assertion : det.assertion,
        salient: Array.isArray(obj.salient) && obj.salient.length ? obj.salient.map(String).slice(0, 5) : det.salient
      };
      return { card, source: "sidecar" };
    }
  } catch { /* fall through */ }
  return { card: det, source: "deterministic" };
}

/** Render a card as a compact repair-grounding block. */
export function renderCard(card: FailureCard): string {
  const lines = ["Failure (fix exactly this):"];
  if (card.file) lines.push(`- file: ${card.file}`);
  if (card.test) lines.push(`- test: ${card.test}`);
  if (card.assertion) lines.push(`- assertion: ${card.assertion}`);
  if (card.salient.length) { lines.push("- output:"); for (const l of card.salient) lines.push(`    ${l.slice(0, 160)}`); }
  return lines.join("\n");
}
