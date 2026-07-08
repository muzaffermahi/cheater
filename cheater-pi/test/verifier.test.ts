import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Verifier, verifierReceiptLines, type Candidate } from "../src/core/verifier.js";
import { extractAcceptanceContract } from "../src/runstate/contract.js";

function ws(name: string, implBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ver-${name}-`));
  writeFileSync(join(dir, "impl.py"), implBody);
  // The repo's own test: doubling function must satisfy f(2)==4 and f(3)==6.
  writeFileSync(join(dir, "test_impl.py"), "from impl import f\nassert f(2) == 4\nassert f(3) == 6\nprint('ok')\n");
  return dir;
}

const dummyLlm = {} as any;

test("execution signals: base red, fixed candidate green → eligible with a reproduction receipt", async () => {
  const base = ws("base", "def f(x):\n    return x + x + 1\n");     // buggy: f(2)=5 → test fails (red)
  const good = ws("good", "def f(x):\n    return x * 2\n");         // f(2)=4, f(3)=6 → green
  const bad = ws("bad", "def f(x):\n    return x + 1\n");           // still wrong → red
  const contract = extractAcceptanceContract("implement f in impl.py so f doubles its argument");
  const v = new Verifier({ llm: dummyLlm, task: "double f", contract, baseWorkspace: base, testCommand: "python test_impl.py" });
  const candidates: Candidate[] = [
    { index: 1, workspace: good, finished: true, summary: "fixed" },
    { index: 2, workspace: bad, finished: true, summary: "nope" }
  ];
  const res = await v.verify(candidates);
  assert.equal(res.winner, 1, "the candidate that turns the suite green wins");
  const s1 = res.slate.find((s) => s.index === 1)!;
  assert.equal(s1.regression, "pass");
  assert.equal(s1.reproduction, "pass", "base was red, candidate is green → true reproduction");
  assert.equal(s1.executionEligible, true);
  const s2 = res.slate.find((s) => s.index === 2)!;
  assert.equal(s2.executionEligible, false, "a candidate that fails the suite is not eligible");
  assert.equal(res.winnerHasExecutionReceipt, true, "Law 1: winner carries a green execution receipt");
});

test("behavioral smoke gates eligibility when there is no test command", async () => {
  const a = ws("a", "def f(x):\n    return x * 2\n");
  const b = ws("b", "def f(x):\n    return x * 3\n");
  const contract = extractAcceptanceContract("implement f in impl.py");
  const v = new Verifier({
    llm: dummyLlm, task: "double", contract,
    behavioralChecks: ["python -c \"import impl; assert impl.f(2)==4\""]
  });
  const res = await v.verify([
    { index: 1, workspace: a, finished: true, summary: "" },
    { index: 2, workspace: b, finished: true, summary: "" }
  ]);
  assert.equal(res.slate.find((s) => s.index === 1)!.smoke, "pass");
  assert.equal(res.slate.find((s) => s.index === 2)!.smoke, "fail");
  assert.equal(res.winner, 1);
});

test("no execution signal available → weak eligibility from the finish gate (Law 1 flagged)", async () => {
  const a = ws("a", "def f(x):\n    return x\n");
  const contract = extractAcceptanceContract("write a poem"); // no commands/files → no execution signal
  const v = new Verifier({ llm: dummyLlm, task: "poem", contract });
  const res = await v.verify([{ index: 1, workspace: a, finished: true, summary: "" }]);
  const s = res.slate[0];
  assert.equal(s.weaklyEligible, true);
  assert.equal(s.executionEligible, true, "falls back to the finish gate");
  assert.equal(res.winnerHasExecutionReceipt, false, "but it's honestly flagged as NO execution receipt");
});

test("consensus (B2) breaks ties among candidates via execution vote", async () => {
  // Two candidates that both pass a thin check but disagree on other inputs; a third agrees with one.
  const p1 = ws("p1", "def f(x):\n    return x * 2\n");
  const p2 = ws("p2", "def f(x):\n    return x * 2\n");
  const p3 = ws("p3", "def f(x):\n    return x << 1 if x < 100 else 0\n"); // diverges on large x
  const contract = extractAcceptanceContract("implement f");
  const v = new Verifier({
    llm: dummyLlm, task: "double", contract,
    probe: { module: "impl.py", symbol: "f", inputs: [[2], [3], [1000]] }
  });
  const res = await v.verify([
    { index: 1, workspace: p1, finished: true, summary: "" },
    { index: 2, workspace: p2, finished: true, summary: "" },
    { index: 3, workspace: p3, finished: true, summary: "" }
  ]);
  // p3 disagrees on x=1000; the plurality (p1,p2) should rank ahead of it.
  const r3 = res.slate.find((s) => s.index === 3)!;
  assert.ok((r3.consensusRank ?? 0) >= 1, "the diverging candidate ranks below the plurality");
  assert.notEqual(res.winner, 3);
});

test("verifierReceiptLines renders the full audit slate", async () => {
  const a = ws("a", "def f(x):\n    return x*2\n");
  const contract = extractAcceptanceContract("impl f");
  const v = new Verifier({ llm: dummyLlm, task: "t", contract, behavioralChecks: ["python -c \"import impl; assert impl.f(1)==2\""] });
  const res = await v.verify([{ index: 1, workspace: a, finished: true, summary: "" }]);
  const lines = verifierReceiptLines(res);
  assert.match(lines[0], /verifier: winner=attempt 1/);
  assert.ok(lines.some((l) => /#1:/.test(l)));
});
