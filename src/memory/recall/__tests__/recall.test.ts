import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { defaultRecallConfig, halfLifeDays } from "../defaults.js";
import { applyDecay, applyForgetting, utilityOf } from "../decay.js";
import { inQuietHours, runGardenerTick } from "../gardener.js";
import { adjustForeground } from "../idle.js";
import { rememberFact } from "../link.js";
import { bm25Rank } from "../lexical.js";
import { LshIndex } from "../lsh.js";
import { migrateLegacyStore } from "../migrateLegacy.js";
import { tokenize } from "../normalize.js";
import { RecallRepo } from "../repo.js";
import { parseRerankScores, createCircuitBreaker } from "../rerank.js";
import { mmr, searchMemories } from "../search.js";
import { createRecallService } from "../service.js";
import type { Embedder, MemoryRecord, TextModel } from "../types.js";
import { contentHash, newId, toUnit } from "../vectors.js";

const files: string[] = [];

function tempDb(): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-recall-"));
  files.push(dir);
  return new DatabaseSync(path.join(dir, "t.db"));
}

function bagEmbed(texts: string[]): number[][] {
  return texts.map((text) => {
    const vec = new Array<number>(32).fill(0);
    for (const token of tokenize(text)) vec[token.length % 32] = (vec[token.length % 32] ?? 0) + 1;
    return [...toUnit(vec)];
  });
}

const embedder: Embedder = { async embed(texts) { return bagEmbed(texts); } };

function model(reply: string | ((system: string, user: string) => string)): TextModel {
  return {
    async complete(system, user) {
      const text = typeof reply === "function" ? reply(system, user) : reply;
      return { text, promptTokens: 10, completionTokens: 5 };
    },
  };
}

after(() => {
  for (const dir of files) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps a db file locked until the process exits. */ }
  }
});

describe("recall.schema", () => {
  it("migrates twice and cascades relations", () => {
    const repo = new RecallRepo(tempDb());
    const again = new RecallRepo(repo.db);
    assert.equal(again.schema.fts, true);
    const now = Date.now();
    const base = memory("a", "alpha");
    repo.insert(base);
    repo.insert(memory("b", "beta"));
    repo.addRelation({ id: "r1", fromId: "a", toId: "b", type: "EXTENDS", confidence: 0.8, origin: "ingest", createdAt: now });
    repo.replaceLsh("a", "user", "m", [{ table: 0, bucket: 1 }]);
    repo.hardDelete("a");
    assert.equal(repo.relationsOf("b").length, 0);
    assert.equal(repo.lshCandidates("m", "user", [{ table: 0, bucket: 1 }]).length, 0);
  });
});

describe("recall.normalize", () => {
  it("folds Arabic letters, tashkeel, tatweel and digits", () => {
    assert.deepEqual(tokenize("أحمد"), tokenize("احمد"));
    assert.deepEqual(tokenize("مدرسة"), tokenize("مدرسه"));
    assert.deepEqual(tokenize("كتـاب"), tokenize("كتاب"));
    assert.deepEqual(tokenize("مَرْحَبا"), tokenize("مرحبا"));
    assert.deepEqual(tokenize("رقم ١٢ and file"), tokenize("رقم 12 and file"));
  });
});

describe("recall.lexical", () => {
  it("ranks the exact term and ignores other scopes via the caller filter", () => {
    const hits = bm25Rank([
      { id: "old", content: "superseded note" },
      { id: "new", content: "arabic reports preference" },
      { id: "other", content: "unrelated" },
    ], "arabic reports");
    assert.equal(hits[0]?.id, "new");
    assert.equal(hits.find((hit) => hit.id === "other"), undefined);
  });
});

