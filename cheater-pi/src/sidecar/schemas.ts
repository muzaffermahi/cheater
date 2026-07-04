// Strict, defensive parsing of sidecar output. The sidecar is a small model: it may wrap JSON
// in prose, add trailing commentary, or emit malformed JSON. These helpers extract at most one
// bounded JSON object and validate/clamp each field; anything off-shape yields null/undefined so
// the caller falls back deterministically. Nothing here ever throws.

/**
 * Extract the first balanced top-level JSON object from arbitrary model text. String-aware, so a
 * `}` inside a JSON string never closes the object early, and trailing prose after the object is
 * ignored. Bounded by maxChars so a runaway sidecar reply cannot cost real CPU here.
 */
export function extractJsonObject(text: string, maxChars = 8000): Record<string, unknown> | null {
  if (!text) return null;
  const slice = text.length > maxChars ? text.slice(0, maxChars) : text;
  const start = slice.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < slice.length; i += 1) {
    const ch = slice[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(slice.slice(start, i + 1));
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** A trimmed, length-clamped string, or undefined for anything non-string/empty. */
export function clampStr(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen);
}

/** Up to maxItems trimmed strings from an array-ish value; non-arrays yield []. */
export function clampStrList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = clampStr(item, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** A finite number clamped to [min,max], or fallback for anything non-numeric. */
export function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** A boolean from true/false or the strings "true"/"false"/"yes"/"no"; else fallback. */
export function clampBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "yes") return true;
    if (v === "false" || v === "no") return false;
  }
  return fallback;
}
