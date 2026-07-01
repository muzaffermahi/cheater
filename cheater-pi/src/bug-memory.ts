import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHARD_COUNT = 64;
const MAX_TERMS_PER_DOC = 180;
const SEARCH_CANDIDATE_LIMIT = 200;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "are", "was", "were",
  "has", "have", "had", "not", "but", "you", "your", "its", "their", "can", "cannot", "could", "should", "would",
  "will", "use", "uses", "using", "used", "return", "returns", "returned", "error", "bug", "fix", "issue", "test",
  "file", "line", "code", "value", "values", "none", "true", "false"
]);

export interface BugMemoryCard {
  id: string;
  repo: string;
  language: string;
  bug_type: string;
  symptom: string;
  root_cause: string;
  fix_pattern: string;
  failed_approaches: string[];
  key_files: string[];
  search_keywords: string[];
  test_signal: string;
  embedding_text: string;
  quality_score?: number;
  quality_tier?: string;
  workflow_steps?: string[];
  do_not_do?: string[];
}

interface DocMeta extends BugMemoryCard {
  docId: number;
  summaryText: string;
}

interface IndexMetadata {
  version: 1;
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  docCount: number;
  shardCount: number;
  createdAt: string;
}

export interface BugMemorySearchOptions {
  cwd: string;
  query: string;
  topK?: number;
  memoryPath?: string;
  rebuild?: boolean;
}

export interface BugMemorySearchHit {
  rank: number;
  score: number;
  id: string;
  repo: string;
  language: string;
  bugType: string;
  symptom: string;
  rootCause: string;
  fixPattern: string;
  keyFiles: string[];
  searchKeywords: string[];
  testSignal: string;
  qualityScore?: number;
  qualityTier?: string;
  workflowSteps?: string[];
  doNotDo?: string[];
  failedApproaches?: string[];
}

export interface BugMemorySearchResult {
  query: string;
  memoryPath: string;
  indexDir: string;
  built: boolean;
  docCount: number;
  hits: BugMemorySearchHit[];
}

function packageRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageDir = basename(here) === "src" && basename(dirname(here)) === "dist"
    ? resolve(here, "..", "..")
    : basename(here) === "src"
      ? resolve(here, "..")
      : resolve(here, "..");
  return dirname(packageDir);
}

export function resolveBugMemoryPath(cwd: string, explicit?: string): string | undefined {
  const envPath = process.env.CHEATER_BUG_MEMORY_PATH;
  const candidates = [
    explicit,
    envPath,
    join(cwd, ".cheater", "bug_memories.jsonl"),
    join(cwd, "data", "cards", "compacted.jsonl"),
    join(packageRepoRoot(), "data", "cards", "compacted.jsonl")
  ].filter((item): item is string => !!item);
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) return resolved;
  }
  return undefined;
}

export function indexRoot(cwd: string, memoryPath: string): string {
  const sig = createHash("sha1").update(resolve(memoryPath).toLowerCase()).digest("hex").slice(0, 12);
  const resolvedMemory = resolve(memoryPath);
  const packageRoot = packageRepoRoot();
  const cacheRoot = resolvedMemory.startsWith(resolve(packageRoot, "data", "cards"))
    ? packageRoot
    : cwd;
  return join(cacheRoot, ".cheater", "cache", "bug-memory-index", sig);
}

export function tokenize(value: string): string[] {
  const raw = value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .match(/[a-z0-9_./:-]+/g) ?? [];
  const terms: string[] = [];
  for (const token of raw) {
    const cleaned = token.replace(/^[-_.:/]+|[-_.:/]+$/g, "");
    if (cleaned.length < 3 || STOPWORDS.has(cleaned)) continue;
    terms.push(cleaned);
    for (const part of cleaned.split(/[_.:/-]+/)) {
      if (part.length >= 3 && !STOPWORDS.has(part)) terms.push(part);
    }
  }
  return terms;
}

