import test from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDesktopEngine } from "../src/core/desktopEngine.js";
import { command, encodeFrame, FrameDecoder } from "../src/core/desktopProtocol.js";
import type { KittenLLM, ChatParams, ChatResult } from "../src/core/llm.js";

function open(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Every client connection must complete the engine handshake before any command is served. */
async function connect(path: string, token: string): Promise<Socket> {
  const socket = await open(path);
  try {
    const hello = await call(socket, `hello-${Math.random().toString(36).slice(2, 8)}`, "hello", { token });
    assert.equal(hello.authenticated, true);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function call(socket: Socket, id: string, type: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    const onData = (chunk: Buffer): void => {
      try {
        for (const frame of decoder.push(chunk)) {
          if ((frame as { id?: string }).id !== id) continue;
          socket.off("data", onData);
          if ((frame as { ok: boolean }).ok) resolve((frame as { result?: unknown }).result);
          else reject(new Error(JSON.stringify(frame)));
        }
      } catch (e) { reject(e); }
    };
    socket.on("data", onData);
    socket.write(encodeFrame(command(id, type, payload)));
  });
}

function waitForEvent(socket: Socket, type: string, predicate: (frame: any) => boolean = () => true): Promise<any> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    const onData = (chunk: Buffer): void => {
      try {
        for (const frame of decoder.push(chunk)) {
          if ((frame as { type?: string }).type !== type || !predicate(frame)) continue;
          socket.off("data", onData);
          resolve(frame);
          return;
        }
      } catch (error) { socket.off("data", onData); reject(error); }
    };
    socket.on("data", onData);
  });
}

test("desktop engine serves health and conversation commands over local IPC", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-${process.pid}` : `${process.cwd()}/.kitten-test-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd() });
  const socket = await connect(socketPath, engine.token);
  try {
    const health = await call(socket, "1", "health");
    assert.equal(health.ready, true);
    const runtimeEnsure = await call(socket, "runtime-ensure", "runtime.ensure", { projectRoot: process.cwd() });
    assert.equal(runtimeEnsure.configured, false);
    const conversation = await call(socket, "2", "conversation.create", { title: "IPC test" });
    assert.equal(conversation.title, "IPC test");
    const exported = await call(socket, "export", "conversation.export", { id: conversation.id });
    assert.equal(exported.format, "markdown");
    assert.match(exported.content, /# IPC test/);
    const rows = await call(socket, "3", "conversation.list");
    assert.equal(rows.length, 1);
    const searchedRows = await call(socket, "3-search", "conversation.list", { search: "IPC" });
    assert.equal(searchedRows.length, 1);
    const emptySearch = await call(socket, "3-empty-search", "conversation.list", { search: "does-not-exist" });
    assert.equal(emptySearch.length, 0);
    const agents = await call(socket, "4", "agent.list");
    assert.ok(agents.some((agent: { name: string }) => agent.name === "explore"));
    for (const name of ["architect", "security", "debug", "test", "release"]) {
      assert.ok(agents.some((agent: { name: string; model: string; mode: string }) => agent.name === name && agent.model === "sidecar" && agent.mode === "subagent"));
    }
    const agentRoot = await mkdtemp(join(tmpdir(), "kitten-agent-library-"));
    try {
      await mkdir(join(agentRoot, ".kitten", "agents"), { recursive: true });
      await writeFile(join(agentRoot, ".kitten", "agents", "local.md"), "---\nname: local\ndescription: Local project reviewer\nmode: subagent\nmodel: sidecar\npermission: edit=deny,bash=deny,task=deny\n---\nReview locally.\n", "utf8");
      const projectAgents = await call(socket, "project-agents", "agent.list", { projectRoot: agentRoot });
      assert.ok(projectAgents.some((agent: { name: string; source: string }) => agent.name === "local" && agent.source === "project"));
    } finally { await rm(agentRoot, { recursive: true, force: true }); }
    const settings = await call(socket, "5", "settings.inspect");
    assert.equal(typeof settings.models.baseUrl, "string");
    assert.equal(typeof settings.models.main, "string");
    const changes = await call(socket, "changes", "workspace.changes", { root: process.cwd(), maxBytes: 20000, maxFiles: 10 });
    assert.equal(changes.isGit, true);
    assert.equal(typeof changes.root, "string");
    assert.ok(Array.isArray(changes.files));
    assert.equal(typeof changes.diff, "string");
    const launchPlan = await call(socket, "6", "model.launch-plan");
    assert.ok(["cpu", "cuda", "vulkan", "metal", "unknown"].includes(launchPlan.backend));
    assert.ok(["disabled", "cpu", "co-resident", "separate-device", "contended"].includes(launchPlan.sidecarMode));
    await assert.rejects(call(socket, "launch-tier-guard", "model.launch-plan", { mainModel: "tiny-2b", sidecarModel: "sidecar-13b" }), /ENGINE_ERROR/);
    const recommendations = await call(socket, "recommend", "model.recommend");
    assert.ok(Array.isArray(recommendations.recommendations));
    assert.match(recommendations.summary, /Hardware guidance/);
    await assert.rejects(call(socket, "tier-guard", "model.select", { role: "main", model: "tiny-2b" }), /ENGINE_ERROR/);
    await assert.rejects(call(socket, "tier-guard-sidecar", "model.select", { role: "sidecar", model: "sidecar-13b" }), /ENGINE_ERROR/);
    await assert.rejects(call(socket, "tier-guard-large-main", "model.select", { role: "main", model: "main-220b" }), /ENGINE_ERROR/);
    await assert.rejects(call(socket, "tier-guard-create", "conversation.create", { title: "Invalid tier", model: "tiny-2b" }), /ENGINE_ERROR/);
    await assert.rejects(call(socket, "tier-guard-settings-main", "settings.update", { update: { mainModel: "tiny-2b" } }), /ENGINE_ERROR/);
    await assert.rejects(call(socket, "tier-guard-settings-sidecar", "settings.update", { update: { sidecarModel: "sidecar-13b" } }), /ENGINE_ERROR/);
    const catalog = await call(socket, "7", "model.catalog", { raw: JSON.stringify({ entries: [{ id: "fixture-main", name: "Fixture Main", url: "https://models.invalid/main.gguf", sha256: "a".repeat(64), format: "gguf", role: "main" }] }) });
    assert.equal(catalog.entries[0].id, "fixture-main");
    await assert.rejects(call(socket, "download-tier-guard", "model.download", {
      entry: { id: "tiny-2b", name: "Tiny", url: "https://models.invalid/tiny.gguf", sha256: "a".repeat(64), format: "gguf", role: "main" },
      destination: join(tmpdir(), "kitten-invalid-tier.gguf"),
    }), /ENGINE_ERROR/);
    const suggested = await call(socket, "plan-suggest", "task.plan-suggest", { conversationId: conversation.id, text: "understand the settings flow" });
    assert.equal(suggested.nodes.length, 3);
    assert.match(suggested.orientation, /SIDECAR ORIENTATION/);
    assert.ok(suggested.nodes.every((node: { objective: string }) => node.objective.includes("Bounded sidecar orientation")));
    assert.deepEqual(suggested.nodes.map((node: { agent: string }) => node.agent), ["explore", "review", "verify"]);
    assert.ok(suggested.nodes.every((node: { workspaceMode: string }) => node.workspaceMode === "shared-readonly"));
    const securityPlan = await call(socket, "plan-security", "task.plan-suggest", { conversationId: conversation.id, text: "audit authentication and secret handling" });
    assert.deepEqual(securityPlan.nodes.map((node: { agent: string }) => node.agent), ["explore", "security", "verify"]);
    const debugPlan = await call(socket, "plan-debug", "task.plan-suggest", { conversationId: conversation.id, text: "debug the failing regression test" });
    assert.deepEqual(debugPlan.nodes.map((node: { agent: string }) => node.agent), ["explore", "debug", "verify"]);
    for (const [id, text, expected] of [
      ["plan-test", "improve test coverage for the parser", "test"],
      ["plan-release", "check release packaging and rollback", "release"],
      ["plan-architecture", "design the module boundary refactor", "architect"],
      ["plan-docs", "update the API documentation and examples", "docs"],
      ["plan-performance", "benchmark the slow request path", "performance"],
    ] as const) {
      const plan = await call(socket, id, "task.plan-suggest", { conversationId: conversation.id, text });
      assert.equal(plan.nodes[1].agent, expected);
    }
    const editable = await call(socket, "plan-edit-suggest", "task.plan-edit-suggest", { conversationId: conversation.id, text: "desktop engine" });
    assert.equal(editable.nodes.length, 5);
    assert.match(editable.orientation, /SIDECAR ORIENTATION/);
    assert.ok(editable.allowedFiles.length > 0);
    const implementation = editable.nodes.find((node: { agent: string }) => node.agent === "general");
    assert.ok(implementation);
    assert.equal(implementation.workspaceMode, "isolated-worktree");
    assert.deepEqual(implementation.allowedFiles, editable.allowedFiles);
  } finally {
    socket.destroy();
    await engine.close();
  }
});

