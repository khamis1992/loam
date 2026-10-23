// NOTICE: transcript-anchored video editing (time-range EDL cuts derived from a
// speech transcript, filler-word removal) is an original clean-room TypeScript
// implementation of an editorial workflow design referenced from ArtCraft's
// speech tooling documentation analysis. No ArtCraft source code, assets, or
// branding were used.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, rootAsset } from "../config.js";

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
/** Upper bound on the PCM WAV bytes buffered for one extraction. A long,
 *  low-bitrate source can expand far past its own size once decoded to 16 kHz
 *  mono, so the decoded stream is capped independently of the source file. */
export const MAX_EXTRACT_BYTES = 512 * 1024 * 1024;

/** Throw when a decoded audio buffer would exceed the extraction budget. */
export function checkExtractionBudget(bytes: number, limit: number = MAX_EXTRACT_BYTES): void {
  if (!Number.isFinite(bytes) || bytes > limit) {
    throw new Error(`audio extraction exceeds the transcription budget (${limit} bytes)`);
  }
}

function ffmpegStaticPath(): string {
  const win = process.platform === "win32";
  return rootAsset("node_modules", "ffmpeg-static", win ? "ffmpeg.exe" : "ffmpeg");
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
    let received = 0;
    child.stdout!.on("data", (c: Buffer) => {
      if (settled) return;
      received += c.length;
      if (received > MAX_EXTRACT_BYTES) {
        settled = true;
        child.kill();
        reject(new Error(`audio extraction exceeds the transcription budget (${MAX_EXTRACT_BYTES} bytes)`));
        return;
      }
      chunks.push(c);
    });
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

interface SegmentToken { token: string; start: number; end: number }

/** Token timing for one segment: authoritative STT word stamps when the
 *  transcript provides them, deterministic proportional interpolation
 *  otherwise. Mirrors `transcriptWords` so a cut and the surviving text always
 *  agree on which tokens were removed. */
function segmentTokens(seg: TranscriptSegment): SegmentToken[] {
  if (seg.words?.length) {
    const out: SegmentToken[] = [];
    for (const w of seg.words) {
      const range = saneTimes(w.start, w.end);
      if (!range || !normalizeToken(w.word)) continue;
      out.push({ token: w.word, start: range.start, end: range.end });
    }
    return out;
  }
  const tokens = seg.text.split(/\s+/).filter(Boolean);
  const span = Math.max(0, seg.end - seg.start);
  const slice = tokens.length ? span / tokens.length : 0;
  return tokens.map((token, i) => ({ token, start: seg.start + i * slice, end: seg.start + (i + 1) * slice }));
}

function segmentsAfterCuts(transcript: Transcript, cuts: readonly EdlCut[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of transcript.segments) {
    const tokens = segmentTokens(seg);
    if (!tokens.length) continue; // fully removed (by segment or token coverage)
    const keptTokens: string[] = [];
    for (const t of tokens) {
      const covered = cuts.some((cut) => t.start >= cut.start && t.end <= cut.end);
      if (!covered) keptTokens.push(t.token);
    }
    if (!keptTokens.length) continue;
    if (keptTokens.length === tokens.length) out.push(seg);
    else out.push({ ...seg, text: keptTokens.join(" ") });
  }
  return out;
}

/** Build the EDL (merged cuts, keeps, removed seconds, remaining text) for a set of delete ranges. */
export function buildEdl(transcript: Transcript, ranges: readonly TimeRange[]): EditDecisionList {
  const total = Math.max(0, Number.isFinite(transcript.duration) ? transcript.duration : 0);
  // Clamp cuts to the media so a range past the end cannot overcount removed
  // seconds or produce a keep beyond the source.
  const cuts = mergeCuts(ranges)
    .map((c) => ({ start: Math.max(0, c.start), end: Math.min(c.end, total) }))
    .filter((c) => c.end - c.start > 0);
  let removed = 0;
  for (const c of cuts) removed += c.end - c.start;
  const keeps: EdlCut[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) keeps.push({ start: cursor, end: Math.min(cut.start, total) });
    cursor = Math.max(cursor, Math.min(cut.end, total));
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

// ---------------------------------------------------------------------------
// Rearrangement (assembly). Deleting only ever removes content; moving
// transcript text also reorders it, so the output is modeled as an ordered
// assembly of source ranges (what actually plays) instead of cuts + keeps.
// ---------------------------------------------------------------------------

/** Output timeline of a transcript edit: source ranges in play order. */
export interface EdlAssembly {
  /** Ordered source ranges composing the output. */
  clips: EdlCut[];
  /** Total output duration in seconds (sum of clip lengths). */
  duration: number;
  /** Transcript text in output order. */
  text: string;
}

interface AssemblyPiece {
  start: number;
  end: number;
  text: string;
}

/** Pieces whose source ranges touch (within rounding) play as one clip. */
const CONTIGUOUS_EPSILON = 1e-6;

function transcriptPieces(transcript: Transcript): AssemblyPiece[] {
  const pieces: AssemblyPiece[] = [];
  for (const seg of transcript.segments) {
    const range = saneTimes(seg.start, seg.end);
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    if (!range || !text) continue;
    pieces.push({ ...range, text });
  }
  return pieces;
}

function wordPieces(transcript: Transcript): AssemblyPiece[] {
  return transcriptWords(transcript).map((w) => ({ start: w.start, end: w.end, text: w.word }));
}

function coalescePieces(pieces: readonly AssemblyPiece[]): AssemblyPiece[] {
  const merged: AssemblyPiece[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    // Contiguous means the piece starts where the previous piece ended and does
    // not begin before it in the source (reordered pieces never merge).
    if (last && piece.start >= last.start && piece.start <= last.end + CONTIGUOUS_EPSILON) {
      last.end = Math.max(last.end, piece.end);
      last.text = last.text ? `${last.text} ${piece.text}` : piece.text;
    } else {
      merged.push({ ...piece });
    }
  }
  return merged;
}

function piecesToAssembly(pieces: readonly AssemblyPiece[]): EdlAssembly {
  const merged = coalescePieces(pieces);
  const clips = merged.map((p) => ({ start: p.start, end: p.end }));
  return {
    clips,
    duration: clips.reduce((sum, c) => sum + (c.end - c.start), 0),
    text: merged.map((p) => p.text).join(" ").trim(),
  };
}

/** The kept, ordered source ranges of a delete-only EDL, as an assembly. */
export function assemblyFromEdl(edl: EditDecisionList): EdlAssembly {
  const clips = edl.keeps.map((k) => ({ ...k }));
  return {
    clips,
    duration: clips.reduce((sum, c) => sum + (c.end - c.start), 0),
    text: edl.textAfter,
  };
}

function movePieces(pieces: readonly AssemblyPiece[], indices: readonly number[], target: number): AssemblyPiece[] {
  const total = pieces.length;
  const picked = new Set<number>();
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= total) throw new Error("piece index out of range: " + String(i));
    picked.add(Number(i));
  }
  if (!picked.size) throw new Error("select at least one piece to move");
  if (!Number.isInteger(target) || target < 0 || target > total) throw new Error("move target out of range: " + String(target));
  if (picked.has(target)) return [...pieces];
  const block = [...picked].sort((a, b) => a - b).map((i) => pieces[i]!);
  const order: AssemblyPiece[] = [];
  let placed = false;
  for (let i = 0; i < total; i++) {
    if (picked.has(i)) continue;
    if (!placed && i === target) {
      order.push(...block);
      placed = true;
    }
    order.push(pieces[i]!);
  }
  if (!placed) order.push(...block);
  return order;
}

