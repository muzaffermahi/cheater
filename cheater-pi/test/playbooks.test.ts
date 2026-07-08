import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAYBOOKS, playbookFor, classifyByKeyword, primeFromPlaybook,
  verificationHintsFromPlaybook, lintPlaybooks
} from "../src/core/playbooks.js";
import { defaultRegistry, EvalRegistry } from "../src/core/disjointness.js";

test("classifyByKeyword routes representative tasks to the right family", () => {
  assert.equal(classifyByKeyword("implement a metacircular evaluator for a scheme dialect (tokenize, parse, eval)"), "interpreter-vm");
  assert.equal(classifyByKeyword("crack the 7z password by brute forcing the sha256 hash"), "crypto-hash");
  assert.equal(classifyByKeyword("stand up a flask server on port 8080 with a /health endpoint"), "server-healthcheck");
  assert.equal(classifyByKeyword("build the cython extension and import it"), "native-extension");
  assert.equal(classifyByKeyword("recover the lost commit from the git reflog"), "git-surgery");
  assert.equal(classifyByKeyword("parse the csv and emit json with sorted keys"), "data-format");
  assert.equal(classifyByKeyword("make the failing pytest suite pass"), "fix-test-suite");
  assert.equal(classifyByKeyword("write a poem about the sea"), "general", "no cues => general");
});

test("playbookFor returns the family playbook, unknown => general", () => {
  assert.equal(playbookFor("crypto-hash").family, "crypto-hash");
  assert.equal(playbookFor("nonsense" as any).family, "general");
  assert.equal(PLAYBOOKS.length, 10);
});

test("primeFromPlaybook injects the procedure; verification hints come through", () => {
  const pb = playbookFor("native-extension");
  const prime = primeFromPlaybook(pb);
  assert.match(prime, /Playbook for this kind of task/);
  assert.match(prime, /import the module in a fresh process/i);
  const v = verificationHintsFromPlaybook(pb);
  assert.ok(v.length >= 1 && /import/i.test(v.join(" ")));
});

test("LAW 5: no playbook contains an eval task-id or a task-specific path (lint is clean)", () => {
  const violations = lintPlaybooks(defaultRegistry());
  assert.deepEqual(violations, [], `playbooks must be general, not per-task; violations: ${violations.join("; ")}`);
});

test("lintPlaybooks actually CATCHES a leak (guard is not vacuous)", () => {
  // A registry whose eval-id set includes a word that appears in a playbook cue ("compile").
  const reg = new EvalRegistry();
  reg.register("planted", ["compile"]);
  const violations = lintPlaybooks(reg);
  assert.ok(violations.length >= 1, "a cue that collides with an eval id must be flagged");
});

test("every family has a nonempty procedure and verification", () => {
  for (const pb of PLAYBOOKS) {
    assert.ok(pb.procedure.length >= 1, `${pb.family} procedure`);
    assert.ok(pb.verification.length >= 1, `${pb.family} verification`);
  }
});
