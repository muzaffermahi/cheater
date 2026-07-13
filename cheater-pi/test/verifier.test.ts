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

test("self-probe fold: a candidate that crashes on its own probe is execution-INELIGIBLE and loses", async () => {
  const good = ws("good", "def f(x):\n    return x * 2\n");
  const crasher = ws("crash", "def f(x):\n    return x.nope()\n"); // AttributeError on an int → crashes
  const contract = extractAcceptanceContract("implement f");
  const v = new Verifier({
    llm: dummyLlm, task: "double", contract,
    probe: { module: "impl.py", symbol: "f", inputs: [[2], [3], [4]] }
  });
  const res = await v.verify([
    { index: 1, workspace: good, finished: true, summary: "" },
    { index: 2, workspace: crasher, finished: true, summary: "" }
  ]);
  const g = res.slate.find((s) => s.index === 1)!;
  const c = res.slate.find((s) => s.index === 2)!;
  assert.equal(g.probe, "pass");
  assert.equal(g.executionEligible, true, "clean candidate carries a real execution receipt");
  assert.equal(g.weaklyEligible, false, "the probe is a real execution signal, not the weak fallback");
  assert.equal(c.probe, "fail", "crasher's self-probe fails");
  assert.equal(c.executionEligible, false, "a candidate that crashes on its own probe is ineligible");
  assert.equal(res.winner, 1);
  assert.equal(res.winnerHasExecutionReceipt, true, "winner now has a green execution receipt (not weak)");
});

test("a candidate whose module fails to load is NOT folded as a passing probe (honest audit)", async () => {
  // Regression: runFnProbes returns null for a module that won't load, leaving crashes[i]=0, so the fold
  // credited un-loadable code with probe="pass" and marked it strongly execution-eligible.
  const good1 = ws("g1", "def f(x):\n    return x * 2\n");
  const good2 = ws("g2", "def f(x):\n    return x * 2\n");
  const broken = ws("bad", "def f(x):\n    return x *\n"); // syntax error → module never loads
  const contract = extractAcceptanceContract("implement f");
  const v = new Verifier({ llm: dummyLlm, task: "double", contract, probe: { module: "impl.py", symbol: "f", inputs: [[2], [3], [4]] } });
  const res = await v.verify([
    { index: 1, workspace: good1, finished: true, summary: "" },
    { index: 2, workspace: good2, finished: true, summary: "" },
    { index: 3, workspace: broken, finished: true, summary: "" },
  ]);
  const b = res.slate.find((s) => s.index === 3)!;
  assert.notEqual(b.probe, "pass", "an un-loadable module must not be folded as a passing probe");
  assert.notEqual(res.winner, 3, "the broken candidate does not win");
});

test("ground truth: a candidate that fails the prompt's worked examples is INELIGIBLE and loses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ver-gt-"));
  const right = join(dir, "right"); mkdirSync(right); writeFileSync(join(right, "solution.py"), "def f(x):\n    return x * 2\n");
  const wrong = join(dir, "wrong"); mkdirSync(wrong); writeFileSync(join(wrong, "solution.py"), "def f(x):\n    return x + 2\n"); // passes f(2)==4 but not f(3)==6
  const contract = extractAcceptanceContract("implement f");
  const v = new Verifier({
    llm: dummyLlm, task: "double", contract,
    workedExamples: [{ call: "f(2)", expected: "4" }, { call: "f(3)", expected: "6" }], workedModule: "solution.py"
  });
  const res = await v.verify([
    { index: 1, workspace: wrong, finished: true, summary: "" },
    { index: 2, workspace: right, finished: true, summary: "" }
  ]);
  const w = res.slate.find((s) => s.index === 1)!;
  const r = res.slate.find((s) => s.index === 2)!;
  assert.equal(w.groundTruth, "fail");
  assert.equal(w.executionEligible, false, "failing the prompt's own examples ⇒ ineligible");
  assert.equal(r.groundTruth, "pass");
  assert.equal(res.winner, 2, "the ground-truth-correct candidate wins");
  assert.equal(res.winnerHasExecutionReceipt, true);
});

test("a weakly-eligible candidate never outranks a ground-truth-verified one (no false green)", async () => {
  // Regression: with no consensus/ORM, fuse tie-broke on index, so a lower-index candidate that only
  // passed the finish gate (its worked-example module never ran) could WIN and be applied over a
  // verified one — and was even credited with a green execution receipt because SOME OTHER candidate
  // had execution evidence. Both are false greens.
  const dir = mkdtempSync(join(tmpdir(), "ver-weak-"));
  const weak = join(dir, "weak"); mkdirSync(weak);               // index 1: NO solution.py → examples can't run
  writeFileSync(join(weak, "notes.txt"), "wrote to the wrong file\n");
  const strong = join(dir, "strong"); mkdirSync(strong);
  writeFileSync(join(strong, "solution.py"), "def f(x):\n    return x * 2\n"); // index 2: passes the examples
  const contract = extractAcceptanceContract("implement f");
  const v = new Verifier({
    llm: dummyLlm, task: "double", contract,
    workedExamples: [{ call: "f(2)", expected: "4" }, { call: "f(3)", expected: "6" }], workedModule: "solution.py"
  });
  const res = await v.verify([
    { index: 1, workspace: weak, finished: true, summary: "" },
    { index: 2, workspace: strong, finished: true, summary: "" }
  ]);
  assert.equal(res.slate.find((s) => s.index === 1)!.weaklyEligible, true, "the module-less candidate is only weakly eligible");
  assert.equal(res.winner, 2, "the ground-truth-verified candidate wins, not the lower-index weak one");
  assert.equal(res.winnerHasExecutionReceipt, true, "receipt reflects the winner's OWN evidence");
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