function weightedTerms(card: BugMemoryCard): Map<string, number> {
  const weights: Array<[string | string[] | undefined, number]> = [
    [card.bug_type, 4],
    [card.symptom, 3],
    [card.root_cause, 2],
    [card.fix_pattern, 2],
    [card.failed_approaches, 2],
    [card.key_files, 4],
    [card.search_keywords, 6],
    [card.test_signal, 5],
    [card.embedding_text, 2],
    [card.repo, 1],
    [card.language, 1]
  ];
  const counts = new Map<string, number>();
  for (const [value, weight] of weights) {
    const text = Array.isArray(value) ? value.join(" ") : value ?? "";
    for (const term of tokenize(text)) {
      counts.set(term, (counts.get(term) ?? 0) + weight);
    }
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS_PER_DOC));
}

function shardForTerm(term: string): number {
  let hash = 2166136261;
  for (let i = 0; i < term.length; i++) {
    hash ^= term.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % SHARD_COUNT;
}

function normalizeCard(value: unknown): BugMemoryCard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const card = value as Record<string, unknown>;
  const id = str(card.id);
  if (!id) return undefined;
  return {
    id,
    repo: str(card.repo) || "(unknown)",
    language: str(card.language) || "(unknown)",
    bug_type: str(card.bug_type),
    symptom: str(card.symptom),
    root_cause: str(card.root_cause),
    fix_pattern: str(card.fix_pattern),
    failed_approaches: strList(card.failed_approaches),
    key_files: strList(card.key_files),
    search_keywords: strList(card.search_keywords),
    test_signal: str(card.test_signal),
    embedding_text: str(card.embedding_text),
    quality_score: typeof card.quality_score === "number" ? card.quality_score : undefined,
    quality_tier: str(card.quality_tier) || undefined,
    workflow_steps: strList(card.workflow_steps),
    do_not_do: strList(card.do_not_do)
  };
}