/** Move selected words (flat indices in transcriptWords()) before the word
 *  currently at `target`, keeping the block's internal order. `target` is an
 *  index into the original word list; `words.length` appends at the end. */
export function moveWords(transcript: Transcript, flatIndices: readonly number[], target: number): EdlAssembly {
  return piecesToAssembly(movePieces(wordPieces(transcript), flatIndices, target));
}

/** Move selected sentences before the segment currently at `target` (index
 *  into the original segment list; `segments.length` appends at the end). */
export function moveSegments(transcript: Transcript, indices: readonly number[], target: number): EdlAssembly {
  return piecesToAssembly(movePieces(transcriptPieces(transcript), indices, target));
}

// ---------------------------------------------------------------------------
// Timeline wiring. The workspace video editor and its render endpoint consume
// an ordered clip list of source in/out points (normalized by the render
// service, which also accepts a `{version, clips}` body directly). Projection
// here means a transcript edit can hydrate into the live timeline unchanged.
// ---------------------------------------------------------------------------

export interface TimelineClip {
  id: string;
  /** Source in point (seconds). */
  in: number;
  /** Source out point (seconds). */
  out: number;
}

/** Render-ready EDL: same shape the workspace video render endpoint validates. */
export interface TimelineEdl {
  version: 1;
  /** Source media duration in seconds, when known. */
  sourceDuration?: number;
  clips: TimelineClip[];
  /** Transcript edits never produce overlays; always empty. */
  overlays: never[];
}

