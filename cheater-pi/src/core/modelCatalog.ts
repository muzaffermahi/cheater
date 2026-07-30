// Managed model acquisition for the native desktop app.
// Downloads are resumable, cancellable, and verified before a model becomes visible to the runtime.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, open } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";

export interface ModelCatalogEntry {
  id: string;
  name: string;
  url: string;
  sha256: string;
  bytes?: number;
  format: "gguf" | "safetensors";
  role: "main" | "sidecar";
  license?: string;
}

export interface ModelCatalogDocument {
  version: 1;
  source?: string;
  entries: ModelCatalogEntry[];
}

export interface ModelDownloadProgress {
  id: string;
  destination: string;
  receivedBytes: number;
  totalBytes?: number;
  phase: "resuming" | "downloading" | "verifying" | "complete";
}

export interface ModelDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ModelDownloadProgress) => void;
  fetchImpl?: typeof fetch;
}

export function validateCatalogEntry(entry: ModelCatalogEntry): void {
  if (!entry.id || !entry.name || !/^https?:\/\//i.test(entry.url)) throw new Error("invalid model catalog entry");
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error(`invalid sha256 for model ${entry.id}`);
  if (entry.format !== "gguf" && entry.format !== "safetensors") throw new Error(`invalid format for model ${entry.id}`);
  if (entry.role !== "main" && entry.role !== "sidecar") throw new Error(`invalid role for model ${entry.id}`);
  if (!Number.isInteger(entry.bytes) || (entry.bytes ?? 1) <= 0) {
    // Size is optional because some registries expose it only after a HEAD request.
    if (entry.bytes !== undefined) throw new Error(`invalid byte size for model ${entry.id}`);
  }
}

/** Parse a local/embedded catalog document and reject malformed or duplicate entries. */
export function parseModelCatalog(raw: string): ModelCatalogDocument {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`model catalog is not valid JSON: ${(error as Error).message}`); }
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const entriesValue = Array.isArray(value) ? value : object?.entries;
  if (!Array.isArray(entriesValue)) throw new Error("model catalog must be an array or an object with an entries array");
  const entries: ModelCatalogEntry[] = [];
  const ids = new Set<string>();
  for (const candidate of entriesValue) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("model catalog entries must be objects");
    const rawEntry = candidate as Record<string, unknown>;
    const entry = {
      id: String(rawEntry.id ?? ""),
      name: String(rawEntry.name ?? ""),
      url: String(rawEntry.url ?? ""),
      sha256: String(rawEntry.sha256 ?? ""),
      ...(rawEntry.bytes === undefined ? {} : { bytes: Number(rawEntry.bytes) }),
      format: rawEntry.format,
      role: rawEntry.role,
      ...(rawEntry.license === undefined ? {} : { license: String(rawEntry.license) }),
    } as ModelCatalogEntry;
    validateCatalogEntry(entry);
    if (ids.has(entry.id)) throw new Error(`duplicate model catalog id: ${entry.id}`);
    ids.add(entry.id);
    entries.push(entry);
  }
  return { version: 1, ...(typeof object?.source === "string" ? { source: object.source } : {}), entries };
}

