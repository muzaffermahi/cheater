import test from "node:test";
import assert from "node:assert/strict";
import { SidecarOrm, yesProbFromLogprobs, loadOrm } from "../src/core/orm.js";

// A minimal fake LLM exposing just the methods the ORM calls.
function fakeLlm(over: { sidecar?: any; chat?: any } = {}): any {
  return {
    sidecar: over.sidecar ?? (async () => ({ ok: true, content: JSON.stringify({ solved: true, confidence: 0.9 }) })),
    chat: over.chat ?? (async () => ({ ok: false })),
  };
}

test("json-prior ORM: solved+high-confidence → high P(solved); unsolved → low", async () => {
  const solved = new SidecarOrm(fakeLlm({ sidecar: async () => ({ ok: true, content: JSON.stringify({ solved: true, confidence: 0.9 }) }) }));
  assert.ok((await solved.score("diff...", "task")) >= 0.85);
  const unsolved = new SidecarOrm(fakeLlm({ sidecar: async () => ({ ok: true, content: JSON.stringify({ solved: false, confidence: 0.8 }) }) }));
  assert.ok((await unsolved.score("diff...", "task")) <= 0.25);
});

test("ORM returns the no-signal midpoint (0.5) when the model fails", async () => {
  const orm = new SidecarOrm(fakeLlm({ sidecar: async () => ({ ok: false }) }));
  assert.equal(await orm.score("x", "y"), 0.5);
});

test("yesProbFromLogprobs normalises P(YES) from a logprobs payload", () => {
  const raw = { choices: [{ logprobs: { content: [{ token: "YES", logprob: -0.1, top_logprobs: [
    { token: "YES", logprob: -0.1 }, { token: "NO", logprob: -2.3 }
  ] }] } }] };
  const p = yesProbFromLogprobs(raw);
  assert.ok(p !== null && p > 0.8, `expected P(YES) high, got ${p}`);
  assert.equal(yesProbFromLogprobs({ choices: [{}] }), null, "no logprobs → null");
});

test("trained-checkpoint path uses logprobs when an ormModel is configured", async () => {
  let usedModel: string | undefined;
  const chat = async (p: any) => {
    usedModel = p.model;
    return { ok: true, content: "YES", raw: { choices: [{ logprobs: { content: [{ token: "YES", logprob: -0.05, top_logprobs: [
      { token: "YES", logprob: -0.05 }, { token: "NO", logprob: -3.0 }
    ] }] } }] } };
  };
  const orm = new SidecarOrm(fakeLlm({ chat }), { ormModel: "ornith-orm-2b-v1" });
  const p = await orm.score("trajectory", "task");
  assert.equal(usedModel, "ornith-orm-2b-v1", "the trained checkpoint id is used");
  assert.ok(p > 0.9);
  assert.match(orm.kind, /trained:ornith-orm-2b-v1/);
});

test("loadOrm is OFF by default; on with a checkpoint or the explicit untrained prior", () => {
  const llm = fakeLlm();
  assert.equal(loadOrm(llm), null, "default off — B1+B2 carry the verifier");
  assert.ok(loadOrm(llm, { ormModel: "orm-ckpt" }) !== null);
  assert.ok(loadOrm(llm, { enableUntrainedPrior: true }) !== null);
});