test("desktop engine exposes a redacted diagnostics bundle for the native app", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-support-${process.pid}` : `${process.cwd()}/.kitten-support-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd(), models: { baseUrl: "fixture://support", main: "main-35b", sidecar: "sidecar-2b" } });
  const socket = await connect(socketPath, engine.token);
  try {
    const bundle = await call(socket, "support", "support.bundle");
    assert.equal(typeof bundle.content, "string");
    assert.match(bundle.content, /=== Kitten Support Bundle ===/);
    assert.match(bundle.content, /Engine: openai-proxy/);
  } finally {
    socket.destroy();
    await engine.close();
  }
});

test("desktop engine hydrates workspace intelligence from the project cache after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-workspace-cache-"));
  const socketA = process.platform === "win32" ? `\\\\.\\pipe\\kitten-cache-a-${process.pid}` : `${root}/engine-a.sock`;
  const socketB = process.platform === "win32" ? `\\\\.\\pipe\\kitten-cache-b-${process.pid}` : `${root}/engine-b.sock`;
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "auth.ts"), "export function authenticate(token: string) { return Boolean(token); }\n", "utf8");
  const first = await startDesktopEngine({ socketPath: socketA, store: ":memory:", projectRoot: root });
  const firstSocket = await connect(socketA, first.token);
  try {
    const indexed = await call(firstSocket, "index", "workspace.index", { root });
    assert.equal(indexed.files, 1);
  } finally { firstSocket.destroy(); await first.close(); }
  const second = await startDesktopEngine({ socketPath: socketB, store: ":memory:", projectRoot: root });
  const secondSocket = await connect(socketB, second.token);
  try {
    const overview = await call(secondSocket, "overview", "workspace.overview", { root });
    assert.equal(overview.files, 1);
    const hits = await call(secondSocket, "search", "workspace.search", { root, query: "authenticate" });
    assert.equal(hits[0].path, "src/auth.ts");
  } finally {
    secondSocket.destroy(); await second.close(); await rm(root, { recursive: true, force: true });
  }
});

