import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A 3B-active model holds roughly one function in working memory. Sending the first 40 lines
// of a file (usually the import block) wastes the densest prompt channel; sending the actual
// function/class whose name overlaps the task terms gives the model the exact material to edit.
// Regex-based (no tree-sitter) so it is a cheap, dependency-free win.

interface Declaration {
  line: number;
  name: string;
  indent: number;
  pythonic: boolean;
}

const DECL_PATTERNS: RegExp[] = [
  /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/,
  /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z0-9_$]+\s*=>)/,
  /^(\s*)(?:def|class)\s+([A-Za-z0-9_]+)/
];

function findDeclarations(lines: string[]): Declaration[] {
  const decls: Declaration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    for (const re of DECL_PATTERNS) {
      const m = raw.match(re);
      if (m) {
        decls.push({ line: i, name: m[2], indent: m[1].length, pythonic: /^\s*(?:def|class)\b/.test(raw) });
        break;
      }
    }
  }
  return decls;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

/** camelCase / snake_case aware token set for a symbol name. */
function nameTokens(name: string): Set<string> {
  const parts = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/);
  return new Set(parts.map((p) => p.toLowerCase()).filter((p) => p.length > 2));
}

function sliceBlock(lines: string[], decl: Declaration, maxLines: number): string[] {
  const start = decl.line;
  if (decl.pythonic) {
    let end = start + 1;
    while (end < lines.length && end - start < maxLines) {
      const line = lines[end];
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (line.trim() && indent <= decl.indent) break;
      end++;
    }
    return lines.slice(start, end);
  }
  // Brace matching for C-family.
  let depth = 0;
  let seenOpen = false;
  let end = start;
  for (; end < lines.length && end - start < maxLines; end++) {
    for (const ch of lines[end]) {
      if (ch === "{") { depth++; seenOpen = true; }
      else if (ch === "}") depth--;
    }
    if (seenOpen && depth <= 0) { end++; break; }
  }
  return lines.slice(start, end);
}

/**
 * Return the source span of the symbol whose name best overlaps `terms`, or null if nothing
 * scores. Bounded by maxLines/maxChars so it fits a small model's working budget.
 */
export function relevantSymbolSlice(content: string, terms: string[], maxLines = 60, maxChars = 1400): string | null {
  if (!content.trim()) return null;
  const lines = content.split(/\r?\n/);
  const termTokens = new Set(terms.flatMap(tokenize));
  if (!termTokens.size) return null;
  const decls = findDeclarations(lines);
  if (!decls.length) return null;

  let best: { decl: Declaration; score: number } | null = null;
  for (const decl of decls) {
    let score = 0;
    for (const t of nameTokens(decl.name)) if (termTokens.has(t)) score++;
    if (score > (best?.score ?? 0)) best = { decl, score };
  }
  if (!best || best.score === 0) return null;

  const block = sliceBlock(lines, best.decl, maxLines).join("\n");
  return block.length > maxChars ? `${block.slice(0, maxChars)}\n// ... [truncated]` : block;
}

/**
 * Read a file and return a labeled snippet: the symbol slice matching `terms` if one is found,
 * otherwise the head of the file. Never throws.
 */
export function symbolSnippet(repoRoot: string, file: string, terms: string[], headChars = 800): string {
  try {
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) return "";
    const content = readFileSync(abs, "utf8");
    const slice = relevantSymbolSlice(content, terms);
    if (slice) return [`--- ${file} (relevant symbol) ---`, slice, `--- end ${file} ---`].join("\n");
    const head = content.split(/\r?\n/).slice(0, 40).join("\n").slice(0, headChars);
    return [`--- ${file} (head) ---`, head, `--- end ${file} ---`].join("\n");
  } catch {
    return "";
  }
}
