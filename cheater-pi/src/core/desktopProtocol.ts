// Native desktop IPC contract. The desktop client never talks to the web server: it connects to
// the engine through a length-prefixed local socket (named pipe on Windows, Unix socket elsewhere).

export const DESKTOP_PROTOCOL_VERSION = 1;

export interface DesktopCommand<T = unknown> {
  protocolVersion: number;
  id: string;
  type: string;
  payload?: T;
  conversationId?: string;
  expectedRevision?: number;
}

export interface DesktopResponse<T = unknown> {
  protocolVersion: number;
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

export interface DesktopEvent<T = unknown> {
  protocolVersion: number;
  eventId: string;
  type: string;
  conversationId?: string;
  runId?: string;
  seq?: number;
  timestamp: number;
  payload: T;
}

export type DesktopFrame = DesktopCommand | DesktopResponse | DesktopEvent;

/** Length-prefixed frames avoid newline escaping and make partial socket reads harmless. */
export function encodeFrame(frame: DesktopFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = 8 * 1024 * 1024) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer): DesktopFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: DesktopFrame[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length <= 0 || length > this.maxFrameBytes) throw new Error(`desktop frame length ${length} is invalid`);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      const parsed = JSON.parse(body) as DesktopFrame;
      if (!parsed || typeof parsed !== "object") throw new Error("desktop frame is not an object");
      frames.push(parsed);
    }
    return frames;
  }
}

export function command<T>(id: string, type: string, payload?: T): DesktopCommand<T> {
  return { protocolVersion: DESKTOP_PROTOCOL_VERSION, id, type, payload };
}