/** The render model rejects clips shorter than this. */
export const MIN_TIMELINE_CLIP_SECONDS = 0.05;

export interface TimelineProjectionOptions {
  /** Source media duration reported in the EDL when known. */
  sourceDuration?: number;
  /** Clips shorter than this are dropped (render model minimum). Default 0.05. */
  minClipSeconds?: number;
}

export interface TimelineProjection {
  /** Render-ready EDL, or null when no clip survives the minimum length. */
  timeline: TimelineEdl | null;
  /** Clips omitted because they are shorter than the render model minimum. */
  droppedClips: number;
}

export function assemblyTimeline(assembly: EdlAssembly, options: TimelineProjectionOptions = {}): TimelineProjection {
  const min = options.minClipSeconds ?? MIN_TIMELINE_CLIP_SECONDS;
  const clips: TimelineClip[] = [];
  let droppedClips = 0;
  for (const clip of assembly.clips) {
    if (clip.end - clip.start < min) {
      droppedClips += 1;
      continue;
    }
    clips.push({ id: `clip-${clips.length + 1}`, in: clip.start, out: clip.end });
  }
  const timeline: TimelineEdl | null = clips.length
    ? {
        version: 1,
        clips,
        overlays: [],
        ...(options.sourceDuration !== undefined && Number.isFinite(options.sourceDuration)
          ? { sourceDuration: options.sourceDuration }
          : {}),
      }
    : null;
  return { timeline, droppedClips };
}

// ---------------------------------------------------------------------------
// Unified transcript-edit dispatch: delete, rearrange, and filler removal all
// resolve to one uniform result (ordered clips + render-ready timeline).
// ---------------------------------------------------------------------------

export type TranscriptEdit =
  | { kind: "words"; indices: number[] }
  | { kind: "segments"; indices: number[] }
  | { kind: "range"; start: number; end: number }
  | { kind: "fillers"; extraWords?: string[]; maxDurationSeconds?: number }
  | { kind: "move-words"; indices: number[]; target: number }
  | { kind: "move-segments"; indices: number[]; target: number };

export interface TranscriptEditResult {
  /** Items the edit selected (words, sentences, filler hits, or merged cuts). */
  count: number;
  /** Source seconds that do not play in the output. */
  removed: number;
  /** Output duration in seconds. */
  duration: number;
  /** Ordered source ranges composing the output. */
  clips: EdlCut[];
  /** Transcript text in output order. */
  text: string;
  /** Present for delete-only edits: the cut/complement decision list. */
  deletion?: EditDecisionList;
  /** Render-ready timeline, or null when nothing survives the edit. */
  timeline: TimelineEdl | null;
  /** Clips dropped from the timeline for being under the minimum length. */
  droppedClips: number;
}

export function applyTranscriptEdit(transcript: Transcript, edit: TranscriptEdit): TranscriptEditResult {
  const project = (assembly: EdlAssembly, count: number, deletion?: EditDecisionList): TranscriptEditResult => {
    const projection = assemblyTimeline(assembly, { sourceDuration: transcript.duration });
    return {
      count,
      removed: transcript.duration - assembly.duration,
      duration: assembly.duration,
      clips: assembly.clips,
      text: assembly.text,
      ...(deletion ? { deletion } : {}),
      timeline: projection.timeline,
      droppedClips: projection.droppedClips,
    };
  };
  switch (edit.kind) {
    case "words": {
      const edl = deleteWords(transcript, edit.indices);
      return project(assemblyFromEdl(edl), new Set(edit.indices).size, edl);
    }
    case "segments": {
      const edl = deleteSegments(transcript, edit.indices);
      return project(assemblyFromEdl(edl), new Set(edit.indices).size, edl);
    }
    case "range": {
      const edl = buildEdl(transcript, [{ start: edit.start, end: edit.end }]);
      return project(assemblyFromEdl(edl), edl.cuts.length, edl);
    }
    case "fillers": {
      const removal = removeFillerWords(transcript, edit);
      return project(assemblyFromEdl(removal.edl), removal.count, removal.edl);
    }
    case "move-words": {
      const assembly = moveWords(transcript, edit.indices, edit.target);
      return project(assembly, new Set(edit.indices).size);
    }
    case "move-segments": {
      const assembly = moveSegments(transcript, edit.indices, edit.target);
      return project(assembly, new Set(edit.indices).size);
    }
    default: {
      const exhaustive: never = edit;
      throw new Error(`unsupported transcript edit kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
