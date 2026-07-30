// Launch the bundled hidden engine and prove that the native IPC contract responds.
// This is intentionally a process-level smoke test: static package scans cannot catch a
// missing transitive import or a runtime that exits before Avalonia can connect.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { connect } from "node:net";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const bundle = resolve(arg("--bundle", "../artifacts/kitten-desktop-bundle"));
const projectRoot = resolve(arg("--project-root", process.cwd()));
const engineEntry = join(bundle, "engine", "dist", "src", "core", "desktopEngine.js");
const runtime = join(bundle, "engine", "node.exe");
if (!existsSync(engineEntry)) throw new Error(`native engine entry is missing: ${engineEntry}`);
if (!existsSync(runtime)) throw new Error(`bundled Node runtime is missing: ${runtime}`);

const smokeUser = `kitten-smoke-${process.pid}`;
// An isolated Kitten home keeps the smoke run off the user's real store and gives us the engine's
// published socket path + handshake token, which is the only way in: the engine answers nothing,
// health included, before a client presents that token.
const smokeHome = mkdtempSync(join(tmpdir(), "kitten-engine-smoke-"));
const child = spawn(runtime, [engineEntry, "--parent-pid", String(process.pid), "--project-root", projectRoot], {
  cwd: bundle,
  env: { ...process.env, USERNAME: smokeUser, KITTEN_HOME: smokeHome },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

async function readEngineInfo(timeoutMs = 10_000) {
  const infoPath = join(smokeHome, "engine.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = JSON.parse(readFileSync(infoPath, "utf8"));
      if (info?.socketPath && info?.token) return info;
    } catch { /* the engine has not published yet */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error(`native engine did not publish ${infoPath}`);
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

function readFrame(socket) {
  return new Promise((resolveFrame, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (!length || length > 8 * 1024 * 1024) return reject(new Error(`invalid smoke frame length ${length}`));
      if (buffer.length < length + 4) return;
      socket.off("data", onData);
      resolveFrame(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("engine pipe closed before health response")));
  });
}

async function connectWithRetry(pipeName, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      return await new Promise((resolveSocket, rejectSocket) => {
        const socket = connect(pipeName);
        socket.once("connect", () => resolveSocket(socket));
        socket.once("error", (error) => { socket.destroy(); rejectSocket(error); });
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
  }
  throw new Error(`timed out connecting to native engine pipe (${lastError})`);
}

try {
  const info = await readEngineInfo();
  const socket = await connectWithRetry(info.socketPath);

  // An unauthenticated peer must be refused. If this ever succeeds the shipped engine is open to
  // every local process, so the release fails here rather than in the field.
  const intruder = await connectWithRetry(info.socketPath);
  intruder.write(frame({ protocolVersion: 1, id: "native-smoke-intruder", type: "health" }));
  const refused = await readFrame(intruder);
  intruder.destroy();
  if (refused?.ok !== false || refused?.error?.code !== "EUNAUTHORIZED") {
    throw new Error(`engine served an unauthenticated client: ${JSON.stringify(refused)}`);
  }

  socket.write(frame({ protocolVersion: 1, id: "native-smoke-hello", type: "hello", payload: { token: info.token } }));
  const hello = await readFrame(socket);
  if (!hello?.ok || hello?.result?.authenticated !== true) throw new Error(`engine handshake failed: ${JSON.stringify(hello)}`);

  socket.write(frame({ protocolVersion: 1, id: "native-smoke-health", type: "health" }));
  const response = await readFrame(socket);
  socket.destroy();
  if (!response?.ok || response?.result?.ready !== true) throw new Error(`engine health response was not ready: ${JSON.stringify(response)}`);
  console.log(`Native engine IPC smoke passed (pid ${response.result.pid}, runtime ${basename(runtime)}, handshake enforced)`);
} catch (error) {
  const detail = stderr.trim();
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`);
} finally {
  if (!child.killed) child.kill();
  try { rmSync(smokeHome, { recursive: true, force: true }); } catch { /* temp dir */ }
}
