import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";

import {
  transcribe,
  transcriptWords,
  mergeCuts,
  buildEdl,
  deleteWords,
  deleteSegments,
  detectFillerWords,
  removeFillerWords,
  cutRangeForWord,
  cutRangeForSegment,
  type RawSttResult,
  type Transcript,
  type TranscriptSegment,
  type SttBackend,
} from "../transcript.js";

let tmpDir = "";
after(() => {
  try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup raced */ }
});

function makeWav(): string {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-transcript-"));
  const pcm = Buffer.alloc(8000, 0); // 0.5s silence at 16 kHz
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  const file = path.join(tmpDir, "sample.wav");
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
  return file;
}

function backendWith(raw: Omit<RawSttResult, "segments"> & { segments: RawSttResult["segments"] }): SttBackend {
  return async () => raw as RawSttResult;
}

describe("transcript", () => {
  it("transcribes through an injected STT backend into a timestamped transcript", async () => {
    const file = makeWav();
    let received: Buffer | undefined;
    const backend: SttBackend = async (audio) => {
      received = audio;
      return { segments: [{ start: 0, end: 2.5, text: " hello world " }, { start: 3, end: 4, text: " bye" }], language: "en", speakers: 1 };
    };
    const t = await transcribe(file, backend);
    assert.ok(received && received.length >= 44 + 8000);
    assert.deepEqual(t.mediaPath, file);
    assert.deepEqual(t.duration, 4);
    assert.equal(t.language, "en");
    assert.equal(t.segments.length, 2);
    assert.equal(t.segments[0]!.text, "hello world");
    assert.equal(t.segments[1]!.end, 4);
  });

  it("normalizes malformed segments from the raw result", async () => {
    const file = makeWav();
    const backend: SttBackend = async () => ({ segments: [{ start: 1, end: 1, text: "equal" }, { start: -1, end: 0.5, text: "neg" }, { start: "x" as unknown as number, end: 2, text: "nan" }] });
    const t = await transcribe(file, backend);
    assert.equal(t.segments.length, 1);
    assert.equal(t.segments[0]!.text, "neg");
  });

  it("rejects non-files and unspeakable uploads", async () => {
    const missing = path.join(os.tmpdir(), "loam-transcript-missing-" + Date.now() + ".wav");
    assert.throws(() => fs.accessSync(missing));
    await assert.rejects(
      () => transcribe(missing, async () => ({ segments: [] })),
      (err) => err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT",
    );
    const file = makeWav();
    await assert.rejects(() => transcribe(file, async () => ({ segments: [] })), /no speech detected/);
  });

  it("interpolates token times from segment stamps", () => {
    const t: Transcript = { mediaPath: "m.wav", duration: 4, segments: [{ start: 0, end: 4, text: "one two three four" }] };
    const words = transcriptWords(t);
    assert.equal(words.length, 4);
    assert.deepEqual([words[0]!.start, words[3]!.end], [0, 4]);
    assert.equal(words[2]!.start, 2);
    assert.equal(words[2]!.timing, "interpolated");
    assert.equal(words[2]!.segmentIndex, 0);
    assert.equal(words[2]!.wordIndex, 2);
  });

  it("prefers real word timestamps when the STT provides them", () => {
    const t: Transcript = {
      mediaPath: "m.wav", duration: 4,
      segments: [{ start: 0, end: 4, text: "one two", words: [{ word: "one", start: 0, end: 0.2 }, { word: "two", start: 2.9, end: 3.8 }] } as TranscriptSegment],
    };
    const words = transcriptWords(t);
    assert.equal(words.length, 2);
    assert.deepEqual([words[1]!.start, words[1]!.end], [2.9, 3.8]);
    assert.equal(words[1]!.timing, "stt");
  });

  it("merges overlapping and adjacent cuts", () => {
    assert.deepEqual(mergeCuts([{ start: 3, end: 1 }, { start: 2, end: 2.5 }, { start: 2.5, end: 5 }, { start: 9, end: 10 }]), [
      { start: 2, end: 5 },
      { start: 9, end: 10 },
    ]);
  });

  it("builds keeps as the complement of the cuts", () => {
    const t: Transcript = { mediaPath: "m.wav", duration: 10, segments: [{ start: 1, end: 2, text: "a" }, { start: 3, end: 4, text: "b" }, { start: 8, end: 9, text: "c" }] };
    const edl = buildEdl(t, [{ start: 3, end: 4 }, { start: 1, end: 2 }]);
    assert.deepEqual(edl.cuts, [{ start: 1, end: 2 }, { start: 3, end: 4 }]);
    assert.deepEqual(edl.keeps, [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 10 }]);
    assert.equal(edl.removed, 2);
    assert.equal(edl.textAfter, "c");
  });

  it("deletes words by flat index and drops their tokens from the text", () => {
    const t: Transcript = {
      mediaPath: "m.wav", duration: 3,
      segments: [{ start: 0, end: 3, text: "hello crazy beautiful world" }],
    };
    const edl = deleteWords(t, [1, 2]); // crazy, beautiful
    assert.deepEqual(edl.cuts, [{ start: 0.75, end: 2.25 }]);
    assert.deepEqual(edl.keeps, [{ start: 0, end: 0.75 }, { start: 2.25, end: 3 }]);
    assert.equal(edl.removed, 1.5);
    assert.equal(edl.textAfter, "hello world");
  });

  it("deletes selected sentences and keeps untrimmed full text otherwise", () => {
    const t: Transcript = {
      mediaPath: "m.wav", duration: 6,
      segments: [{ start: 0, end: 2, text: "keep me" }, { start: 2, end: 4, text: "cut me" }, { start: 4, end: 6, text: "keep me too" }],
    };
    const edl = deleteSegments(t, [1]);
    assert.deepEqual(edl.cuts, [{ start: 2, end: 4 }]);
    assert.equal(edl.removed, 2);
    assert.equal(edl.textAfter, "keep me keep me too");
  });

  it("detects filler words um/uh with punctuation and case, respects maxDuration", () => {
    const t: Transcript = {
      mediaPath: "m.wav", duration: 5,
      segments: [
        { start: 0, end: 2.5, text: "Um, hello there." },
        { start: 2.5, end: 5, text: "Uh-oh, which uh do I keep?" },
      ],
    };
    const hits = detectFillerWords(t);
    assert.deepEqual(hits.map((h) => h.word), ["Um,", "uh"]);
    assert.deepEqual(hits.map((h) => h.segmentIndex), [0, 1]);
    assert.equal(hits[0]!.timing, "interpolated");
  });

  it("does not flag real words containing filler substrings or long utterances", () => {
    const t: Transcript = {
      mediaPath: "m.wav", duration: 8,
      segments: [
        { start: 0, end: 4, text: "thumb umbrella prism" },
        { start: 4, end: 8, text: "ummm long-drawn-um" },
      ],
    };
    const hits = detectFillerWords(t, { maxDurationSeconds: 0.5 });
    assert.deepEqual(hits, []);
  });

  it("removes fillers into an EDL with merged cuts and remaining text", () => {
    const t: Transcript = {
      mediaPath: "m.wav", duration: 6,
      segments: [{ start: 0, end: 6, text: "um um ok uh okay there" }],
    };
    const result = removeFillerWords(t);
    assert.equal(result.count, 3);
    assert.deepEqual(result.edl.cuts, [{ start: 0, end: 2 }, { start: 3, end: 4 }]);
    assert.equal(result.edl.textAfter, "ok okay there");
    const withExtras = removeFillerWords({ ...t, segments: [{ start: 0, end: 1, text: "like er exactly" }] }, { extraWords: ["er", "like"] });
    assert.equal(withExtras.count, 2);
    assert.equal(withExtras.edl.textAfter, "exactly");
  });

  it("cuts a single word or segment by index", () => {
    const t: Transcript = {
      mediaPath: "m.wav", duration: 3,
      segments: [{ start: 0, end: 3, text: "alpha beta gamma" }],
    };
    assert.deepEqual(cutRangeForWord(t, 2), { start: 2, end: 3 });
    assert.deepEqual(cutRangeForSegment(t, 0), { start: 0, end: 3 });
    assert.throws(() => cutRangeForWord(t, 7), /word index out of range/);
    assert.throws(() => cutRangeForSegment(t, 9), /segment index out of range/);
  });

  it("treats empty delete selection as a no-op EDL", () => {
    const t: Transcript = { mediaPath: "m.wav", duration: 5, segments: [{ start: 0, end: 5, text: "everything stays" }] };
    let edl = deleteWords(t, []);
    assert.deepEqual(edl.keeps, [{ start: 0, end: 5 }]);
    assert.equal(edl.textAfter, "everything stays");
    edl = deleteSegments(t, []);
    assert.equal(edl.removed, 0);
    assert.equal(edl.cuts.length, 0);
  });
});