test("desktop submissions receive automatic sidecar orientation before the runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-sidecar-orientation-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-sidecar-orientation-${process.pid}` : `${root}/engine.sock`;
  await writeFile(join(root, "parser.ts"), "export function parse(input: string) { return input.trim(); }\n", "utf8");
  let captured = "";
  const engine = await startDesktopEngine({
    socketPath, store: ":memory:", projectRoot: root,
    models: { sidecar: "fixture-sidecar" },
    llm: { sidecar: async () => { throw new Error("fixture offline"); } } as unknown as KittenLLM,
    runner: async (ctx) => { captured = ctx.conversationContext; return { finished: true, verified: true, summary: "fixture", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: ["parser.ts"] }; },
  });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "Orientation" });
    const postflight = waitForEvent(socket, "sidecar.postflight");
    await call(socket, "submit", "conversation.submit", { conversationId: conversation.id, text: "fix the parser" });
    assert.match(captured, /SIDECAR ORIENTATION/);
    assert.match(captured, /parser\.ts/);
    const postflightFrame = await postflight;
    assert.equal(postflightFrame.payload.source, "deterministic");
    assert.ok(Array.isArray(postflightFrame.payload.evidenceWarnings));
    assert.ok(Array.isArray(postflightFrame.payload.recommendedTests));
    assert.ok(Array.isArray(postflightFrame.payload.suggestedCommands));
    assert.ok(["low", "medium", "high"].includes(String(postflightFrame.payload.risk)));
    assert.ok(Array.isArray(postflightFrame.payload.riskReasons));
    assert.ok(Array.isArray(postflightFrame.payload.generatedTestCases));
    const events = await call(socket, "events", "conversation.events", { id: conversation.id });
    assert.ok(events.some((event: { type: string }) => event.type === "sidecar.postflight"));
  } finally { socket.destroy(); await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop uses a configured sidecar on the shared endpoint when no second endpoint is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-shared-sidecar-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-shared-sidecar-${process.pid}` : `${root}/engine.sock`;
  await writeFile(join(root, "parser.ts"), "export function parse(input: string) { return input.trim(); }\n", "utf8");
  const calls: ChatParams[] = [];
  const response = (content: string): ChatResult => ({ content, reasoning: "", toolCalls: [], finishReason: "stop", usage: { prompt: 1, completion: 4, reasoning: 0, total: 5 }, ok: true, elapsedMs: 1 });
  const fixtureLlm = {
    models: { baseUrl: "fixture://shared", main: "fixture-main", sidecar: "fixture-sidecar" },
    chat: async () => response("OK"),
    sidecar: async (params: ChatParams) => {
      calls.push(params);
      const prompt = params.messages.at(-1)?.content ?? "";
      if (prompt.includes("orient_task")) return response('{"value":{"classification":"bug","files":[{"path":"parser.ts","score":1}],"requirements":["fix the parser"]}}');
      return response('{"value":"bounded"}');
    },
  } as unknown as KittenLLM;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root, runner: async () => ({ finished: true, verified: false, summary: "fixture", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [] }), models: { baseUrl: "fixture://shared", main: "fixture-main", sidecar: "fixture-sidecar" }, llm: fixtureLlm });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "Shared sidecar", projectRoot: root });
    const ready = waitForEvent(socket, "sidecar.preflight", (frame) => frame.payload?.phase === "ready");
    await call(socket, "submit", "conversation.submit", { conversationId: conversation.id, text: "fix the parser" });
    const frame = await ready;
    assert.equal(frame.payload.phase, "ready");
    assert.equal(frame.payload.source, "sidecar");
    assert.equal(calls.length, 1);
  } finally { socket.destroy(); await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop verification rejects unsafe commands and persists the receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-verification-ipc-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-verification-${process.pid}` : `${root}/engine.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "Verification" });
    const result = await call(socket, "verify", "workspace.verify", { root, conversationId: conversation.id, runId: "run-verification", commands: ["powershell -Command whoami"] });
    assert.equal(result.passed, false);
    assert.equal(result.results[0].allowed, false);
    const events = await call(socket, "events", "conversation.events", { id: conversation.id });
    const receipt = events.find((event: { type: string }) => event.type === "workspace.verification");
    assert.ok(receipt);
    assert.equal(receipt.passed, false);
  } finally { socket.destroy(); await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop sidecar gives a new conversation a durable title automatically", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-title-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-title-${process.pid}` : `${root}/engine.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root, runner: async () => ({ finished: true, verified: false, summary: "fixture", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [] }) });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "New task" });
    const renamed = waitForEvent(socket, "conversation.renamed");
    await call(socket, "submit", "conversation.submit", { conversationId: conversation.id, text: "fix the parser" });
    const event = await renamed;
    assert.match(event.payload.title, /fix the parser/i);
    const rows = await call(socket, "list", "conversation.list");
    assert.match(rows.find((row: { id: string }) => row.id === conversation.id).title, /fix the parser/i);
  } finally { socket.destroy(); await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop submission cancellation can stop sidecar preflight before a run starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-submit-cancel-"));
  const endpoint = createServer((_request, _response) => {
    // Keep the sidecar request open until the caller cancels it. The fetch signal should close it.
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", () => resolve()));
  const address = endpoint.address();
  if (!address || typeof address === "string") throw new Error("sidecar fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-submit-cancel-${process.pid}` : `${root}/engine.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root, models: { baseUrl, sidecarBaseUrl: baseUrl, main: "fixture-main", sidecar: "fixture-sidecar" } });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "Cancellation", projectRoot: root });
    const started = waitForEvent(socket, "sidecar.preflight");
    const submitted = call(socket, "submit", "conversation.submit", { conversationId: conversation.id, text: "inspect the project" });
    await started;
    assert.equal(await call(socket, "cancel", "conversation.submit.cancel", { conversationId: conversation.id }), true);
    const result = await submitted;
    assert.equal(result.cancelled, true);
    assert.equal(result.phase, "preflight");
    assert.equal((await call(socket, "list", "conversation.events", { id: conversation.id })).some((event: { type: string }) => event.type === "run.started"), false);
  } finally {
    socket.destroy();
    await engine.close();
    endpoint.closeAllConnections?.();
    endpoint.closeIdleConnections?.();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop sidecar compacts long conversation history before the main model", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-sidecar-compact-"));
  const contexts: string[] = [];
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-sidecar-compact-${process.pid}` : `${root}/engine.sock`;
  const engine = await startDesktopEngine({
    socketPath,
    store: ":memory:",
    projectRoot: root,
    runner: async (ctx) => {
      contexts.push(ctx.conversationContext);
      return { finished: true, verified: true, summary: "fixture completed", wallMs: 1, usage: { prompt: 1, completion: 1, reasoning: 0 }, receiptLines: [], filesChanged: [] };
    },
  });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "Long history", projectRoot: root });
    for (let index = 0; index < 8; index++) await call(socket, `seed-${index}`, "conversation.submit", { conversationId: conversation.id, text: `record durable decision ${index}`, autoSidecar: false });
    await call(socket, "final", "conversation.submit", { conversationId: conversation.id, text: "continue from the earlier decisions" });
    assert.ok(contexts.at(-1)?.includes("[SIDECAR COMPACTED HISTORY]"));
  } finally {
    socket.destroy();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop sidecar emits an actionable failure card without changing the failed grade", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-sidecar-failure-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-sidecar-failure-${process.pid}` : `${root}/engine.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root, runner: async () => { throw new Error("TypeError: parser failed at parser.ts:4"); } });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "Failure card", projectRoot: root });
    const failureCard = waitForEvent(socket, "sidecar.failure");
    const run = await call(socket, "submit", "conversation.submit", { conversationId: conversation.id, text: "fix the parser", autoSidecar: false });
    assert.equal(run.status, "failed");
    const frame = await failureCard;
    assert.ok(["sidecar", "deterministic"].includes(frame.payload.source));
    assert.match(frame.payload.signature, /parser|typeerror/i);
    assert.ok(frame.payload.likelyCause);
  } finally {
    socket.destroy();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop engine streams run events and cancellation across clients", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-cancel-${process.pid}` : `${process.cwd()}/.kitten-test-cancel-${process.pid}.sock`;
  const engine = await startDesktopEngine({
    socketPath,
    store: ":memory:",
    projectRoot: process.cwd(),
    runner: async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { finished: false, verified: false, summary: "fixture", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [] };
    },
  });
  const first = await connect(socketPath, engine.token);
  const second = await connect(socketPath, engine.token);
  try {
    const conversation = await call(first, "create", "conversation.create", { title: "Cancellation IPC" });
    const started = waitForEvent(second, "run.started");
    const submission = call(first, "submit", "conversation.submit", { conversationId: conversation.id, text: "keep running until stopped" });
    const event = await started;
    const runId = event.payload.runId;
    assert.equal(await call(second, "cancel", "run.cancel", { runId }), true);
    const run = await submission;
    assert.equal(run.status, "cancelled");
  } finally {
    first.destroy();
    second.destroy();
    await engine.close();
  }
});

