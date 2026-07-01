import test from "node:test";
import assert from "node:assert/strict";
import { commandHelp, startupCard } from "../src/ui.js";

test("startup card advertises normal workflow instead of manual packet controls", () => {
  const text = startupCard("C:\\repo", "qwen-local").join("\n");

  assert.match(text, /Ask normally/);
  assert.match(text, /\/cheater/);
  assert.match(text, /\/reliability-status/);
  assert.doesNotMatch(text, /\/blueprint-step/);
  assert.doesNotMatch(text, /\/blueprint-debug/);
  assert.doesNotMatch(text, /\/commitlet-next/);
  assert.doesNotMatch(text, /\/commitlet-finalize/);
});

test("command help groups debug-only commands away from normal workflow", () => {
  const help = commandHelp();

  assert.match(help, /Normal workflow/);
  assert.match(help, /Debug-only commands/);
  assert.ok(help.indexOf("Debug-only commands") > help.indexOf("/doctor"));
  assert.match(help, /\/blueprint-step Dispatch the next packet through a fresh worker/);
  assert.match(help, /normal coding requests should go through Autopilot/);
});
