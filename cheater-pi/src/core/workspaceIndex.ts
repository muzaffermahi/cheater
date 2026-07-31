// Incremental, local-only workspace index. It is intentionally deterministic and useful without an
// embedding model; semantic reranking can be layered on later without changing this contract.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, relative, resolve, join, dirname } from "node:path";

export interface WorkspaceFileRecord {
  path: string;
  bytes: number;
  modifiedAt: number;
  hash: string;
  language: string;
  symbols: string[];
  imports: string[];
  isTest: boolean;
}

export interface WorkspaceSearchHit {
  path: string;
  score: number;
  lines: Array<{ number: number; text: string }>;
  symbols: string[];
}

export interface WorkspaceOverview {
  root: string;
  files: number;
  bytes: number;
  languages: Record<string, number>;
  tests: number;
  indexedAt: number;
}

const IGNORED_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", "target", ".venv", "venv", "__pycache__", ".idea", ".vs"]);
const EXTENSIONS: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
  ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".cs": "csharp", ".cpp": "cpp", ".cc": "cpp", ".c": "c",
  ".h": "c", ".hpp": "cpp", ".rb": "ruby", ".php": "php", ".swift": "swift", ".kt": "kotlin", ".md": "markdown", ".json": "json", ".toml": "toml", ".yaml": "yaml", ".yml": "yaml",
};

function sha256(text: Buffer): string { return createHash("sha256").update(text).digest("hex"); }
function isTestPath(path: string): boolean { return /(^|[\\/])(?:test|tests|spec|__tests__)(?:[\\/]|$)|(?:test|spec)[_.-]/i.test(path); }

export class WorkspaceIndex {
  private readonly records = new Map<string, WorkspaceFileRecord>();
  private indexedAt = 0;
  private root = "";

  constructor(private readonly maxFiles = 50_000, private readonly maxFileBytes = 1_000_000) {}

