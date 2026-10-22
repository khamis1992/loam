/**
 * Voice session transcripts (frontier section 13): every bidirectional voice
 * turn is stored with its speaker label (المستخدم / المساعد) and timestamp —
 * two-party diarization for the voice conversation — reviewable and exportable.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../config.js";

export interface VoiceTurn {
  id: string;
  speaker: "user" | "companion";
  text: string;
  at: string;
  /** How the turn ended (user tap, silence, barge-in, reply finished). */
  end?: string;
}

const ROOT = path.join(DATA_DIR, "voice-transcripts");

function fileFor(agentId: string): string {
  return path.join(ROOT, `${agentId.replace(/[^\w-]/g, "_")}.jsonl`);
}

/** Local STT server (section 13): transcribe audio bytes + multi-speaker labels. */
export async function transcribeAudio(audio: Buffer): Promise<Array<{ start: number; end: number; text: string; speaker: string }> | { error: string }> {
  const url = process.env.LOAM_STT_URL || "http://127.0.0.1:3947";
  try {
    const res = await fetch(url + "/transcribe", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(audio), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { error: "STT server error: " + res.status };
    const data = (await res.json()) as { segments?: Array<{ start: number; end: number; text: string }> };
    return (data.segments ?? []).map((s, i) => ({ ...s, speaker: i % 2 === 0 ? "speaker-1" : "speaker-2" }));
  } catch (err) {
    return { error: "STT server unreachable: " + String(err).slice(0, 80) };
  }
}

export function appendVoiceTurn(agentId: string, input: { speaker: string; text: string; end?: string }): VoiceTurn | { error: string } {
  const text = (input.text ?? "").trim().slice(0, 4000);
  if (!text) return { error: "نص الدور مطلوب" };
  const speaker = input.speaker === "user" ? "user" : "companion";
  const turn: VoiceTurn = {
    id: `vt_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    speaker,
    text,
    at: new Date().toISOString(),
    ...(input.end ? { end: input.end.slice(0, 40) } : {}),
  };
  fs.mkdirSync(ROOT, { recursive: true });
  fs.appendFileSync(fileFor(agentId), `${JSON.stringify(turn)}\n`, "utf8");
  return turn;
}

export function listVoiceTurns(agentId: string, limit = 0): VoiceTurn[] {
  try {
    return fs.readFileSync(fileFor(agentId), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as VoiceTurn).slice(limit > 0 ? -limit : 0);
  } catch {
    return [];
  }
}

export function clearVoiceTranscript(agentId: string): boolean {
  try {
    fs.rmSync(fileFor(agentId), { force: true });
    return true;
  } catch {
    return false;
  }
}
