// Kitten Core — canonical serialization and prompt epochs. NO Pi.
//
// llama.cpp reuses a KV prefix only when the PROMPT BYTES are identical. That makes byte-stability a
// correctness concern here, not a style preference: a map iterated in insertion order, a Windows path
// separator, a CRLF, or a regenerated summary silently destroys prefix reuse and the user pays a full
// prefill on a 20 tok/s model. So everything that can enter a prompt is serialized through ONE
// canonical form (sorted keys, LF newlines, `/` paths, omitted empties) and the stable prefix is
// identified by an EPOCH.
//
// A prompt epoch is the identity of the immutable prefix: template + system prompt + tool bundle +
// repo capsule + project policy. Any change to those mints a NEW epoch. Volatile material (the current
// task, execution state) is always appended AFTER the epoch boundary, never spliced into it — llama.cpp
// has no API to edit mid-prefix KV, so late-volatile is the only layout that can reuse anything.
//
// Two prompts are cache-compatible only when their epoch ids match. This module never claims otherwise.

import { createHash } from "node:crypto";

/** Normalize text so trivial editor differences cannot mint a new epoch: LF newlines, no trailing
 *  whitespace per line, no trailing blank lines. */
export function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");
}

/** One canonical path representation inside prompts. The product is Windows-native, but a prompt that
 *  says `src\core\app.ts` on one machine and `src/core/app.ts` on another is two different prefixes. */
export function normalizePathForPrompt(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Deterministic JSON: object keys sorted, `undefined` members omitted (never rendered as null),
 * arrays order-preserving (order is data), strings newline-normalized. Two structurally equal values
 * always produce identical bytes regardless of construction order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? normalizeText(value) : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

/** Stable short digest of any value's canonical form. */
export function canonicalHash(value: unknown, length = 16): string {
  return createHash("sha256").update(typeof value === "string" ? normalizeText(value) : canonicalJson(value)).digest("hex").slice(0, length);
}

/** The exact stable inputs that determine whether two prompts can share a warm prefix. */
export interface PromptEpochInputs {
  /** Chat-template identity (model family + template revision). */
  templateVersion: string;
  /** The rendered system prompt bytes. */
  systemPrompt: string;
  /** Tool names IN THE ORDER they are advertised. Order is part of the bytes. */
  toolNames: readonly string[];
  /** The durable repository capsule (conventions, stack, layout) — not the volatile git status. */
  repoCapsule: string;
  /** Durable project policy/convention text. */
  projectPolicy?: string;
}

export interface PromptEpoch {
  /** The epoch identity. Equal ids ⇒ byte-identical stable prefix. */
  id: string;
  templateHash: string;
  systemHash: string;
  toolBundleHash: string;
  repoCapsuleHash: string;
  /** Hash over every stable input at once — the value `id` is derived from. */
  canonicalBytesHash: string;
}

/** Compute the epoch for a stable prefix. Pure: same inputs ⇒ same epoch, across processes and runs. */
export function promptEpoch(inputs: PromptEpochInputs): PromptEpoch {
  const templateHash = canonicalHash(inputs.templateVersion);
  const systemHash = canonicalHash(inputs.systemPrompt);
  // Tool ORDER is deliberately preserved (not sorted): re-ordering the bundle changes the bytes the
  // model sees, so pretending it does not would make two incompatible prefixes claim the same epoch.
  const toolBundleHash = canonicalHash(inputs.toolNames.join("\n"));
  const repoCapsuleHash = canonicalHash(inputs.repoCapsule);
  const canonicalBytesHash = canonicalHash({
    templateHash, systemHash, toolBundleHash, repoCapsuleHash,
    policyHash: canonicalHash(inputs.projectPolicy ?? ""),
  });
  return { id: `epoch_${canonicalBytesHash}`, templateHash, systemHash, toolBundleHash, repoCapsuleHash, canonicalBytesHash };
}

/** Are these two prompts allowed to claim a shared warm prefix? Only identical epochs qualify. */
export function sameEpoch(a: PromptEpoch | null | undefined, b: PromptEpoch | null | undefined): boolean {
  return Boolean(a && b && a.id === b.id);
}
