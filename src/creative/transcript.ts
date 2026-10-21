// NOTICE: transcript-anchored video editing (time-range EDL cuts derived from a
// speech transcript, filler-word removal) is an original clean-room TypeScript
// implementation of an editorial workflow design referenced from ArtCraft's
// speech tooling documentation analysis. No ArtCraft source code, assets, or
// branding were used.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "../config.js";

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  words?: TimedWord[];
}

export interface Transcript {
  mediaPath: string;
  duration: number;
  language?: string;
  speakers?: number;
  segments: TranscriptSegment[];
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface EdlCut {
  start: number;
  end: number;
}

/** A decision list over the source timeline: ranges to drop and the complement to keep. */
export interface EditDecisionList {
  /** Merged, sorted source ranges that will be removed. */
  cuts: EdlCut[];
  /** Merged, sorted source ranges that remain visible/audible. */
  keeps: EdlCut[];
  /** Total seconds removed. */
  removed: number;
  /** Transcript text after applying the cuts. Partially trimmed segments lose the cut tokens. */
  textAfter: string;
}

export interface FillerHit {
  segmentIndex: number;
  wordIndex: number;
  word: string;
  start: number;
  end: number;
  /** How the timing was obtained: stt word timestamps or proportional token interpolation. */
  timing: "stt" | "interpolated";
}

export interface FillerOptions {
  /** Extra filler tokens to treat as fillers in addition to um/uh. */
  extraWords?: string[];
  /** Filler words longer than this many seconds are kept (real speech, not hesitation). Default 1.5. */
  maxDurationSeconds?: number;
}

export interface RawSttSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface RawSttResult {
  segments: RawSttSegment[];
  language?: string;
  speakers?: number;
}

/** An injected speech-to-text implementation: audio bytes (WAV PCM recommended) -> segments. */
export type SttBackend = (audio: Buffer) => Promise<RawSttResult>;

function defaultSttUrl(): string {
  return process.env.LOAM_STT_URL || "http://127.0.0.1:3947";
}

const MAX_TRANSCRIBE_BYTES = 2 * 1024 * 1024 * 1024;

function ffmpegStaticPath(): string {
  const win = process.platform === "win32";
  return path.join(ROOT, "node_modules", "ffmpeg-static", win ? "ffmpeg.exe" : "ffmpeg");
}

/** Default STT path reused from existing server wiring: POST /transcribe with raw audio bytes. */
export function httpSttBackend(url: string = defaultSttUrl()): SttBackend {
  return async (audio: Buffer) => {
    const res = await fetch(url + "/transcribe", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error("STT server error: " + res.status);
    const data = (await res.json()) as { segments?: unknown; language?: unknown; speakers?: unknown };
    const segments = Array.isArray(data.segments) ? (data.segments as RawSttSegment[]) : [];
    return {
      segments,
      ...(typeof data.language === "string" ? { language: data.language } : {}),
      ...(typeof data.speakers === "number" ? { speakers: data.speakers } : {}),
    };
  };
}

function saneTimes(start: unknown, end: unknown): TimeRange | undefined {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return undefined;
  return { start: Math.max(0, s), end: Math.max(0, e) };
}

function rawToTranscript(mediaPath: string, raw: RawSttResult): Transcript {
  const segments: TranscriptSegment[] = [];
  for (const seg of raw.segments) {
    const range = saneTimes(seg.start, seg.end);
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    if (!range || !text) continue;
    segments.push({ ...range, text, ...(typeof seg.speaker === "string" ? { speaker: seg.speaker } : {}) });
  }
  const duration = segments.length ? Math.max(...segments.map((s) => s.end)) : 0;
  return {
    mediaPath,
    duration,
    ...(raw.language ? { language: raw.language } : {}),
    ...(raw.speakers ? { speakers: raw.speakers } : {}),
    segments,
  };
}

/** Extract 16 kHz mono WAV via ffmpeg when the container is not plain WAV; whisper accepts PCM bytes. */
async function readAudioBytes(mediaPath: string): Promise<Buffer> {
  const stat = fs.statSync(mediaPath);
  if (!stat.isFile()) throw new Error("not a file: " + mediaPath);
  if (stat.size > MAX_TRANSCRIBE_BYTES) throw new Error("media file exceeds transcription budget (2 GB)");
  if (/\.(wav|wave)$/i.test(path.extname(mediaPath)) || /\.(wav|wave)$/i.test(mediaPath)) {
    try {
      const direct = fs.readFileSync(mediaPath);
      const header = direct.subarray(0, 12).toString("latin1");
      if (header.startsWith("RIFF") && header.slice(8, 12) === "WAVE") return direct;
      // exotic wave variants fall through to ffmpeg
    } catch {
      /* fall back to ffmpeg */
    }
  }
  const ffmpeg = ffmpegStaticPath();
  if (!fs.existsSync(ffmpeg)) {
    throw new Error("only RIFF WAV files can be sent directly; no ffmpeg found to extract audio from " + mediaPath);
  }
  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const child = spawn(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-y", "-i", mediaPath, "-vn", "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => chunks.push(c));
    child.stderr!.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-2000); });
    child.once("error", (e) => { if (!settled) { settled = true; reject(e); } });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error("audio extraction failed: " + (stderr || "exit " + code)));
    });
  });
}