describe("recall.lsh", () => {
  it("is deterministic and recalls close neighbours", () => {
    const index = new LshIndex(32, { tables: 12, bits: 6, componentsPerBit: 8, seed: 7 });
    const vec = toUnit(Array.from({ length: 32 }, (_, i) => Math.sin(i + 1)));
    assert.deepEqual(index.signature(vec), new LshIndex(32, { tables: 12, bits: 6, componentsPerBit: 8, seed: 7 }).signature(vec));
    const dim = 48;
    const lsh = new LshIndex(dim, { tables: 12, bits: 6, componentsPerBit: 8, seed: 11 });
    const vectors: Float32Array[] = [];
    for (let i = 0; i < 5000; i++) vectors.push(toUnit(Array.from({ length: dim }, (_, k) => Math.sin(i * 0.17 + k))));
    const buckets = vectors.map((vector) => lsh.signature(vector));
    let hit = 0;
    const samples = 100;
    for (let i = 0; i < samples; i++) {
      const noisy = toUnit(vectors[i]!.map((value, k) => value + Math.sin(k) * 0.01));
      const probes = new Set(lsh.probes(noisy).map((probe) => `${probe.table}:${probe.bucket}`));
      const found = buckets[i]!.some((bucket) => probes.has(`${bucket.table}:${bucket.bucket}`));
      if (found) hit += 1;
    }
    assert.ok(hit / samples >= 0.9, `recall ${hit / samples}`);
  });
});

describe("recall.search", () => {
  it("fuses scores, applies recency, and diversifies with MMR", async () => {
    const repo = new RecallRepo(tempDb());
    const now = Date.now();
    repo.insert(memory("new", "arabic reports", { documentAt: now, embedding: unit([1, 0]) }));
    repo.insert(memory("old", "arabic reports history", { documentAt: now - 10 * 3_600_000, embedding: unit([1, 0]) }));
    const hits = await searchMemories(repo, defaultRecallConfig({ rerank: { enabled: false, deadlineMs: 3500, blendOriginal: 0.4, minLlm: 0.15, maxCandidates: 20 } }), async () => unit([1, 0]), undefined, { text: "arabic reports", scope: ["user"], rerank: false, limit: 2 }, now);
    assert.equal(hits[0]?.memory.id, "new");
    assert.ok((hits[0]?.parts.recency ?? 0) > (hits[1]?.parts.recency ?? 1));
    const diverse = mmr([
      hit("a", "alpha beta", 1),
      hit("b", "alpha beta", 0.6),
      hit("c", "gamma delta", 0.5),
    ], 0.7, 2);
    assert.deepEqual(diverse.map((item) => item.memory.id), ["a", "c"]);
  });

  it("falls back when the reranker misses its deadline and opens the breaker", async () => {
    const repo = new RecallRepo(tempDb());
    repo.insert(memory("a", "arabic reports", { embedding: unit([1, 0]) }));
    const hanging: TextModel = { complete: () => new Promise(() => undefined) };
    const hits = await searchMemories(repo, defaultRecallConfig(), async () => unit([1, 0]), hanging, { text: "arabic", scope: ["user"], rerank: { deadlineMs: 30 }, limit: 1 });
    assert.equal(hits[0]?.memory.id, "a");
    const breaker = createCircuitBreaker({ failures: 3, cooldownMs: 10_000, autoOffP50Ms: 3000, autoOffSamples: 20 });
    breaker.failure(1); breaker.failure(1); breaker.failure(1);
    assert.equal(breaker.allow(1), false);
    assert.equal(breaker.allow(20_000), true);
  });

  it("turns rerank off from the saved setting", async () => {
    const service = createRecallService(tempDb(), {
      embedder: { async embed() { return [[1, 0]]; } },
      model: { async complete() { throw new Error("rerank should stay off"); } },
    });
    service.repo.insert(memory("a", "arabic reports", { embedding: unit([1, 0]) }));
    service.repo.setSetting("rerank", "0");
    const hits = await service.search({ text: "arabic", scope: ["user"], limit: 1 });
    assert.equal(hits[0]?.memory.id, "a");
  });
});

describe("recall.rerank.parse", () => {
  it("accepts scores, repairs 1-based indexes, and rejects garbage", () => {
    assert.deepEqual(parseRerankScores('{"scores":[0.2,0.9]}', 2), [0.2, 0.9]);
    const repaired = parseRerankScores('{"scores":[2,1]}', 2);
    assert.ok(repaired && repaired[1]! > repaired[0]!);
    assert.equal(parseRerankScores("nope", 2), null);
    assert.equal(parseRerankScores('{"scores":[0.2]}', 2), null);
  });
});

