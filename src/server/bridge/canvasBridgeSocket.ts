import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

/**
 * Neo N17: a dependency-free RFC6455 server for the canvas bridge.
 *
 * The bridge's live channel is a WebSocket: an external agent session (OpenCode /
 * Claude Code / Orca) holds one socket per canvas and receives node changes as they
 * are written, the same way the browser canvas holds its SSE stream. Loam is a
 * local single-process app, so the transport only needs the small subset of
 * RFC6455 that a text-protocol peer uses: text frames, ping/pong, close, and
 * fragmented text. No permessage-deflate, no binary payloads, no proxies.
 *
 * Everything here is written defensively: a malformed frame is a socket that gets
 * closed, never a crash of the Loam server.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 1_048_576;
const MAX_MESSAGE_BYTES = 4_194_304;

const enum Op {
  Continuation = 0x0,
  Text = 0x1,
  Binary = 0x2,
  Close = 0x8,
  Ping = 0x9,
  Pong = 0xa,
}

/** A live bridge socket. `send` is safe to call from anywhere. */
export class BridgeSocket {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOp: Op | undefined;
  private closed = false;

  private readonly socket: import("node:net").Socket;

  constructor(socket: import("node:net").Socket, private readonly onMessage: (text: string) => void) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("error", () => this.destroy());
    socket.on("close", () => this.destroy());
  }

  get alive(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  /** Raw bytes in, frames out. Handles partial and coalesced frames. */
  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_MESSAGE_BYTES) return this.close(1009, "message too large");
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      this.handle(frame.opcode, frame.payload);
    }
  }

  /** Parse one frame; returns undefined when more bytes are needed. */
  private readFrame(): { opcode: Op; payload: Buffer } | undefined {
    const buf = this.buffer;
    if (buf.length < 2) return undefined;
    const fin = (buf[0]! & 0x80) !== 0;
    const opcode = buf[0]! & 0x0f;
    const masked = (buf[1]! & 0x80) !== 0;
    let length = buf[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return undefined;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return undefined;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME_BYTES)) {
        this.close(1009, "frame too large");
        return undefined;
      }
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_FRAME_BYTES) {
      this.close(1009, "frame too large");
      return undefined;
    }
    const maskLength = masked ? 4 : 0;
    if (buf.length < offset + maskLength + length) return undefined;
    const mask = masked ? Buffer.from(buf.subarray(offset, offset + 4)) as Buffer<ArrayBuffer> : undefined;
    const raw = Buffer.from(buf.subarray(offset + maskLength, offset + maskLength + length));
    if (mask) for (let i = 0; i < raw.length; i++) raw[i]! ^= mask[i % 4]!;
    this.buffer = Buffer.from(buf.subarray(offset + maskLength + length));
    if (!fin) {
      // A fragmented frame: keep the opcode and accumulate until the final piece.
      if (opcode !== Op.Continuation) this.fragmentOp = opcode;
      this.fragments.push(raw);
      return this.readFrame();
    }
    const payload = this.fragments.length > 0 ? Buffer.concat([...this.fragments, raw]) : raw;
    this.fragments = [];
    const finalOp = this.fragmentOp ?? opcode;
    this.fragmentOp = undefined;
    return { opcode: finalOp, payload };
  }

  private handle(opcode: Op, payload: Buffer): void {
    switch (opcode) {
      case Op.Text:
        this.onMessage(payload.toString("utf8"));
        return;
      case Op.Binary:
        // The protocol is text-only; a binary frame is a protocol error.
        this.close(1003, "binary frames are not supported");
        return;
      case Op.Ping:
        this.write(Op.Pong, payload);
        return;
      case Op.Pong:
        return;
      case Op.Close:
        this.close(1000, "peer closed");
        return;
      default:
        this.close(1002, "unknown opcode");
    }
  }

  /** Encode and write one unmasked frame. */
  write(opcode: Op, payload: Buffer): boolean {
    if (!this.alive) return false;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      this.destroy();
      return false;
    }
  }

  /** Send one JSON envelope; silently drops when the peer is gone. */
  send(payload: unknown): boolean {
    return this.write(Op.Text, Buffer.from(JSON.stringify(payload), "utf8"));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + reason.length);
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, "utf8");
    this.write(Op.Close, payload);
    this.destroy();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.fragments = [];
    this.buffer = Buffer.alloc(0);
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

/** Compute the `Sec-WebSocket-Accept` value for a handshake. */
export function acceptKey(key: string): string {
  return crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/**
 * Answer a WebSocket upgrade request. Returns true when this module took the
 * upgrade, so `startServer` stops looking.
 *
 * The install token is required, exactly like every `/api` route: it arrives as the
 * `x-loam-local-token` header (Electron-style) or `?token=` (a browser-less agent
 * cannot set headers on an upgrade).
 */
export function handleBridgeUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  options: {
    /** Validate the token; returns false when the upgrade must be refused. */
    authenticate: (req: IncomingMessage) => boolean;
    /** Decide which canvas this socket belongs to; false when the path is not ours. */
    resolve: (req: IncomingMessage) => { canvasId: string; onSocket: (ws: BridgeSocket) => () => void } | undefined;
  },
): boolean {
  if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() !== "websocket") return false;
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (!path.startsWith("/api/bridge/canvas/")) return false;
  if (!options.authenticate(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return true;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.length === 0) {
    socket.write("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return true;
  }
  const target = options.resolve(req);
  if (!target) {
    socket.write("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return true;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "upgrade: websocket\r\n" +
      "connection: Upgrade\r\n" +
      `sec-websocket-accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setTimeout?.(0);
  socket.setNoDelay?.(true);
  if (head.length > 0) socket.unshift(head);
  const ws = new BridgeSocket(socket, () => {
    // The bridge is server-push: a peer that talks back only ever acks, and an
    // unknown message must not disturb the canvas.
  });
  const unsubscribe = target.onSocket(ws);
  ws.send({ type: "connected", canvasId: target.canvasId, ts: Date.now() });
  socket.on("close", unsubscribe);
  socket.on("error", unsubscribe);
  return true;
}