/** Transcribe a media file through an injected STT backend into a timestamped transcript. */
export async function transcribe(mediaPath: string, backend: SttBackend = httpSttBackend()): Promise<Transcript> {
  fs.accessSync(mediaPath);
  const audio = await readAudioBytes(mediaPath);
  const raw = await backend(audio);
  const transcript = rawToTranscript(mediaPath, raw);
  if (!transcript.segments.length) throw new Error("no speech detected in " + mediaPath);
  return transcript;
}

export function normalizeToken(token: string): string {
  return token.replace(/^[\p{P}\p{S}\p{Zs}]+|[\p{P}\p{S}\p{Zs}]+$/gu, "").toLowerCase();
}

/**
 * Word references with authoritative timings when the STT provides per-word stamps,
 * and an explicitly deterministic proportional interpolation of segment tokens otherwise.
 */
export function transcriptWords(transcript: Transcript): Array<{ word: string; start: number; end: number; segmentIndex: number; wordIndex: number; timing: "stt" | "interpolated" }> {
  const out: Array<{ word: string; start: number; end: number; segmentIndex: number; wordIndex: number; timing: "stt" | "interpolated" }> = [];
  transcript.segments.forEach((seg, segmentIndex) => {
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    if (seg.words?.length) {
      seg.words.forEach((w, wordIndex) => {
        const range = saneTimes(w.start, w.end);
        if (!range || !normalizeToken(w.word)) return;
        out.push({ word: w.word, start: range.start, end: range.end, segmentIndex, wordIndex, timing: "stt" });
      });
      return;
    }
    const span = Math.max(0, seg.end - seg.start);
    const slice = span / tokens.length;
    tokens.forEach((token, wordIndex) => {
      out.push({ word: token, start: seg.start + wordIndex * slice, end: seg.start + (wordIndex + 1) * slice, segmentIndex, wordIndex, timing: "interpolated" });
    });
  });
  return out;
}