test("desktop engine executes a persisted task plan through child conversations", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-plan-${process.pid}` : `${process.cwd()}/.kitten-test-plan-${process.pid}.sock`;
  const prompts: string[] = [];
  const engine = await startDesktopEngine({
    socketPath,
    store: ":memory:",
    projectRoot: process.cwd(),
    runner: async (ctx) => { prompts.push(ctx.task); return { finished: true, verified: true, summary: `done ${ctx.agent ?? "general"}`, wallMs: 1, usage: { prompt: 1, completion: 1, reasoning: 0 }, receiptLines: ["fixture"], filesChanged: [] }; },
  });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "Task plan" });
    await call(socket, "plan", "task.plan", { conversationId: conversation.id, nodes: [
      { id: "explore-1", agent: "explore", objective: "find the entry point", acceptanceCriteria: ["report the path"], dependencies: [], allowedFiles: [], forbiddenFiles: [], modelTier: "sidecar", workspaceMode: "shared-readonly" },
      { id: "review-1", agent: "review", objective: "review the entry point", acceptanceCriteria: ["report risks"], dependencies: ["explore-1"], allowedFiles: [], forbiddenFiles: [], modelTier: "sidecar", workspaceMode: "shared-readonly" },
    ] });
    const rows = await call(socket, "run", "task.run", { conversationId: conversation.id, parentRunId: "plan-run" });
    assert.equal(rows[0].status, "completed");
    assert.match(rows[0].report, /done explore/);
    assert.equal(rows[1].status, "completed");
    assert.match(prompts[1], /Dependency explore-1 report/);
    assert.match(prompts[1], /done explore/);
  } finally {
    socket.destroy();
    await engine.close();
  }
});

test("desktop task plans route sidecar nodes to the configured sidecar model", async () => {
  const seenModels: string[] = [];
  const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\kitten-test-sidecar-tier-" + process.pid : process.cwd() + "/.kitten-test-sidecar-tier-" + process.pid + ".sock";
  const engine = await startDesktopEngine({
    socketPath,
    store: ":memory:",
    projectRoot: process.cwd(),
    models: { main: "fixture-main", sidecar: "fixture-sidecar" },
    runner: async (ctx) => {
      seenModels.push(ctx.model);
      return { finished: true, verified: true, summary: "tier fixture", wallMs: 1, usage: { prompt: 1, completion: 1, reasoning: 0 }, receiptLines: ["fixture"], filesChanged: [] };
    },
  });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "Sidecar tier" });
    await call(socket, "plan", "task.plan", { conversationId: conversation.id, nodes: [{ id: "sidecar-tier", agent: "explore", objective: "inspect", acceptanceCriteria: ["report"], dependencies: [], allowedFiles: [], forbiddenFiles: [], modelTier: "sidecar", workspaceMode: "shared-readonly" }] });
    await call(socket, "run", "task.run", { conversationId: conversation.id, parentRunId: "sidecar-tier-run" });
    assert.deepEqual(seenModels, ["fixture-sidecar"]);
  } finally {
    socket.destroy();
    await engine.close();
  }
});

test("desktop task-plan orientation can be cancelled before the DAG is created", async () => {
  const never = async (params: ChatParams): Promise<ChatResult> => await new Promise<ChatResult>((_resolve, reject) => {
    if (params.signal?.aborted) { reject(new Error("aborted")); return; }
    params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const fixtureLlm = { models: { baseUrl: "fixture://main", sidecarBaseUrl: "fixture://sidecar", main: "main", sidecar: "side" }, chat: never, sidecar: never } as unknown as KittenLLM;
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-plan-cancel-${process.pid}` : `${process.cwd()}/.kitten-test-plan-cancel-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd(), models: { baseUrl: "fixture://main", sidecarBaseUrl: "fixture://sidecar", main: "main", sidecar: "side" }, llm: fixtureLlm });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "Plan cancellation" });
    const pending = call(socket, "plan-cancel", "task.plan-suggest", { conversationId: conversation.id, parentRunId: "plan-cancel-run", text: "inspect the project" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await call(socket, "cancel", "task.cancel", { parentRunId: "plan-cancel-run" }), true);
    await assert.rejects(pending, /cancelled|ENGINE_ERROR/);
  } finally { socket.destroy(); await engine.close(); }
});

test("desktop sidecar toolbox exposes validated clerical jobs with a deterministic floor", async () => {
  const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\kitten-test-sidecar-toolbox-" + process.pid : process.cwd() + "/.kitten-test-sidecar-toolbox-" + process.pid + ".sock";
  const engine = await startDesktopEngine({
    socketPath,
    store: ":memory:",
    projectRoot: process.cwd(),
    models: { baseUrl: "http://127.0.0.1:9/v1", sidecar: "fixture-sidecar" },
  });
  const socket = await connect(socketPath, engine.token);
  try {
    const catalog = await call(socket, "catalog", "sidecar.catalog");
    assert.ok(catalog.length >= 27);
    assert.ok(catalog.includes("rank_files"));
    assert.ok(catalog.includes("explain_error"));
    await assert.rejects(call(socket, "invalid", "sidecar.run", { id: "invalid", type: "not-a-job", text: "x" }), /ENGINE_ERROR/);
    const result = await call(socket, "run", "sidecar.run", {
      id: "toolbox-classify",
      type: "classify_task",
      premise: "classify a user request",
      text: "fix the failing parser test",
    });
    assert.equal(result.ok, false);
    assert.equal(result.source, "deterministic");
    assert.equal(result.value.type, "classify_task");
    assert.equal(result.value.value, "bug");
  } finally {
    socket.destroy();
    await engine.close();
  }
});

test("desktop sidecar workflows run a bounded intake pack and preserve per-step provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-sidecar-workflow-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "parser.ts"), "export function parse(value: string) { return value.trim(); }\n", "utf8");
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-sidecar-workflow-${process.pid}` : `${root}/engine.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root, models: { baseUrl: "http://127.0.0.1:9/v1", sidecar: "fixture-sidecar" } });
  const socket = await connect(socketPath, engine.token);
  try {
    const catalog = await call(socket, "workflow-catalog", "sidecar.workflow.catalog");
    assert.ok(catalog.some((workflow: { id: string }) => workflow.id === "task-intake"));
    const result = await call(socket, "workflow", "sidecar.workflow", { id: "intake-fixture", workflow: "task-intake", root, text: "fix the parser and preserve order", files: ["src/parser.ts"], tests: [] });
    assert.equal(result.workflow, "task-intake");
    assert.equal(result.source, "deterministic");
    assert.equal(result.results.length, 6);
    assert.ok(result.results.every((step: { result: { source: string; value: { type: string } } }) => step.result.source === "deterministic" && typeof step.result.value.type === "string"));
  } finally { socket.destroy(); await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop engine cancels an in-flight model download", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-download-cancel-"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "4" });
    res.write("ab");
    setTimeout(() => res.end("cd"), 2000);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\kitten-test-download-cancel-" + process.pid : process.cwd() + "/.kitten-test-download-cancel-" + process.pid + ".sock";
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root });
  const socket = await connect(socketPath, engine.token);
  try {
    const pending = call(socket, "download", "model.download", {
      id: "cancel-download",
      entry: { id: "cancel-download", name: "Cancel fixture", url: `http://127.0.0.1:${port}/model.gguf`, sha256: "0".repeat(64), format: "gguf", role: "sidecar" },
      destination: join(root, "model.gguf"),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await call(socket, "cancel", "model.download.cancel", { id: "cancel-download" }), true);
    await assert.rejects(pending, /ENGINE_ERROR|abort|cancel/i);
  } finally {
    socket.destroy();
    await engine.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
test("desktop task cancellation stops a running subagent plan", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-task-cancel-${process.pid}` : `${process.cwd()}/.kitten-test-task-cancel-${process.pid}.sock`;
  const engine = await startDesktopEngine({
    socketPath,
    store: ":memory:",
    projectRoot: process.cwd(),
    runner: async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { finished: false, verified: false, summary: "cancelled fixture", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [] };
    },
  });
  const first = await connect(socketPath, engine.token);
  const second = await connect(socketPath, engine.token);
  try {
    const conversation = await call(first, "create", "conversation.create", { title: "Task cancellation" });
    await call(first, "plan", "task.plan", { conversationId: conversation.id, nodes: [{ id: "explore-cancel", agent: "explore", objective: "inspect before cancellation", acceptanceCriteria: ["report"], dependencies: [], allowedFiles: [], forbiddenFiles: [], modelTier: "sidecar", workspaceMode: "shared-readonly" }] });
    const started = waitForEvent(second, "task.started");
    const running = call(first, "run", "task.run", { conversationId: conversation.id, parentRunId: "cancel-plan" });
    await started;
    assert.equal(await call(second, "cancel", "task.cancel", { parentRunId: "cancel-plan" }), true);
    const rows = await running;
    assert.equal(rows[0].status, "cancelled");
  } finally {
    first.destroy();
    second.destroy();
    await engine.close();
  }
});

test("desktop can spawn a durable subagent directly from the native task surface", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-direct-subagent-${process.pid}` : `${process.cwd()}/.kitten-test-direct-subagent-${process.pid}.sock`;
  let childLane = "";
  const engine = await startDesktopEngine({
    socketPath,
    store: ":memory:",
    projectRoot: process.cwd(),
    runner: async (ctx) => { childLane = ctx.lane; return { finished: true, verified: false, summary: "child fixture", wallMs: 1, usage: { prompt: 1, completion: 1, reasoning: 0 }, receiptLines: [], filesChanged: [] }; },
  });
  const socket = await connect(socketPath, engine.token);
  try {
    const parent = await call(socket, "parent", "conversation.create", { title: "Direct subagent" });
    const child = await call(socket, "spawn", "task.spawn", { parentConversationId: parent.id, parentRunId: "manual-child", agent: "architect", prompt: "Map the parser boundaries and report exact paths." });
    assert.equal(child.conversation.parentConversationId, parent.id);
    assert.equal(child.conversation.agent, "architect");
    assert.equal(child.run.summary, "child fixture");
    assert.equal(childLane, "direct");
  } finally { socket.destroy(); await engine.close(); }
});