describe("recall.ingest", () => {
  it("confirms only user duplicates, supersedes updates, extends, and drops secrets", async () => {
    const repo = new RecallRepo(tempDb());
    const config = defaultRecallConfig();
    const first = await rememberFact(repo, config, undefined, model('{"label":"NEW"}'), { content: "Khamis prefers Arabic reports", scope: "user", origin: "user", kind: "preference", embedding: unit([1, 0]) });
    const again = await rememberFact(repo, config, embedder, model('{"label":"NEW"}'), { content: "Khamis prefers Arabic reports", scope: "user", origin: "user", kind: "preference" });
    assert.equal(again.action, "confirmed");
    assert.equal(repo.get(first.id)?.confirmations, 2);
    const touched = await rememberFact(repo, config, embedder, model('{"label":"NEW"}'), { content: "Khamis prefers Arabic reports", scope: "user", origin: "assistant" });
    assert.equal(touched.action, "confirmed");
    assert.equal(repo.get(first.id)?.confirmations, 2);

    const updated = await rememberFact(repo, config, undefined, model('{"label":"UPDATES"}'), {
      content: "Khamis now prefers short Arabic reports",
      scope: "user",
      origin: "user",
      embedding: unit([0.75, 0.7]),
    });
    assert.equal(updated.action, "updated");
    assert.equal(repo.get(first.id)?.state, "superseded");
    assert.equal(repo.relationsOf(updated.id).some((rel) => rel.type === "UPDATES"), true);

    const extended = await rememberFact(repo, config, undefined, model('{"label":"EXTENDS"}'), {
      content: "Those reports should include charts",
      scope: "user",
      origin: "user",
      embedding: unit([0.2, 0.95]),
    });
    assert.equal(extended.action, "extended");
    await assert.rejects(() => rememberFact(repo, config, embedder, undefined, { content: "api_key: abcdefghijklmnop", scope: "user", origin: "user" }));
    assert.equal(repo.containsText("abcdefghijklmnop"), false);
  });
});

describe("recall.decay", () => {
  it("matches the half-lives and does not let retrieval raise utility", () => {
    assert.ok(Math.abs(halfLifeDays(0.995) - 138) / 138 < 0.05);
    assert.ok(Math.abs(halfLifeDays(0.99) - 69) / 69 < 0.05);
    assert.ok(Math.abs(halfLifeDays(0.95) - 14) / 14 < 0.05);
    assert.ok(Math.abs(halfLifeDays(0.998) - 346) / 346 < 0.05);
    assert.ok(Math.abs(halfLifeDays(0.97) - 23) / 23 < 0.05);
    const repo = new RecallRepo(tempDb());
    const now = Date.now();
    repo.insert(memory("p", "preference stays", { kind: "preference", documentAt: now - 400 * 86400000, prominence: 0.01 }));
    applyDecay(repo, defaultRecallConfig(), now);
    assert.ok((repo.get("p")?.prominence ?? 0) >= 0.2);
    const before = utilityOf(repo.get("p")!);
    repo.bumpAccess("p", now);
    assert.equal(utilityOf(repo.get("p")!), before);
  });
});

describe("recall.forget", () => {
  it("archives, trashes, deletes after 30 days, and logs events", () => {
    const repo = new RecallRepo(tempDb());
    const config = defaultRecallConfig();
    const now = Date.now();
    repo.insert(memory("old", "stale fact", { documentAt: now - 20 * 86400000, prominence: 0.05, confirmations: 0 }));
    const archived = applyForgetting(repo, config, now);
    assert.equal(archived.archived, 1);
    repo.update({ ...repo.get("old")!, prominence: 0.005, state: "archived" });
    const trashed = applyForgetting(repo, config, now);
    assert.equal(trashed.trashed, 1);
    const later = applyForgetting(repo, config, now + 31 * 86400000);
    assert.equal(later.deleted, 1);
    assert.equal(repo.get("old"), undefined);
    assert.ok(repo.eventsFor("old").includes("archive"));
  });
});

