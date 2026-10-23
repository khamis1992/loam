/**
 * D11 — memory provenance + "dreaming" consolidation.
 *
 * Covers: duplicate merge preserving provenance, stale pruning that keeps
 * explicit user preferences, secret rejection, idempotent/schedulable dream
 * job, and the MEMORY index summary.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { MemoryStore, startMemoryDreamJob } from "../store.js";
import type { OllamaEmbedder } from "../embeddings.js";

const DAY = 24 * 60 * 60 * 1000;

/** Deterministic bag-of-words embedder: near-identical text -> high cosine. */
class FakeEmbedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(vectorFor);
  }
  async embedOne(text: string): Promise<number[]> {
    return vectorFor(text);
  }
}

function vectorFor(text: string): number[] {
  const v = new Array<number>(32).fill(0);
  for (const ch of text.toLowerCase()) {
    const i = ch.charCodeAt(0) % 32;
    v[i] = (v[i] ?? 0) + 1;
  }
  return v;
}

const dirs: string[] = [];

function makeStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-memory-"));
  dirs.push(dir);
  const file = path.join(dir, "memory.json");
  return new MemoryStore(file, new FakeEmbedder() as unknown as OllamaEmbedder, "fake", 0.97);
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("memory provenance", () => {
  it("merges duplicates while preserving provenance from both sessions", async () => {
    const store = makeStore();
    const first = await store.add("User prefers dark mode", {
      kind: "preference",
      sessionId: "session-a",
      source: "user",
    });
    const second = await store.add("User prefers dark mode.", {
      kind: "preference",
      sessionId: "session-b",
      source: "user",
    });

    assert.equal(store.count, 1);
    assert.equal(second.id, first.id);
    assert.deepEqual(new Set(second.sourceSessionIds), new Set(["session-a", "session-b"]));
    assert.equal(second.sessionId, "session-a");
    assert.equal(second.source, "user");
    assert.equal(second.kind, "preference");
  });

  it("keeps the original added date when a duplicate is merged", async () => {
    const store = makeStore();
    const first = await store.add("Project uses pnpm", { kind: "fact", sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 5));
    const merged = await store.add("Project uses pnpm.", { kind: "fact", sessionId: "s2" });
    assert.equal(merged.createdAt, first.createdAt);
    assert.deepEqual(new Set(merged.sourceSessionIds), new Set(["s1", "s2"]));
  });

  it("persists provenance across reload", async () => {
    const store = makeStore();
    const entry = await store.add("User prefers tea", {
      kind: "preference",
      sessionId: "session-x",
      source: "user",
    });
    await new Promise((r) => setTimeout(r, 350));
    const file = (store as unknown as { file: string }).file;
    const reloaded = new MemoryStore(
      file,
      new FakeEmbedder() as unknown as OllamaEmbedder,
      "fake",
      0.97,
    );
    const hit = reloaded.list(10).find((e) => e.id === entry.id);
    assert.equal(hit?.sessionId, "session-x");
    assert.equal(hit?.source, "user");
  });
});

describe("dreaming consolidation", () => {
  it("prunes a stale unused entry but keeps an explicit user preference", async () => {
    const store = makeStore();
    const now = new Date("2026-01-31T00:00:00Z");
    const old = new Date(now.getTime() - 40 * DAY).toISOString();

    const note = await store.add("Old unused note about nothing", { kind: "note", sessionId: "s1" });
    const pref = await store.add("User prefers tea", {
      kind: "preference",
      sessionId: "s1",
      source: "user",
    });
    store.markUsed(note.id, old);
    store.markUsed(pref.id, old);

    const report = await store.dream({ now, staleAfterMs: 30 * DAY });
    assert.equal(report.pruned, 1);
    assert.equal(report.merged, 0);
    assert.equal(store.count, 1);
    assert.equal(store.list(10)[0]?.id, pref.id);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const store = makeStore();
    const now = new Date("2026-01-31T00:00:00Z");
    const old = new Date(now.getTime() - 40 * DAY).toISOString();

    await store.add("Duplicate thought", { kind: "note", sessionId: "s1" });
    await store.add("Duplicate thought.", { kind: "note", sessionId: "s2" });
    const stale = await store.add("Stale thought", { kind: "note", sessionId: "s1" });
    store.markUsed(stale.id, old);

    const first = await store.dream({ now, staleAfterMs: 30 * DAY });
    assert.equal(first.idempotent, false);

    const second = await store.dream({ now, staleAfterMs: 30 * DAY });
    assert.equal(second.idempotent, true);
    assert.equal(second.merged, 0);
    assert.equal(second.pruned, 0);
    assert.equal(second.kept, store.count);
  });

  it("merges duplicates that slipped in before the dream run", async () => {
    const store = makeStore();
    // Write two near-duplicates straight to the file so `add` never sees them.
    await store.add("Alpha beta gamma", { kind: "note" });
    const file = (store as unknown as { file: string }).file;
    await new Promise((r) => setTimeout(r, 350));
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    const copy = { ...raw.entries[0]! };
    copy.id = "mem_dupcopy";
    copy.text = "Alpha beta gamma.";
    raw.entries.push(copy);
    fs.writeFileSync(file, JSON.stringify(raw), "utf8");

    const reloaded = new MemoryStore(
      file,
      new FakeEmbedder() as unknown as OllamaEmbedder,
      "fake",
      0.97,
    );
    assert.equal(reloaded.count, 2);
    const report = await reloaded.dream({ similarityThreshold: 0.9 });
    assert.equal(report.merged, 1);
    assert.equal(reloaded.count, 1);
  });

  it("is schedulable and can be stopped", async () => {
    let calls = 0;
    const fake = {
      dream: async () => {
        calls += 1;
        return { at: "", startedWith: 0, kept: 0, merged: 0, pruned: 0, idempotent: true, changes: [] };
      },
    } as unknown as MemoryStore;
    const stop = startMemoryDreamJob(fake, { intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    assert.ok(calls >= 1);
  });
});

describe("secret rejection", () => {
  it("rejects credential-like strings", async () => {
    const store = makeStore();
    await assert.rejects(
      () => store.add("my key is sk-abcdefghijklmnopqrstuvwxyz012345"),
      /secret/i,
    );
    await assert.rejects(() => store.add("password: hunter2secret"), /secret/i);
    await assert.rejects(() => store.add("AKIAIOSFODNN7EXAMPLE"), /secret/i);
    await assert.rejects(
      () => store.add("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
      /secret/i,
    );
    assert.equal(store.count, 0);
  });

  it("accepts ordinary memory text", async () => {
    const store = makeStore();
    const entry = await store.add("User prefers dark mode", { kind: "preference" });
    assert.ok(entry.id);
    assert.equal(store.count, 1);
  });
});

describe("memory index summary", () => {
  it("returns an empty string for an empty store", () => {
    const store = makeStore();
    assert.equal(store.indexSummary(), "");
  });

  it("summarizes kinds, tags and recent entries", async () => {
    const store = makeStore();
    await store.add("User prefers dark mode", { kind: "preference", tags: ["ui"] });
    await store.add("Project uses pnpm", { kind: "fact", tags: ["tooling"] });
    const summary = store.indexSummary(5);
    assert.match(summary, /MEMORY index \(2 entries\)/);
    assert.match(summary, /preference:1/);
    assert.match(summary, /fact:1/);
    assert.match(summary, /#ui/);
    assert.match(summary, /#tooling/);
    assert.match(summary, /User prefers dark mode/);
  });
});