test("desktop settings update refreshes the active model runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-engine-settings-"));
  await mkdir(join(root, ".kitten"), { recursive: true });
  await writeFile(join(root, ".kitten", "config.json"), JSON.stringify({ mainModel: "project-main", sidecarModel: "project-sidecar" }), "utf8");
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-settings-${process.pid}` : `${process.cwd()}/.kitten-test-settings-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root });
  const socket = await connect(socketPath, engine.token);
  try {
    const projectConversation = await call(socket, "project-conversation", "conversation.create", { title: "Project model", projectRoot: root });
    assert.equal(projectConversation.model, "project-main");
    const projectSettings = await call(socket, "project-settings", "settings.inspect", { projectRoot: root });
    assert.equal(projectSettings.models.main, "project-main");
    assert.equal(projectSettings.models.sidecar, "project-sidecar");
    await call(socket, "update", "settings.update", {
      scope: "project",
      projectRoot: root,
      update: {
        mainModel: "fixture-main",
        sidecarModel: "fixture-sidecar",
        runtimeExecutable: "C:\\models\\llama-server.exe",
        mainModelPath: "C:\\models\\main.gguf",
      },
    });
    const settings = await call(socket, "inspect", "settings.inspect");
    assert.equal(settings.models.main, "fixture-main");
    assert.equal(settings.models.sidecar, "fixture-sidecar");
    assert.equal(settings.managedRuntime.executable, "C:\\models\\llama-server.exe");
    assert.equal(settings.managedRuntime.mainModelPath, "C:\\models\\main.gguf");
  } finally {
    socket.destroy();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop engine starts, probes, and stops a managed local runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-engine-runtime-"));
  const modelPath = join(root, "fixture-main.gguf");
  const sidecarModelPath = join(root, "fixture-sidecar.gguf");
  const bootstrapPath = join(root, "runtime-fixture.cjs");
  await writeFile(modelPath, "fixture model");
  await writeFile(sidecarModelPath, "fixture sidecar");
  await writeFile(bootstrapPath, [
    "const http = require('node:http');",
    "const args = process.argv.slice(2);",
    "const port = Number(args[args.indexOf('--port') + 1]);",
    "const server = http.createServer((req, res) => {",
    "  if (req.url === '/models') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({data:[{id:'fixture-main'}]})); return; }",
    "  res.writeHead(404); res.end();",
    "});",
    "server.listen(port, '127.0.0.1');",
  ].join("\n"));
  const port = 39000 + (process.pid % 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const sidecarBaseUrl = `http://127.0.0.1:${port + 1}`;
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-runtime-${process.pid}` : `${process.cwd()}/.kitten-test-runtime-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root, models: { baseUrl, main: "fixture-main" } });
  const socket = await connect(socketPath, engine.token);
  try {
    const started = await call(socket, "start", "runtime.start", { executable: process.execPath, mainModelPath: modelPath, sidecarModelPath, baseUrl, sidecarBaseUrl, mainModel: "fixture-main-live", sidecarModel: "fixture-sidecar-live", bootstrapScript: bootstrapPath });
    assert.equal(started.started, true);
    assert.equal(started.probe.reachable, true);
    assert.equal(started.sidecarProbe.reachable, true);
    const settings = await call(socket, "settings", "settings.inspect", { projectRoot: root });
    assert.equal(settings.models.baseUrl, baseUrl);
    assert.equal(settings.models.sidecarBaseUrl, sidecarBaseUrl);
    assert.equal(settings.models.main, "fixture-main-live");
    assert.equal(settings.models.sidecar, "fixture-sidecar-live");
    const status = await call(socket, "status", "runtime.status");
    assert.equal(status.running, true);
    assert.equal(status.sidecarRunning, true);
    const stopped = await call(socket, "stop", "runtime.stop");
    assert.equal(stopped.stopped, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const finalStatus = await call(socket, "final-status", "runtime.status");
    assert.equal(finalStatus.running, false);
    assert.equal(finalStatus.sidecarRunning, false);
  } finally {
    socket.destroy();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop engine discovers models for native first-run setup", async () => {
  const endpoint = createServer((request, response) => {
    if (request.url !== "/models") { response.writeHead(404); response.end(); return; }
    const body = JSON.stringify({ data: [{ id: "main-35b" }, { id: "sidecar-2b" }] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", () => resolve()));
  const address = endpoint.address();
  if (!address || typeof address === "string") throw new Error("fixture endpoint did not bind");
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-discovery-${process.pid}` : `${process.cwd()}/.kitten-test-discovery-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd() });
  const socket = await connect(socketPath, engine.token);
  try {
    const result = await call(socket, "discover", "model.discover", { baseUrl: `http://127.0.0.1:${address.port}` });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models.map((model: { id: string }) => model.id), ["main-35b", "sidecar-2b"]);
    const valid = await call(socket, "validate", "model.validate", { baseUrl: `http://127.0.0.1:${address.port}`, model: "main-35b" });
    assert.equal(valid.valid, true);
    assert.equal(valid.verified, true);
    const probed = await call(socket, "validate-probed", "model.validate", { baseUrl: `http://127.0.0.1:${address.port}`, model: "main-35b", probe: true, timeoutMs: 1000 });
    assert.equal(probed.valid, true);
    assert.equal(probed.verified, false);
    assert.match(probed.error, /advertised but not responding/);
    const invalid = await call(socket, "invalid", "model.validate", { baseUrl: `http://127.0.0.1:${address.port}`, model: "missing-model" });
    assert.equal(invalid.valid, false);
  } finally {
    socket.destroy();
    await engine.close();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

test("desktop engine exposes a bounded model responsiveness benchmark", async () => {
  const endpoint = createServer((request, response) => {
    if (request.url !== "/chat/completions") { response.writeHead(404); response.end(); return; }
    const body = JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { completion_tokens: 4 } });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", () => resolve()));
  const address = endpoint.address();
  if (!address || typeof address === "string") throw new Error("fixture endpoint did not bind");
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-benchmark-${process.pid}` : `${process.cwd()}/.kitten-test-benchmark-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd(), models: { baseUrl: `http://127.0.0.1:${address.port}`, main: "main-35b" } });
  const socket = await connect(socketPath, engine.token);
  try {
    const result = await call(socket, "benchmark", "model.benchmark", { samples: 2 });
    assert.equal(result.successfulSamples, 2);
    assert.equal(result.samples.length, 2);
    assert.ok(result.medianLatencyMs >= 0);
    assert.ok(result.medianTokensPerSecond > 0);
    const battery = await call(socket, "battery", "model.benchmark-battery", { samples: 1 });
    assert.equal(battery.rows.length, 2);
    assert.deepEqual(battery.rows.map((row: { role: string }) => row.role), ["main", "sidecar"]);
    assert.match(battery.reportPath, /model-benchmark-.*\.json$/);
  } finally {
    socket.destroy();
    await engine.close();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

test("desktop engine exposes the sandboxed coding-quality probe and persists its receipt", async () => {
  const code = `module.exports = function(value) { return String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }`;
  const endpoint = createServer((request, response) => {
    if (request.url !== "/chat/completions") { response.writeHead(404); response.end(); return; }
    const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ code }) }, finish_reason: "stop" }], usage: { completion_tokens: 20 } });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", () => resolve()));
  const address = endpoint.address();
  if (!address || typeof address === "string") throw new Error("fixture endpoint did not bind");
  const root = await mkdtemp(join(tmpdir(), "kitten-coding-benchmark-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-coding-benchmark-${process.pid}` : `${process.cwd()}/.kitten-test-coding-benchmark-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root, models: { baseUrl: `http://127.0.0.1:${address.port}`, main: "main-35b", sidecar: "sidecar-2b" } });
  const socket = await connect(socketPath, engine.token);
  try {
    const result = await call(socket, "coding", "model.coding-benchmark", { projectRoot: root, timeoutMs: 5_000 });
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].rows.length, 3);
    assert.ok(result.rows[0].passedCases >= 3);
    assert.match(result.reportPath, /coding-benchmark-.*\.json$/);
  } finally {
    socket.destroy();
    await engine.close();
    endpoint.closeAllConnections?.();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop engine exposes the held-out project probe and persists its receipt", async () => {
  const merge = JSON.stringify({ files: [
    { path: "src/index.js", content: `module.exports = { mergeConfig: require("./mergeConfig") };` },
    { path: "src/mergeConfig.js", content: `function plain(value) { return value && typeof value === "object" && !Array.isArray(value); } function mergeConfig(base, override) { const out = {}; for (const key of Object.keys(base || {})) out[key] = plain(base[key]) ? mergeConfig(base[key], {}) : base[key]; for (const key of Object.keys(override || {})) out[key] = plain(override[key]) && plain(out[key]) ? mergeConfig(out[key], override[key]) : override[key]; return out; } module.exports = mergeConfig;` },
  ] });
  const retry = JSON.stringify({ files: [
    { path: "src/index.js", content: `module.exports = { planRetries: require("./retry") };` },
    { path: "src/retry.js", content: `module.exports = function(options) { const o = options || {}; const n = Math.max(0, Math.floor(Number(o.attempts) || 0)); const b = Math.max(0, Math.floor(Number(o.baseMs) || 0)); const m = Math.max(b, Math.floor(Number(o.maxMs) || b)); const out = []; for (let i = 0; i < n; i++) out.push(Math.min(m, b * (2 ** i))); return out; };` },
  ] });
  const fixtureResponse = (content: string): ChatResult => ({ content, reasoning: "", toolCalls: [], finishReason: "stop", usage: { prompt: 1, completion: 20, reasoning: 0, total: 21 }, ok: true, elapsedMs: 1 });
  const fixtureLlm = {
    models: { baseUrl: "fixture://project", main: "main-35b", sidecar: "sidecar-2b" },
    chat: async (params: ChatParams) => fixtureResponse(params.messages.at(-1)?.content.includes("planRetries") ? retry : merge),
    sidecar: async (params: ChatParams) => fixtureResponse(params.messages.at(-1)?.content.includes("planRetries") ? retry : merge),
  } as unknown as KittenLLM;
  const root = await mkdtemp(join(tmpdir(), "kitten-project-benchmark-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-project-benchmark-${process.pid}` : `${process.cwd()}/.kitten-test-project-benchmark-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: root, models: { baseUrl: "fixture://project", main: "main-35b", sidecar: "sidecar-2b" }, llm: fixtureLlm });
  const socket = await connect(socketPath, engine.token);
  try {
    const result = await call(socket, "project", "model.project-benchmark", { projectRoot: root, timeoutMs: 8_000 });
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].passedCases, 6);
    assert.equal(result.rows[1].score, 1);
    assert.match(result.reportPath, /project-benchmark-.*\.json$/);
  } finally {
    socket.destroy();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ── Local IPC trust boundary ─────────────────────────────────────────────────────────────────────
// The engine's socket is reachable by other processes running as this user (and on Windows the
// default named-pipe ACL is wider still). It drives file edits, shell commands and the model
// endpoint, so nothing may be served — including the event stream — before the handshake.

test("engine refuses every command until the handshake token is presented", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-auth-${process.pid}` : `${process.cwd()}/.kitten-test-auth-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd() });
  try {
    const anonymous = await open(socketPath);
    const closed = new Promise<void>((resolve) => anonymous.once("close", () => resolve()));
    await assert.rejects(call(anonymous, "probe", "health"), /EUNAUTHORIZED|handshake required/);
    await closed;
    assert.equal(anonymous.destroyed, true);

    const wrongToken = await open(socketPath);
    const wrongClosed = new Promise<void>((resolve) => wrongToken.once("close", () => resolve()));
    await assert.rejects(call(wrongToken, "hello", "hello", { token: "not-the-token" }), /EUNAUTHORIZED|token is invalid/);
    await wrongClosed;

    const authorized = await connect(socketPath, engine.token);
    try {
      const health = await call(authorized, "health", "health");
      assert.equal(health.ready, true);
    } finally { authorized.destroy(); }
  } finally { await engine.close(); }
});

test("an unauthenticated connection receives no events and is closed on the handshake deadline", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-auth-events-${process.pid}` : `${process.cwd()}/.kitten-test-auth-events-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd(), handshakeTimeoutMs: 400 });
  const eavesdropper = await open(socketPath);
  const overheard: Array<Record<string, unknown>> = [];
  const eavesdropDecoder = new FrameDecoder();
  eavesdropper.on("data", (chunk: Buffer) => {
    for (const parsed of eavesdropDecoder.push(chunk)) overheard.push(parsed as unknown as Record<string, unknown>);
  });
  const closed = new Promise<void>((resolve) => eavesdropper.once("close", () => resolve()));
  const authorized = await connect(socketPath, engine.token);
  try {
    // A real conversation event fans out to authenticated clients only.
    const conversation = await call(authorized, "create", "conversation.create", { title: "Private" });
    await call(authorized, "rename", "conversation.rename", { id: conversation.id, title: "Still private" });
    await closed;
    // The only thing an unauthenticated peer may ever be told is that it is unauthenticated.
    for (const frame of overheard) {
      assert.equal(frame.ok, false, `unauthenticated peer received a payload frame: ${JSON.stringify(frame)}`);
      assert.equal((frame.error as { code?: string } | undefined)?.code, "EUNAUTHORIZED");
      assert.ok(!("eventId" in frame), "unauthenticated peer received an event");
    }
    assert.ok(!JSON.stringify(overheard).includes("Private"), "conversation content leaked before the handshake");
  } finally {
    authorized.destroy();
    eavesdropper.destroy();
    await engine.close();
  }
});