function docSummary(card: BugMemoryCard): string {
  return [
    card.bug_type,
    card.symptom,
    card.root_cause,
    card.fix_pattern,
    card.key_files.join(" "),
    card.search_keywords.join(" "),
    card.test_signal,
    card.workflow_steps?.join(" "),
    card.do_not_do?.join(" "),
    card.embedding_text
  ].join("\n");
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function readMetadata(dir: string): IndexMetadata | undefined {
  const path = join(dir, "metadata.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as IndexMetadata;
  } catch {
    return undefined;
  }
}

function isIndexFresh(dir: string, memoryPath: string): boolean {
  const meta = readMetadata(dir);
  if (!meta) return false;
  const stat = statSync(memoryPath);
  return meta.sourcePath === memoryPath && meta.sourceSize === stat.size && meta.sourceMtimeMs === stat.mtimeMs && meta.shardCount === SHARD_COUNT;
}

export async function ensureBugMemoryIndex(cwd: string, memoryPath: string, rebuild = false): Promise<{ indexDir: string; built: boolean; metadata: IndexMetadata }> {
  const dir = indexRoot(cwd, memoryPath);
  if (!rebuild && isIndexFresh(dir, memoryPath)) {
    const metadata = readMetadata(dir);
    if (metadata) return { indexDir: dir, built: false, metadata };
  }
  await buildBugMemoryIndex(memoryPath, dir);
  const metadata = readMetadata(dir);
  if (!metadata) throw new Error(`Bug memory index build failed: ${dir}`);
  return { indexDir: dir, built: true, metadata };
}

export async function buildBugMemoryIndex(memoryPath: string, dir: string): Promise<void> {
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "shards"), { recursive: true });
  const docsPath = join(tmp, "docs.jsonl");
  const offsetsPath = join(tmp, "doc-offsets.json");
  const docs = createWriteStream(docsPath, { encoding: "utf8" });
  const shards = Array.from({ length: SHARD_COUNT }, (_, i) =>
    createWriteStream(join(tmp, "shards", `${i.toString().padStart(2, "0")}.tsv`), { encoding: "utf8" })
  );

  const offsets: number[] = [];
  let docOffset = 0;
  let docCount = 0;

  const rl = createInterface({ input: createReadStream(memoryPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const card = normalizeCard(parsed);
    if (!card) continue;
    const meta: DocMeta = { ...card, docId: docCount, summaryText: docSummary(card) };
    const docLine = `${JSON.stringify(meta)}\n`;
    offsets.push(docOffset);
    docs.write(docLine);
    docOffset += Buffer.byteLength(docLine, "utf8");

    for (const [term, tf] of weightedTerms(card)) {
      shards[shardForTerm(term)].write(`${term}\t${docCount}\t${tf}\n`);
    }
    docCount++;
  }

  await Promise.all([
    new Promise<void>((resolveFinish) => docs.end(resolveFinish)),
    ...shards.map((stream) => new Promise<void>((resolveFinish) => stream.end(resolveFinish)))
  ]);

  writeFileSync(offsetsPath, JSON.stringify(offsets), "utf8");
  const stat = statSync(memoryPath);
  const metadata: IndexMetadata = {
    version: 1,
    sourcePath: memoryPath,
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    docCount,
    shardCount: SHARD_COUNT,
    createdAt: new Date().toISOString()
  };
  writeFileSync(join(tmp, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  renameSync(tmp, dir);
}

export async function searchBugMemories(options: BugMemorySearchOptions): Promise<BugMemorySearchResult> {
  const topK = Math.max(1, Math.min(options.topK ?? 5, 10));
  const memoryPath = resolveBugMemoryPath(options.cwd, options.memoryPath);
  if (!memoryPath) {
    return { query: options.query, memoryPath: "", indexDir: "", built: false, docCount: 0, hits: [] };
  }
  const { indexDir: dir, built, metadata } = await ensureBugMemoryIndex(options.cwd, memoryPath, options.rebuild);
  const queryTerms = Array.from(new Set(tokenize(options.query))).slice(0, 24);
  if (queryTerms.length === 0) {
    return { query: options.query, memoryPath, indexDir: dir, built, docCount: metadata.docCount, hits: [] };
  }

  const wantedByShard = new Map<number, Set<string>>();
  for (const term of queryTerms) {
    const shard = shardForTerm(term);
    const set = wantedByShard.get(shard) ?? new Set<string>();
    set.add(term);
    wantedByShard.set(shard, set);
  }

  const postingsByTerm = new Map<string, Array<[number, number]>>();
  for (const [shard, wanted] of wantedByShard) {
    const shardPath = join(dir, "shards", `${shard.toString().padStart(2, "0")}.tsv`);
    if (!existsSync(shardPath)) continue;
    const rl = createInterface({ input: createReadStream(shardPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const [term, docRaw, tfRaw] = line.split("\t");
      if (!wanted.has(term)) continue;
      const doc = Number(docRaw);
      const tf = Number(tfRaw);
      if (!Number.isFinite(doc) || !Number.isFinite(tf)) continue;
      const postings = postingsByTerm.get(term) ?? [];
      postings.push([doc, tf]);
      postingsByTerm.set(term, postings);
    }
  }

  const scores = new Map<number, number>();
  for (const [term, postings] of postingsByTerm) {
    const idf = Math.log(1 + metadata.docCount / Math.max(1, postings.length));
    const exactErrorBoost = /error|exception|traceback|typeerror|valueerror|attributeerror|importerror/.test(term) ? 1.25 : 1;
    for (const [doc, tf] of postings) {
      scores.set(doc, (scores.get(doc) ?? 0) + Math.log1p(tf) * idf * exactErrorBoost);
    }
  }

  const candidates = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEARCH_CANDIDATE_LIMIT);
  const docs = readDocs(dir, candidates.map(([doc]) => doc));
  const reranked = candidates
    .map(([doc, score]) => ({ doc, score: score + rerankBonus(docs.get(doc), options.query, queryTerms), meta: docs.get(doc) }))
    .filter((item): item is { doc: number; score: number; meta: DocMeta } => !!item.meta)
    .sort((a, b) => b.score - a.score);

  const hits: BugMemorySearchHit[] = [];
  const seen = new Set<string>();
  for (const item of reranked) {
    const keys = [
      canonicalMemoryId(item.meta.id),
      `${item.meta.repo.toLowerCase()}|${normalizeBugType(item.meta.bug_type)}|${item.meta.key_files[0] ?? ""}`
    ];
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    hits.push({
      rank: hits.length + 1,
      score: Number(item.score.toFixed(3)),
      id: item.meta.id,
      repo: item.meta.repo,
      language: item.meta.language,
      bugType: item.meta.bug_type,
      symptom: item.meta.symptom,
      rootCause: item.meta.root_cause,
      fixPattern: item.meta.fix_pattern,
      keyFiles: item.meta.key_files,
      searchKeywords: item.meta.search_keywords,
      testSignal: item.meta.test_signal,
      qualityScore: item.meta.quality_score,
      qualityTier: item.meta.quality_tier,
      workflowSteps: item.meta.workflow_steps,
      doNotDo: item.meta.do_not_do,
      failedApproaches: item.meta.failed_approaches
    });
    if (hits.length >= topK) break;
  }
  return { query: options.query, memoryPath, indexDir: dir, built, docCount: metadata.docCount, hits };
}

function canonicalMemoryId(id: string): string {
  return id.replace(/__row\d+$/i, "");
}

function normalizeBugType(value: string): string {
  return tokenize(value).slice(0, 6).join(" ");
}

function rerankBonus(meta: DocMeta | undefined, query: string, queryTerms: string[]): number {
  if (!meta) return 0;
  const q = query.toLowerCase();
  const text = meta.summaryText.toLowerCase();
  let bonus = 0;
  if (q.length >= 12 && text.includes(q)) bonus += 8;
  for (const quoted of q.match(/`([^`]+)`|"([^"]+)"/g) ?? []) {
    const phrase = quoted.replace(/[`"]/g, "").toLowerCase();
    if (phrase.length >= 4 && text.includes(phrase)) bonus += 5;
  }
  const keywordSet = new Set(meta.search_keywords.flatMap((kw) => tokenize(kw)));
  bonus += queryTerms.filter((term) => keywordSet.has(term)).length * 2;
  if (meta.quality_tier === "high") bonus += 0.5;
  return bonus;
}

function readDocs(dir: string, docIds: number[]): Map<number, DocMeta> {
  const unique = Array.from(new Set(docIds));
  const offsets = JSON.parse(readFileSync(join(dir, "doc-offsets.json"), "utf8")) as number[];
  const fd = openSync(join(dir, "docs.jsonl"), "r");
  const docs = new Map<number, DocMeta>();
  try {
    for (const docId of unique) {
      const offset = offsets[docId];
      if (offset === undefined) continue;
      const chunks: Buffer[] = [];
      const buffer = Buffer.allocUnsafe(4096);
      let position = offset;
      let done = false;
      while (!done) {
        const bytes = readSync(fd, buffer, 0, buffer.length, position);
        if (bytes <= 0) break;
        const slice = buffer.subarray(0, bytes);
        const newline = slice.indexOf(10);
        if (newline >= 0) {
          chunks.push(Buffer.from(slice.subarray(0, newline)));
          done = true;
        } else {
          chunks.push(Buffer.from(slice));
          position += bytes;
        }
      }
      const line = Buffer.concat(chunks).toString("utf8");
      if (!line) continue;
      docs.set(docId, JSON.parse(line) as DocMeta);
    }
  } finally {
    closeSync(fd);
  }
  return docs;
}

export function formatBugMemoryHits(result: BugMemorySearchResult): string {
  if (!result.memoryPath) return "No compacted bug-memory corpus found. Set CHEATER_BUG_MEMORY_PATH or place data/cards/compacted.jsonl in the Cheater repo.";
  if (result.hits.length === 0) return `No compacted bug memories matched: ${result.query}`;
  const header = [
    `Compacted bug memories: ${result.hits.length} hit(s) from ${result.docCount} cards`,
    `corpus: ${result.memoryPath}`,
    result.built ? "index: built now" : "index: ready"
  ];
  const body = result.hits.map((hit) => [
    `#${hit.rank} score=${hit.score} ${hit.id}`,
    `repo: ${hit.repo} (${hit.language})`,
    `bug: ${hit.bugType}`,
    `symptom: ${hit.symptom}`,
    `root cause: ${hit.rootCause}`,
    `fix pattern: ${hit.fixPattern}`,
    hit.workflowSteps?.length ? `workflow: ${hit.workflowSteps.join(" -> ")}` : "",
    hit.doNotDo?.length ? `do not: ${hit.doNotDo.join("; ")}` : "",
    hit.keyFiles.length ? `key files: ${hit.keyFiles.join(", ")}` : "",
    hit.testSignal ? `test signal: ${hit.testSignal}` : ""
  ].filter(Boolean).join("\n"));
  return [...header, "", ...body].join("\n\n");
}
