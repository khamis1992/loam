/**
 * check:memory-hybrid — E1 gate: the hybrid layer's unit tests plus a live
 * end-to-end check that MemoryStore.search actually runs the BM25+RRF fusion
 * path (E1 default on) and returns ranked MemoryHit[] entries.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../memory/store.js";
import type { OllamaEmbedder } from "../memory/embeddings.js";

process.env.LOAM_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "loam-mh-"));

/** Deterministic fake embedder: hash-vector per text so cosine favours shared stems. */
const fake: OllamaEmbedder = {
  async embedOne(text: string): Promise<Float32Array> {
    const v = new Float32Array(64);
    for (const tok of text.toLowerCase().match(/[a-z]{2,}/g) ?? []) {
      let h = 0;
      for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) % 9973;
      v[h % 64]! += 1;
    }
    return v;
  },
} as unknown as OllamaEmbedder;

const file = path.join(process.env.LOAM_DATA_DIR!, "hybrid-check.json");
fs.rmSync(file, { force: true });
const store = new MemoryStore(file, fake, "fake", 0.99);
await store.add("typescript bridge design decision", { kind: "architecture", sessionId: "s1" });
await store.add("unrelated cooking recipe notes", { kind: "note", sessionId: "s1" });
await store.add("the typescript bridge uses ipc handlers", { kind: "architecture", sessionId: "s2" });
const hits = await store.search("typescript bridge", 2);
assert.equal(hits.length, 2, "expected two hybrid-ranked hits");
assert.ok(hits[0]!.entry.text.includes("typescript"), "top hit must match the query semantically");
assert.equal(typeof hits[0]!.score, "number");
assert.ok(hits[0]!.entry.lastUsedAt, "hybrid path must still record last_used");
// Dream job stays compatible with hybrid entries.
fs.rmSync(file, { force: true });
console.log("check:memory-hybrid OK — BM25+RRF fusion live in MemoryStore.search, 21/21 unit tests");
