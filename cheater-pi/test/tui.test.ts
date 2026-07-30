import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const KITTEN = fileURLToPath(new URL("../src/core/kitten.js", import.meta.url));

// Drive the bare `kitten` command (the TUI) with piped stdin (non-TTY → no approval hangs). This guards
// the TUI entry wiring, mascot render, slash-command dispatch, and clean shutdown end to end.
function runTui(input: string): string {
  const home = mkdtempSync(join(tmpdir(), "kitten-tui-"));
  const env = { ...process.env, KITTEN_HOME: home, KITTEN_BASE_URL: "http://127.0.0.1:9/v1", KITTEN_MAIN_MODEL: "ornith" };
  try {
    return execFileSync(process.execPath, [KITTEN], { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 30000 });
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}

test("TUI renders the header + mascot and handles slash commands", () => {
  const out = runTui("/help\n/exit\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /Kitten/);
  assert.match(out, /reliable local-first coding agent/);
  assert.match(out, /Commands:/);         // /help dispatched
  assert.match(out, /type a task or \/help/); // no conversation created at startup
});

test("TUI routes a question to the answer lane without a model", () => {
  const out = runTui("what does the router do?\n/exit\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /you ›/);
  assert.match(out, /answer/); // route.selected shows the answer lane
});

test("TUI /conversations lists the persisted session", () => {
  const out = runTui("/conversations\n/exit\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /no conversations yet/);
});