describe("recall.gardener", () => {
  it("honours quiet hours, the idle gate, catch-up, and isolated dream phases", async () => {
    assert.equal(inQuietHours(Date.parse("2026-01-01T00:30:00Z"), [2, 5]), true);
    assert.equal(inQuietHours(Date.parse("2026-01-01T12:00:00Z"), [2, 5]), false);
    const repo = new RecallRepo(tempDb());
    const config = defaultRecallConfig();
    adjustForeground(1);
    const blocked = await runGardenerTick(repo, config, "sleep", undefined, { now: Date.parse("2026-01-01T00:30:00Z") });
    assert.equal(blocked.steps[0]?.name, "idle-gate");
    adjustForeground(-1);
    repo.saveRun("prev", "sleep", false, Date.parse("2026-01-01T12:00:00Z") - 21 * 3_600_000, {});
    const caught = await runGardenerTick(repo, config, "sleep", model("{\"insights\":[]}"), { now: Date.parse("2026-01-01T12:00:00Z") });
    assert.equal(caught.catchUp, true);
    const dreamRepo = new RecallRepo(tempDb());
    dreamRepo.insert(memory("s1", "cluster one alpha", { embedding: unit([1, 0]), prominence: 0.4 }));
    dreamRepo.insert(memory("s2", "cluster one beta", { embedding: unit([0.99, 0.01]), prominence: 0.4 }));
    const report = await runGardenerTick(dreamRepo, config, "sleep", model((system) => {
      if (system.includes("Fuse")) throw new Error("nrem down");
      return '{"edges":[{"index":0,"type":"RELATES","confidence":0.8}]}';
    }), { force: true });
    assert.equal(report.steps.find((step) => step.name === "nrem")?.ok, false);
    assert.equal(report.steps.find((step) => step.name === "rem")?.ok, true);
  });
});

describe("recall.dream", () => {
  it("fuses a cluster and keeps only confident REM edges", async () => {
    const { nremFuse, remAssociate } = await import("../dream.js");
    const repo = new RecallRepo(tempDb());
    const config = defaultRecallConfig();
    repo.insert(memory("s1", "cluster one alpha", { embedding: unit([1, 0]), prominence: 0.4 }));
    repo.insert(memory("s2", "cluster one beta", { embedding: unit([0.99, 0.01]), prominence: 0.4 }));
    const fused = await nremFuse({ repo, config, model: model('{"content":"one fused memory"}') });
    assert.equal(fused.clusters, 1);
    assert.equal(repo.get("s1")?.state, "dormant");
    assert.ok(repo.latest(["user"], ["active"]).some((row) => row.origin === "fusion"));
    const edges = await remAssociate({ repo, config, model: model('{"edges":[{"index":0,"type":"RELATES","confidence":0.8},{"index":1,"type":"RELATES","confidence":0.2}]}') });
    assert.ok(edges.edges >= 1);
    const stored = repo.db.prepare("SELECT confidence FROM recall_relations WHERE origin = 'rem'").all() as Array<{ confidence: number }>;
    assert.ok(stored.length >= 1);
    assert.ok(stored.every((row) => row.confidence >= 0.7));
  });
});

describe("recall.migrate", () => {
  it("imports a legacy file once and reuses a matching vector", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-legacy-"));
    files.push(dir);
    const file = path.join(dir, "memory.json");
    const vector = toUnit([1, 0, 0, 0]);
    fs.writeFileSync(file, JSON.stringify({ model: "nomic-embed-text:latest", entries: [{ text: "legacy fact", kind: "note", dim: 4, vector: Buffer.from(vector.buffer).toString("base64"), tags: ["old"] }] }));
    const service = createRecallService(tempDb(), { config: { models: { generator: "hauhau", embedder: "nomic-embed-text:latest" } } });
    const first = await migrateLegacyStore(service, file, undefined, service.config);
    const second = await migrateLegacyStore(service, file, undefined, service.config);
    assert.equal(first.reused, 1);
    assert.equal(first.imported, 1);
    assert.equal(second.imported, 1);
    assert.equal(service.repo.latest(["user"], ["active"]).length, 1);
    assert.equal(fs.existsSync(`${file}.bak`), true);
  });
});

function unit(values: number[]): Float32Array {
  return toUnit(values);
}

function memory(id: string, content: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id,
    scope: "user",
    content,
    lang: "en",
    kind: extra.kind ?? "fact",
    origin: "user",
    importance: 5,
    confidence: 0.8,
    prominence: extra.prominence ?? 1,
    state: extra.state ?? "active",
    isLatest: extra.isLatest ?? true,
    pinned: false,
    confirmations: extra.confirmations ?? 0,
    accessCount: 0,
    documentAt: extra.documentAt ?? now,
    tags: [],
    contentHash: contentHash("user", content),
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function hit(id: string, content: string, score: number) {
  return { memory: memory(id, content), score, parts: { recency: 1 }, match: "keyword" as const };
}

void newId;
