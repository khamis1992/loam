import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { describe, it, before, after } from "node:test";

type DocTrackIO = typeof import("../workspace/docTrackIO.js");
type DocIO = typeof import("../workspace/docIO.js");

let tmpDir: string;
let trackIO: DocTrackIO;
let docIO: DocIO;

function sampleTrack() {
  return {
    authors: { local: { id: "local", name: "مستخدم لوم" } },
    paragraphs: [
      { id: "p1", runs: [
        { id: "r1", type: "base", text: "Hello " },
        { id: "r2", type: "insert", text: "brave ", authorId: "local", timestamp: "2026-10-27T00:00:00.000Z" },
        { id: "r3", type: "base", text: "world" },
      ] },
      { id: "p2", runs: [] },
    ],
    threads: [
      { id: "t1", paragraphId: "p1", anchor: { offset: 6, length: 6 }, resolved: false,
        comments: [{ id: "c1", authorId: "local", text: "لماذا؟", timestamp: "2026-10-27T00:00:00.000Z", parentId: null }] },
    ],
  };
}

function sidecarName(rel: string): string {
  return `${createHash("sha1").update(rel).digest("hex")}.json`;
}

describe("workspace doc track sidecar", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-doc-track-"));
    trackIO = await import("../workspace/docTrackIO.js");
    docIO = await import("../workspace/docIO.js");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a tracked document through the sidecar file", () => {
    assert.equal(trackIO.loadDocTrack(tmpDir, "report.docx"), null, "missing sidecar reads as null");
    const track = sampleTrack();
    trackIO.saveDocTrack(tmpDir, "report.docx", track);
    assert.deepEqual(trackIO.loadDocTrack(tmpDir, "report.docx"), track);
    const expected = path.join(tmpDir, ".loam", "track", sidecarName("report.docx"));
    assert.ok(fs.existsSync(expected), "sidecar stored at .loam/track/<sha1>.json");
    const leftovers = fs.readdirSync(path.dirname(expected)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "atomic write leaves no .tmp files");
  });

  it("keeps one sidecar per document path", () => {
    trackIO.saveDocTrack(tmpDir, "a.docx", { paragraphs: [] });
    trackIO.saveDocTrack(tmpDir, "b.docx", { paragraphs: [{ id: "p", runs: [] }] });
    assert.deepEqual(trackIO.loadDocTrack(tmpDir, "a.docx"), { paragraphs: [] });
    assert.notEqual(trackIO.loadDocTrack(tmpDir, "b.docx"), null);
  });

  it("rejects malformed bodies with a 400 DocFileError", () => {
    const cases: unknown[] = [
      null,
      "text",
      42,
      [],
      {},
      { paragraphs: "nope" },
      { paragraphs: [{}] },
      { paragraphs: [{ id: "p", runs: "nope" }] },
      { paragraphs: [{ runs: [] }] },
      { paragraphs: [{ id: "p", runs: [] }], threads: "nope" },
      { paragraphs: [{ id: "p", runs: [] }], authors: "nope" },
    ];
    for (const bad of cases) {
      assert.throws(
        () => trackIO.saveDocTrack(tmpDir, "bad.docx", bad),
        (error: unknown) => error instanceof docIO.DocFileError && error.status === 400,
        `payload must be rejected: ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(trackIO.loadDocTrack(tmpDir, "bad.docx"), null, "rejected bodies are never stored");
  });

  it("caps the serialized sidecar at 2 MB", () => {
    const big = { paragraphs: [{ id: "p", runs: [{ id: "r", type: "base", text: "x".repeat(2_100_000) }] }] };
    assert.throws(
      () => trackIO.saveDocTrack(tmpDir, "big.docx", big),
      (error: unknown) => error instanceof docIO.DocFileError && error.status === 400,
    );
  });

  it("reports a corrupted stored sidecar as a 500", () => {
    trackIO.saveDocTrack(tmpDir, "broken.docx", { paragraphs: [] });
    const file = path.join(tmpDir, ".loam", "track", sidecarName("broken.docx"));
    fs.writeFileSync(file, "{not json", "utf8");
    assert.throws(
      () => trackIO.loadDocTrack(tmpDir, "broken.docx"),
      (error: unknown) => error instanceof docIO.DocFileError && error.status === 500,
    );
  });
});