  async refresh(root: string, opts: { changedPaths?: string[]; signal?: AbortSignal } = {}): Promise<WorkspaceOverview> {
    this.root = resolve(root);
    const candidates = opts.changedPaths?.length ? opts.changedPaths.map((p) => resolve(this.root, p)) : await this.walk(this.root, opts.signal);
    if (!opts.changedPaths?.length) this.records.clear();
    for (const abs of candidates) {
      if (opts.signal?.aborted) throw new Error("workspace indexing cancelled");
      const rel = relative(this.root, abs).replaceAll("\\", "/");
      if (!rel || rel.startsWith("..") || !existsSync(abs)) { this.records.delete(rel); continue; }
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (!st.isFile() || st.size > this.maxFileBytes) continue;
      const old = this.records.get(rel);
      if (old && old.modifiedAt === st.mtimeMs && old.bytes === st.size) continue;
      const content = readFileSync(abs);
      const language = EXTENSIONS[extname(rel).toLowerCase()] ?? "text";
      const text = content.toString("utf8");
      this.records.set(rel, { path: rel, bytes: st.size, modifiedAt: st.mtimeMs, hash: sha256(content), language, symbols: extractSymbols(text, language), imports: extractImports(text, language), isTest: isTestPath(rel) });
    }
    if (this.records.size > this.maxFiles) {
      const keep = [...this.records.values()].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, this.maxFiles);
      this.records.clear(); for (const record of keep) this.records.set(record.path, record);
    }
    this.indexedAt = Date.now();
    return this.overview();
  }

  overview(): WorkspaceOverview {
    const languages: Record<string, number> = {}; let bytes = 0; let tests = 0;
    for (const record of this.records.values()) { bytes += record.bytes; languages[record.language] = (languages[record.language] ?? 0) + 1; if (record.isTest) tests += 1; }
    return { root: this.root, files: this.records.size, bytes, languages, tests, indexedAt: this.indexedAt };
  }

  get(path: string): WorkspaceFileRecord | null { return this.records.get(path.replaceAll("\\", "/")) ?? null; }
  list(): WorkspaceFileRecord[] { return [...this.records.values()]; }

  search(query: string, limit = 20): WorkspaceSearchHit[] {
    const terms = query.toLowerCase().split(/[^a-z0-9_$.-]+/).filter((t) => t.length > 1).slice(0, 12);
    if (!terms.length) return [];
    const hits: WorkspaceSearchHit[] = [];
    for (const record of this.records.values()) {
      const haystack = `${record.path} ${record.symbols.join(" ")} ${record.imports.join(" ")}`.toLowerCase();
      const score = terms.reduce((n, term) => n + (record.path.toLowerCase().includes(term) ? 5 : 0) + (record.symbols.some((s) => s.toLowerCase().includes(term)) ? 3 : 0) + (haystack.includes(term) ? 1 : 0), 0);
      if (!score) continue;
      const lines = this.previewLines(record.path, terms);
      hits.push({ path: record.path, score, lines, symbols: record.symbols.slice(0, 20) });
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.max(1, limit));
  }

  buildContext(query: string, maxChars = 12_000): string {
    const chunks: string[] = [`WORKSPACE: ${this.root}`, `QUERY: ${query}`];
    let used = chunks.join("\n").length;
    for (const hit of this.search(query, 32)) {
      const record = this.get(hit.path); if (!record) continue;
      const text = this.readBounded(record.path, hit.lines.length ? hit.lines[0].number : 1, 80);
      const chunk = `\nFILE ${hit.path} [${record.language}]\nSYMBOLS: ${record.symbols.slice(0, 12).join(", ")}\n${text}`;
      if (used + chunk.length > maxChars) break;
      chunks.push(chunk); used += chunk.length;
    }
    return chunks.join("\n");
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, root: this.root, indexedAt: this.indexedAt, records: this.list() }, null, 2), "utf8");
  }

  load(path: string): boolean {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: number; root?: string; indexedAt?: number; records?: WorkspaceFileRecord[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return false;
      this.root = String(parsed.root ?? ""); this.indexedAt = Number(parsed.indexedAt ?? 0); this.records.clear();
      for (const record of parsed.records) if (record?.path) this.records.set(record.path, record);
      return true;
    } catch { return false; }
  }

  private async walk(root: string, signal?: AbortSignal): Promise<string[]> {
    const files: string[] = []; const stack = [root];
    while (stack.length && files.length < this.maxFiles) {
      if (signal?.aborted) throw new Error("workspace indexing cancelled");
      const dir = stack.pop()!; let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) stack.push(abs); continue; }
        if (entry.isFile() && EXTENSIONS[extname(entry.name).toLowerCase()]) files.push(abs);
      }
    }
    return files;
  }

  private previewLines(path: string, terms: string[]): Array<{ number: number; text: string }> {
    const lines = this.readText(path).split(/\r?\n/); const matches: Array<{ number: number; text: string }> = [];
    for (let i = 0; i < lines.length && matches.length < 8; i++) if (terms.some((t) => lines[i].toLowerCase().includes(t))) matches.push({ number: i + 1, text: lines[i].slice(0, 240) });
    return matches;
  }

  private readBounded(path: string, start: number, count: number): string { return this.readText(path).split(/\r?\n/).slice(Math.max(0, start - 1), start - 1 + count).map((line, i) => `${start + i}: ${line}`).join("\n").slice(0, 5000); }
  private readText(path: string): string { try { return readFileSync(resolve(this.root, path), "utf8"); } catch { return ""; } }
}

function extractSymbols(text: string, language: string): string[] {
  const patterns: Record<string, RegExp> = {
    typescript: /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    javascript: /\b(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    python: /^(?:\s*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm,
    rust: /\b(?:fn|struct|enum|trait|mod|impl)\s+([A-Za-z_]\w*)/g,
    go: /\b(?:func|type)\s+([A-Za-z_]\w*)/g,
    csharp: /\b(?:class|interface|record|struct|enum|void|async\s+Task\b)\s+([A-Za-z_]\w*)/g,
  };
  const re = patterns[language]; if (!re) return [];
  const out: string[] = []; let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && out.length < 200) if (!out.includes(match[1])) out.push(match[1]);
  return out;
}

function extractImports(text: string, language: string): string[] {
  const re = language === "python" ? /^\s*(?:from|import)\s+([^\s;]+)/gm : /^\s*import\s+(?:[^"']+from\s+)?["']([^"']+)["']/gm;
  const out: string[] = []; let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && out.length < 100) if (!out.includes(match[1])) out.push(match[1]);
  return out;
}