function emit(options: ModelDownloadOptions, progress: ModelDownloadProgress): void {
  options.onProgress?.(progress);
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const read = await handle.read(buffer, 0, buffer.byteLength, null);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/**
 * A partial download is only resumable if we know which artifact produced those bytes. The claim
 * file is written before the first byte lands, so a crashed or cancelled download can be continued,
 * while a partial from another model — or from an entry whose URL/hash has since changed — is
 * discarded instead of being appended to. Appending to foreign bytes produced a file that could
 * never verify, and because the partial survived the failure, every later retry resumed from it and
 * failed again: a download that broke once stayed broken.
 */
interface PartialClaim {
  id: string;
  url: string;
  sha256: string;
}

function claimPath(destination: string): string {
  return `${destination}.part.json`;
}

function readClaim(destination: string): PartialClaim | null {
  try {
    const value = JSON.parse(readFileSync(claimPath(destination), "utf8")) as Partial<PartialClaim>;
    if (typeof value.id !== "string" || typeof value.url !== "string" || typeof value.sha256 !== "string") return null;
    return { id: value.id, url: value.url, sha256: value.sha256 };
  } catch { return null; }
}

async function discardPartial(destination: string): Promise<void> {
  for (const path of [`${destination}.part`, claimPath(destination)]) {
    try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Download a catalog model into destination, atomically renaming only after hash verification. */
export async function downloadModel(entry: ModelCatalogEntry, destination: string, options: ModelDownloadOptions = {}): Promise<string> {
  validateCatalogEntry(entry);
  const fetchImpl = options.fetchImpl ?? fetch;
  const part = `${destination}.part`;
  await mkdir(dirname(destination), { recursive: true });
  let existing = existsSync(part) ? statSync(part).size : 0;
  if (existing > 0) {
    const claim = readClaim(destination);
    const sameArtifact = claim?.id === entry.id && claim?.url === entry.url && claim?.sha256.toLowerCase() === entry.sha256.toLowerCase();
    const plausibleSize = entry.bytes === undefined || existing < entry.bytes;
    if (!sameArtifact || !plausibleSize) {
      await discardPartial(destination);
      existing = 0;
    }
  }
  writeFileSync(claimPath(destination), JSON.stringify({ id: entry.id, url: entry.url, sha256: entry.sha256 } satisfies PartialClaim), { mode: 0o600 });
  const headers: Record<string, string> = {};
  if (existing > 0) headers.Range = `bytes=${existing}-`;
  emit(options, { id: entry.id, destination, receivedBytes: existing, totalBytes: entry.bytes, phase: existing ? "resuming" : "downloading" });
  const response = await fetchImpl(entry.url, { headers, signal: options.signal });
  if (!response.ok) throw new Error(`model download failed: HTTP ${response.status}`);
  const resumed = existing > 0 && response.status === 206;
  if (!resumed) existing = 0;
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const totalBytes = entry.bytes ?? (contentLength ? (resumed ? existing + contentLength : contentLength) : undefined);
  if (!response.body) throw new Error("model download returned an empty body");
  const stream = createWriteStream(part, { flags: resumed ? "a" : "w" });
  let received = existing;
  const reader = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  reader.on("data", (chunk: Buffer | string) => {
    received += Buffer.byteLength(chunk);
    emit(options, { id: entry.id, destination, receivedBytes: received, totalBytes, phase: "downloading" });
  });
  reader.on("error", (error) => stream.destroy(error as Error));
  reader.pipe(stream);
  await Promise.race([
    once(stream, "finish"),
    once(stream, "error").then(([error]) => { throw error; }),
  ]);
  if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  emit(options, { id: entry.id, destination, receivedBytes: received, totalBytes, phase: "verifying" });
  const actual = await hashFile(part, options.signal);
  if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
    // These bytes are proven wrong. Keeping them would make every retry resume from a file that can
    // never verify, so the partial goes and the next attempt starts clean.
    await discardPartial(destination);
    throw new Error(`model checksum mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}. The partial download was discarded; retrying starts a fresh transfer.`);
  }
  if (entry.bytes !== undefined && statSync(part).size !== entry.bytes) {
    await discardPartial(destination);
    throw new Error(`model size mismatch for ${entry.id}. The partial download was discarded; retrying starts a fresh transfer.`);
  }
  if (existsSync(destination)) {
    const current = await hashFile(destination, options.signal);
    if (current.toLowerCase() !== entry.sha256.toLowerCase()) throw new Error(`refusing to replace an existing model at ${destination}`);
    await discardPartial(destination);
  } else {
    await rename(part, destination);
    try { await unlink(claimPath(destination)); } catch { /* the claim is an optimization, not state */ }
  }
  emit(options, { id: entry.id, destination, receivedBytes: statSync(destination).size, totalBytes: entry.bytes ?? statSync(destination).size, phase: "complete" });
  return destination;
}

export async function discardPartialModel(destination: string): Promise<void> {
  await discardPartial(destination);
}
