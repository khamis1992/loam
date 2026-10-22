import http from "node:http";
import { transcribeAudio } from "../voiceTranscript.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readRawBody(req: http.IncomingMessage, maxBytes = 25_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("audio too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Composer microphone proxy (option #19): forwards raw recorded audio bytes to
 * the local STT server (scripts/stt_server.py; port via LOAM_STT_URL, default
 * 127.0.0.1:3947) and returns the transcript segments plus a composed text.
 * Reuses the existing transcribeAudio() proxy from voiceTranscript.ts.
 */
export async function handleVoiceRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (req.method !== "POST" || p !== "/api/voice/transcribe") return false;
  try {
    const raw = await readRawBody(req);
    if (raw.length === 0) {
      sendJson(res, 400, { error: "audio bytes required" });
      return true;
    }
    const result = await transcribeAudio(raw);
    if ("error" in result) {
      sendJson(res, 502, result);
      return true;
    }
    const text = result.map((s) => s.text.trim()).filter(Boolean).join(" ");
    sendJson(res, 200, { segments: result, text });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "audio read failed" });
  }
  return true;
}