export function mergeCuts(cuts: readonly TimeRange[]): EdlCut[] {
  const sorted = cuts
    .map((c) => ({ start: Math.max(0, Number(c.start) || 0), end: Math.max(0, Number(c.end) || 0) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: EdlCut[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }
  return merged;
}

function segmentsAfterCuts(transcript: Transcript, cuts: readonly EdlCut[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of transcript.segments) {
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    const span = Math.max(0, seg.end - seg.start);
    const slice = tokens.length ? span / tokens.length : 0;
    const keptTokens: string[] = [];
    tokens.forEach((token, i) => {
      const t = { start: seg.start + i * slice, end: seg.start + (i + 1) * slice };
      const covered = cuts.some((cut) => t.start >= cut.start && t.end <= cut.end);
      if (!covered) keptTokens.push(token);
    });
    if (!keptTokens.length) continue; // fully removed (by segment or token coverage)
    if (keptTokens.length === tokens.length) out.push(seg);
    else out.push({ ...seg, text: keptTokens.join(" ") });
  }
  return out;
}

/** Build the EDL (merged cuts, keeps, removed seconds, remaining text) for a set of delete ranges. */
export function buildEdl(transcript: Transcript, ranges: readonly TimeRange[]): EditDecisionList {
  const cuts = mergeCuts(ranges);
  let removed = 0;
  for (const c of cuts) removed += c.end - c.start;
  const total = transcript.duration;
  const keeps: EdlCut[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) keeps.push({ start: cursor, end: Math.min(cut.start, total) });
    cursor = Math.max(cursor, cut.end);
  }
  if (total > cursor) keeps.push({ start: cursor, end: total });
  return { cuts, keeps, removed, textAfter: segmentsAfterCuts(transcript, cuts).map((s) => s.text).join(" ").trim() };
}

/** Delete selected words as editor cuts. Indices are flat positions within transcriptWords(). */
export function deleteWords(transcript: Transcript, flatIndices: readonly number[]): EditDecisionList {
  const words = transcriptWords(transcript);
  const picked = new Set(flatIndices);
  const ranges: TimeRange[] = [];
  words.forEach((w, i) => {
    if (picked.has(i)) ranges.push({ start: w.start, end: w.end });
  });
  return buildEdl(transcript, ranges);
}

/** Delete selected whole segments (sentences, by index) as editor cuts + surviving text. */
export function deleteSegments(transcript: Transcript, indices: readonly number[]): EditDecisionList {
  const idx = new Set(indices);
  const ranges: TimeRange[] = [];
  transcript.segments.forEach((seg, i) => {
    if (idx.has(i)) ranges.push({ start: seg.start, end: seg.end });
  });
  return buildEdl(transcript, ranges);
}

const DEFAULT_FILLERS = ["um", "uh"];

/** Find filler-word hits (um/uh plus caller extras), ignoring punctuation and case. */
export function detectFillerWords(transcript: Transcript, options: FillerOptions = {}): FillerHit[] {
  const fillers = new Set([...DEFAULT_FILLERS, ...(options.extraWords ?? []).map((w) => normalizeToken(w)).filter(Boolean)]);
  const maxDuration = options.maxDurationSeconds ?? 1.5;
  const hits: FillerHit[] = [];
  transcriptWords(transcript).forEach((w) => {
    const token = normalizeToken(w.word);
    if (!token || !fillers.has(token)) return;
    if (w.end - w.start > maxDuration) return;
    hits.push({ segmentIndex: w.segmentIndex, wordIndex: w.wordIndex, word: w.word, start: w.start, end: w.end, timing: w.timing });
  });
  return hits;
}

/** Detect and remove filler words: equivalent to selecting every detected word hit for deletion. */
export function removeFillerWords(transcript: Transcript, options: FillerOptions = {}): { detected: FillerHit[]; count: number; edl: EditDecisionList } {
  const detected = detectFillerWords(transcript, options);
  const ranges: TimeRange[] = detected.map((h) => ({ start: h.start, end: h.end }));
  const edl = buildEdl(transcript, ranges);
  return { detected, count: detected.length, edl };
}

/** One clicked word (flat index in transcriptWords()) as an editable cut range. */
export function cutRangeForWord(transcript: Transcript, flatIndex: number): TimeRange {
  const words = transcriptWords(transcript);
  const w = words[flatIndex];
  if (!w) throw new Error("word index out of range: " + flatIndex);
  return { start: w.start, end: w.end };
}

/** One clicked segment (sentence index) as its full cut range. */
export function cutRangeForSegment(transcript: Transcript, segmentIndex: number): TimeRange {
  const seg = transcript.segments[segmentIndex];
  if (!seg) throw new Error("segment index out of range: " + segmentIndex);
  return { start: seg.start, end: seg.end };
}
