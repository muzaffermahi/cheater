import test from "node:test";
import assert from "node:assert/strict";
import { FrameDecoder, encodeFrame, DESKTOP_PROTOCOL_VERSION, command } from "../src/core/desktopProtocol.js";

test("desktop frames survive partial reads and multiple frames per chunk", () => {
  const a = encodeFrame(command("1", "health"));
  const b = encodeFrame(command("2", "conversation.list", { includeArchived: true }));
  const decoder = new FrameDecoder();
  const first = decoder.push(Buffer.concat([a.subarray(0, 3), a.subarray(3), b.subarray(0, 7)]));
  assert.equal(first.length, 1);
  assert.equal((first[0] as { id: string }).id, "1");
  const second = decoder.push(b.subarray(7));
  assert.equal(second.length, 1);
  assert.equal(second[0].protocolVersion, DESKTOP_PROTOCOL_VERSION);
  assert.equal((second[0] as { payload: { includeArchived: boolean } }).payload.includeArchived, true);
});

test("desktop decoder rejects oversized frames", () => {
  const decoder = new FrameDecoder(8);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(9, 0);
  assert.throws(() => decoder.push(header), /invalid/);
});
