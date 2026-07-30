// Launch the bundled hidden engine and prove that the native IPC contract responds.
// This is intentionally a process-level smoke test: static package scans cannot catch a
// missing transitive import or a runtime that exits before Avalonia can connect.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
const child = spawn(runtime, [engineEntry, "--parent-pid", String(process.pid), "--project-root", projectRoot], {
  cwd: bundle,
  env: { ...process.env, USERNAME: smokeUser },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

const pipeName = process.platform === "win32"
  ? `\\\\.\\pipe\\kitten-engine-${smokeUser}`
  : join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state"), "kitten", "engine.sock");

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

async function connectWithRetry(timeoutMs = 7000) {
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
  const socket = await connectWithRetry();
  socket.write(frame({ protocolVersion: 1, id: "native-smoke-health", type: "health" }));
  const response = await readFrame(socket);
  socket.destroy();
  if (!response?.ok || response?.result?.ready !== true) throw new Error(`engine health response was not ready: ${JSON.stringify(response)}`);
  console.log(`Native engine IPC smoke passed (pid ${response.result.pid}, runtime ${basename(runtime)})`);
} catch (error) {
  const detail = stderr.trim();
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`);
} finally {
  if (!child.killed) child.kill();
}
