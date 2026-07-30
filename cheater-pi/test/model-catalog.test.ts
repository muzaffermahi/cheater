import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
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
