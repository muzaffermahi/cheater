import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ConversationStore } from "../src/core/store/conversationStore.js";
import { openSqlite } from "../src/core/store/db.js";

// The compiled canonical bin. These tests spawn it exactly as a packaged install would run it, so they
// guard the entry wiring (ESM imports, arg parsing, KITTEN_HOME → store path) that unit tests can't.
const KITTEN = fileURLToPath(new URL("../src/core/kitten.js", import.meta.url));

function withHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "kitten-cli-"));
  return { home, env: { ...process.env, KITTEN_HOME: home } };
}

function run(env: NodeJS.ProcessEnv, ...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [KITTEN, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { out: err.stdout ?? "", code: err.status ?? 1 };
  }
}

/** Seed a finished conversation directly in the store the CLI will open. */
function seed(home: string): string {
  const store = new ConversationStore(openSqlite(join(home, "kitten.db")));
  store.createConversation({ id: "conv_seed", title: "seeded task", projectRoot: "/proj", projectId: "/proj", model: "ornith", mode: "auto", ts: 1000 });
  store.appendEvent("conv_seed", { type: "user.message", text: "do the seeded thing" }, 1001);
  store.appendEvent("conv_seed", { type: "run.started", runId: "r1", request: "do the seeded thing", lane: "reliable" }, 1002);
  store.appendEvent("conv_seed", { type: "run.completed", runId: "r1", finished: true, lane: "reliable", summary: "seeded done", wallMs: 3, usage: { prompt: 1, completion: 1, reasoning: 0 } }, 1003);
  store.close();
  return "conv_seed";
}

test("kitten help prints usage", () => {
  const { env } = withHome();
  const { out, code } = run(env, "help");
  assert.equal(code, 0);
  assert.match(out, /Usage:/);
  assert.match(out, /kitten run/);
});

test("kitten conversations lists a stored conversation", () => {
  const { home, env } = withHome();
  seed(home);
  const { out, code } = run(env, "conversations");
  assert.equal(code, 0);
  assert.match(out, /conv_seed/);
  assert.match(out, /seeded task/);
});

test("kitten resume <id> --json replays the full persisted conversation", () => {
  const { home, env } = withHome();
  const id = seed(home);
  const { out, code } = run(env, "resume", id, "--json");
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as { conversation: { id: string }; events: { type: string }[]; runs: { status: string }[] };
  assert.equal(parsed.conversation.id, id);
  assert.deepEqual(parsed.events.map((e) => e.type), ["conversation.created", "user.message", "run.started", "run.completed"]);
  assert.equal(parsed.runs[0].status, "completed");
});

test("kitten doctor reports node + store health", () => {
  const { env } = withHome();
  const { out } = run(env, "doctor");
  assert.match(out, /Node/);
  assert.match(out, /store at/);
});

test("kitten resume with an unknown id fails cleanly", () => {
  const { env } = withHome();
  const { code } = run(env, "resume", "conv_nope");
  assert.equal(code, 1);
});
