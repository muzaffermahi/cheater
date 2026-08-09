import test from "node:test";
import assert from "node:assert/strict";
import { tierSidecar, type KittenModels } from "../src/core/llm.js";

const base: KittenModels = { baseUrl: "", main: "ornith-1.0-35b", sidecar: "qwen3.5-2b" };

test("tierSidecar is a compatibility no-op on a cloud endpoint", () => {
  const saved = process.env.KITTEN_SIDECAR_MODEL;
  delete process.env.KITTEN_SIDECAR_MODEL;
  const cloud = tierSidecar({ ...base, baseUrl: "https://ws-x.maas.aliyuncs.com/compatible-mode/v1" });
  assert.equal(cloud.sidecar, "qwen3.5-2b", "legacy explicit sidecar settings are preserved but never auto-created");
  if (saved) process.env.KITTEN_SIDECAR_MODEL = saved;
});

test("tierSidecar is a no-op locally (the local 2b IS served)", () => {
  const local = tierSidecar({ ...base, baseUrl: "http://localhost:1234/v1" });
  assert.equal(local.sidecar, "qwen3.5-2b");
  const loopback = tierSidecar({ ...base, baseUrl: "http://127.0.0.1:1234/v1" });
  assert.equal(loopback.sidecar, "qwen3.5-2b");
});

test("tierSidecar respects an explicit KITTEN_SIDECAR_MODEL", () => {
  const saved = process.env.KITTEN_SIDECAR_MODEL;
  process.env.KITTEN_SIDECAR_MODEL = "my-custom-sidecar";
  const r = tierSidecar({ ...base, baseUrl: "https://cloud.example/v1" });
  assert.equal(r.sidecar, "qwen3.5-2b", "explicit sidecar is left as-is (not overridden)");
  if (saved) process.env.KITTEN_SIDECAR_MODEL = saved; else delete process.env.KITTEN_SIDECAR_MODEL;
});
