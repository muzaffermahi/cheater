// Managed model acquisition for the native desktop app.
// Downloads are resumable, cancellable, and verified before a model becomes visible to the runtime.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
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

/** Download a catalog model into destination, atomically renaming only after hash verification. */
export async function downloadModel(entry: ModelCatalogEntry, destination: string, options: ModelDownloadOptions = {}): Promise<string> {
  validateCatalogEntry(entry);
  const fetchImpl = options.fetchImpl ?? fetch;
  const part = `${destination}.part`;
  await mkdir(dirname(destination), { recursive: true });
  let existing = existsSync(part) ? statSync(part).size : 0;
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
    throw new Error(`model checksum mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}`);
  }
  if (entry.bytes !== undefined && statSync(part).size !== entry.bytes) throw new Error(`model size mismatch for ${entry.id}`);
  if (existsSync(destination)) {
    const current = await hashFile(destination, options.signal);
    if (current.toLowerCase() !== entry.sha256.toLowerCase()) throw new Error(`refusing to replace an existing model at ${destination}`);
    await unlink(part);
  } else {
    await rename(part, destination);
  }
  emit(options, { id: entry.id, destination, receivedBytes: statSync(destination).size, totalBytes: entry.bytes ?? statSync(destination).size, phase: "complete" });
  return destination;
}

export async function discardPartialModel(destination: string): Promise<void> {
  try { await unlink(`${destination}.part`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
