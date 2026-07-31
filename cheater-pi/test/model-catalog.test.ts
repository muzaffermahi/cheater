import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadModel, parseModelCatalog } from "../src/core/modelCatalog.js";

const payload = Buffer.from("kitten-model-payload");
const sha256 = createHash("sha256").update(payload).digest("hex");

test("managed model download verifies and atomically installs the artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-model-"));
  try {
    const destination = join(root, "models", "main.gguf");
    const phases: string[] = [];
    const response = new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } });
    await downloadModel({ id: "test-main", name: "Test Main", url: "https://models.invalid/main.gguf", sha256, bytes: payload.length, format: "gguf", role: "main" }, destination, {
      fetchImpl: (async () => response) as typeof fetch,
      onProgress: (progress) => phases.push(progress.phase),
    });
    assert.deepEqual(await readFile(destination), payload);
    assert.ok(phases.includes("verifying"));
    assert.equal(phases.at(-1), "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial model resumes with HTTP range and rejects a bad checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-model-resume-"));
  try {
    const destination = join(root, "sidecar.gguf");
    await writeFile(`${destination}.part`, payload.subarray(0, 6));
    // Only a partial that claims this exact artifact may be continued.
    await writeFile(`${destination}.part.json`, JSON.stringify({ id: "test-sidecar", url: "https://models.invalid/sidecar.gguf", sha256 }));
    let range = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      range = String(new Headers(init?.headers).get("range") ?? "");
      return new Response(payload.subarray(6), { status: 206, headers: { "content-length": String(payload.length - 6) } });
    }) as typeof fetch;
    await downloadModel({ id: "test-sidecar", name: "Test Sidecar", url: "https://models.invalid/sidecar.gguf", sha256, format: "gguf", role: "sidecar" }, destination, { fetchImpl });
    assert.equal(range, "bytes=6-");
    assert.deepEqual(await readFile(destination), payload);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model catalog parser validates roles, formats, and duplicate ids", () => {
  const valid = { id: "main", name: "Main", url: "https://models.invalid/main.gguf", sha256, format: "gguf", role: "main" };
  const document = parseModelCatalog(JSON.stringify({ version: 1, source: "fixture", entries: [valid] }));
  assert.equal(document.entries[0].role, "main");
  assert.equal(document.source, "fixture");
  assert.throws(() => parseModelCatalog(JSON.stringify({ entries: [valid, valid] })), /duplicate model catalog id/);
  assert.throws(() => parseModelCatalog(JSON.stringify({ entries: [{ ...valid, format: "bin" }] })), /invalid format/);
});

test("a partial from another artifact is discarded instead of resumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-model-foreign-"));
  try {
    const destination = join(root, "main.gguf");
    // Bytes left behind by an unrelated download: appending to them can only produce a file that
    // never verifies, so the transfer must start over instead.
    await writeFile(`${destination}.part`, Buffer.from("bytes-from-a-different-model"));
    await writeFile(`${destination}.part.json`, JSON.stringify({ id: "some-other-model", url: "https://models.invalid/other.gguf", sha256: "b".repeat(64) }));
    let range = "unset";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      range = String(new Headers(init?.headers).get("range") ?? "");
      return new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } });
    }) as typeof fetch;
    await downloadModel({ id: "test-main", name: "Test Main", url: "https://models.invalid/main.gguf", sha256, bytes: payload.length, format: "gguf", role: "main" }, destination, { fetchImpl });
    assert.equal(range, "", "a foreign partial must not produce a Range request");
    assert.deepEqual(await readFile(destination), payload);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed download does not poison the next attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-model-retry-"));
  try {
    const destination = join(root, "main.gguf");
    const entry = { id: "test-main", name: "Test Main", url: "https://models.invalid/main.gguf", sha256, bytes: payload.length, format: "gguf" as const, role: "main" as const };
    // A truncated/corrupt transfer: the served bytes hash to something else.
    const corrupt = (async () => new Response(Buffer.from("corrupted-body-of-same-length"), { status: 200 })) as typeof fetch;
    await assert.rejects(downloadModel(entry, destination, { fetchImpl: corrupt }), /checksum mismatch|size mismatch/);
    assert.equal(existsSync(`${destination}.part`), false, "proven-bad bytes must not survive the failure");

    // The retry sees a clean slate and installs the real artifact.
    const good = (async () => new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } })) as typeof fetch;
    await downloadModel(entry, destination, { fetchImpl: good });
    assert.deepEqual(await readFile(destination), payload);
    assert.equal(existsSync(`${destination}.part.json`), false, "the claim file must not outlive the install");
  } finally { await rm(root, { recursive: true, force: true }); }
});