test("engine publishes its socket path and token for the shell, and withdraws them on close", async () => {
  const home = await mkdtemp(join(tmpdir(), "kitten-engine-info-"));
  const infoPath = join(home, "engine.json");
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-info-${process.pid}` : `${home}/engine.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd(), infoPath });
  try {
    const info = JSON.parse(await readFile(infoPath, "utf8")) as { socketPath: string; token: string; pid: number; protocolVersion: number };
    assert.equal(info.socketPath, socketPath);
    assert.equal(info.token, engine.token);
    assert.equal(info.pid, process.pid);
    assert.equal(info.protocolVersion, 1);
    if (process.platform !== "win32") assert.equal((await stat(infoPath)).mode & 0o777, 0o600);
    // The published token is the one that actually opens the channel.
    const socket = await connect(socketPath, info.token);
    socket.destroy();
  } finally {
    await engine.close();
    assert.equal(existsSync(infoPath), false, "a closed engine must not leave a live-looking info file behind");
    await rm(home, { recursive: true, force: true });
  }
});

test("a test/fixture engine stays off the shared engine info file", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-noinfo-${process.pid}` : `${process.cwd()}/.kitten-test-noinfo-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd() });
  try { assert.equal(engine.infoPath, null); } finally { await engine.close(); }
});

test("a losing second engine never rewrites the live engine's run state", async () => {
  const home = await mkdtemp(join(tmpdir(), "kitten-engine-single-"));
  const store = join(home, "kitten.db");
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-single-${process.pid}` : `${home}/engine.sock`;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const engine = await startDesktopEngine({
    socketPath, store, projectRoot: home,
    runner: async () => { await held; return { finished: true, verified: false, summary: "held run", wallMs: 1, usage: { prompt: 0, completion: 0, reasoning: 0 }, receiptLines: [], filesChanged: [] }; },
  });
  const socket = await connect(socketPath, engine.token);
  try {
    const conversation = await call(socket, "create", "conversation.create", { title: "In flight" });
    const submitted = call(socket, "submit", "conversation.submit", { conversationId: conversation.id, text: "hold the run", autoSidecar: false });
    await waitForEvent(socket, "run.started");

    // A second launch loses the socket lock. It must fail without touching the store: recovery may
    // not flip the live instance's in-flight run to `interrupted`.
    await assert.rejects(startDesktopEngine({ socketPath, store, projectRoot: home }));
    const runs = await call(socket, "runs", "conversation.runs", { id: conversation.id });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "running");

    release();
    await submitted;
    const settled = await call(socket, "runs-after", "conversation.runs", { id: conversation.id });
    assert.notEqual(settled[0].status, "interrupted");
  } finally {
    release();
    socket.destroy();
    await engine.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("stopping a sidecar workflow prevents its remaining steps from running", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitten-workflow-cancel-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "parser.ts"), "export function parse(input: string) { return input.trim(); }\n", "utf8");
  await writeFile(join(root, "src", "parser.test.ts"), "import { parse } from '../src/parser';\n", "utf8");
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-workflow-cancel-${process.pid}` : `${root}/engine.sock`;
  let sidecarCalls = 0;
  const engine = await startDesktopEngine({
    socketPath, store: ":memory:", projectRoot: root,
    models: { main: "main-35b", sidecar: "sidecar-2b" },
    llm: { sidecar: async () => { sidecarCalls += 1; return { content: "{}", reasoning: "", toolCalls: [], finishReason: "stop", usage: { prompt: 1, completion: 1, reasoning: 0, total: 2 }, ok: true, elapsedMs: 1 }; } } as unknown as KittenLLM,
  });
  const socket = await connect(socketPath, engine.token);
  try {
    // Both frames are written in order; the workflow registers itself before its first await, so the
    // Stop lands while the workspace index is still warming — the window that used to be ignored.
    const running = call(socket, "workflow", "sidecar.workflow", { id: "cancel-fixture", workflow: "task-intake", root, text: "fix the parser and preserve order" });
    const cancelled = await call(socket, "cancel", "sidecar.cancel", { id: "cancel-fixture" });
    assert.equal(cancelled, true);
    const outcome = await running;
    assert.equal(outcome.cancelled, true);
    assert.ok(outcome.completedSteps < outcome.totalSteps, `expected a short-circuited pack, ran ${outcome.completedSteps}/${outcome.totalSteps}`);
    assert.equal(sidecarCalls, 0, "no workflow step may start after Stop");
  } finally {
    socket.destroy();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful command always carries a result field", async () => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\kitten-test-result-shape-${process.pid}` : `${process.cwd()}/.kitten-test-result-shape-${process.pid}.sock`;
  const engine = await startDesktopEngine({ socketPath, store: ":memory:", projectRoot: process.cwd() });
  const socket = await connect(socketPath, engine.token);
  try {
    // A typed client that requires `result` on an ok frame must not see a success as a failure.
    const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const decoder = new FrameDecoder();
      const onData = (chunk: Buffer): void => {
        try {
          for (const parsed of decoder.push(chunk)) {
            if ((parsed as { id?: string }).id !== "missing") continue;
            socket.off("data", onData);
            resolve(parsed as unknown as Record<string, unknown>);
          }
        } catch (error) { reject(error); }
      };
      socket.on("data", onData);
      socket.write(encodeFrame(command("missing", "conversation.get", { id: "conv-does-not-exist" })));
    });
    assert.equal(frame.ok, true);
    assert.ok("result" in frame, "an ok frame must always include result");
    assert.equal(frame.result, null);
  } finally {
    socket.destroy();
    await engine.close();
  }
});
