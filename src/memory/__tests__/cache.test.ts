/**
 * J6 unit tests: the shared bounded-cache primitives.
 *
 * The whole point of J6 is that every hot-path cache has an enforced bound, so
 * these tests pin the two mechanisms the caps rely on — `LruCache` (entry cap +
 * optional byte ceiling, touch-on-read recency) and `BoundedMap` (drop-in
 * wrapper that can release the resource it evicted) — plus the stats registry
 * the local `debug:memory` surface reads.
 */
import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import { BoundedMap, LruCache, byteSizeOfBytes, byteSizeOfString } from "../cache.js";
import { cacheNames, cacheTotals, collectCacheStats, registerCacheStats, resetCacheStatsRegistry, unregisterCacheStats } from "../stats.js";

describe("LruCache", () => {
  it("never exceeds its entry capacity and drops the least-recently-used key", () => {
    const cache = new LruCache<number>({ capacity: 3, name: "t-lru" });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    assert.equal(cache.size, 3);

    cache.set("d", 4);
    assert.equal(cache.size, 3);
    assert.equal(cache.has("a"), false, "oldest untouched key was evicted");
    assert.deepEqual([...cache.keys()], ["b", "c", "d"]);
  });

  it("treats a read as a use, so the evicted key is the untouched one", () => {
    const cache = new LruCache<number>({ capacity: 3, name: "t-lru-read" });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    assert.equal(cache.get("a"), 1);

    cache.set("d", 4);
    assert.equal(cache.has("a"), true, "recently read key survived");
    assert.equal(cache.has("b"), false, "b became the oldest");
  });

  it("re-inserting an existing key refreshes it instead of growing", () => {
    const cache = new LruCache<number>({ capacity: 2, name: "t-lru-refresh" });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    assert.equal(cache.size, 2);
    cache.set("c", 3);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.has("b"), false);
    assert.equal(cache.get("a"), 10);
  });

  it("enforces the byte ceiling even under the entry cap", () => {
    // 4 KB per entry, 10 KB ceiling => at most 2 entries survive.
    const cache = new LruCache<Buffer>({ capacity: 100, name: "t-lru-bytes", maxBytes: 10 * 1024, sizeOf: byteSizeOfBytes });
    for (let i = 0; i < 5; i++) cache.set(`k${i}`, Buffer.alloc(4096, i));
    assert.ok(cache.size <= 2, `expected <= 2 entries, got ${cache.size}`);
    assert.ok(cache.retainedBytes <= 10 * 1024, `expected <= 10 KB, got ${cache.retainedBytes}`);
    assert.equal(cache.has("k4"), true, "the entry just written is always kept");
    assert.equal(cache.retainedBytes, 4096 * cache.size);
  });

  it("counts string bytes through the UTF-16 estimator", () => {
    const cache = new LruCache<string>({ capacity: 8, name: "t-lru-str", maxBytes: 16, sizeOf: byteSizeOfString });
    cache.set("a", "1234"); // 8 bytes
    assert.equal(cache.retainedBytes, 8);
    cache.set("b", "5678"); // 8 more => 16, still at the ceiling
    assert.equal(cache.size, 2);
    cache.set("c", "9012"); // would be 24 => evict oldest
    assert.ok(cache.retainedBytes <= 16);
    assert.equal(cache.has("c"), true);
  });

  it("releases bytes on delete and clear", () => {
    const cache = new LruCache<Buffer>({ capacity: 4, name: "t-lru-delete", maxBytes: 1024, sizeOf: byteSizeOfBytes });
    cache.set("a", Buffer.alloc(100));
    cache.set("b", Buffer.alloc(100));
    assert.equal(cache.retainedBytes, 200);
    assert.equal(cache.delete("a"), true);
    assert.equal(cache.retainedBytes, 100);
    assert.equal(cache.delete("missing"), false);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.retainedBytes, 0);
  });

  it("reports its own counter row", () => {
    const cache = new LruCache<Buffer>({ capacity: 2, name: "t-lru-stats", maxBytes: 1024, sizeOf: byteSizeOfBytes });
    cache.set("a", Buffer.alloc(10));
    assert.deepEqual(cache.stats(), { name: "t-lru-stats", size: 1, capacity: 2, bytes: 10 });
  });
});

describe("BoundedMap", () => {
  it("caps entries and evicts the oldest key", () => {
    const map = new BoundedMap<string, number>(2, "t-bounded");
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    assert.equal(map.size, 2);
    assert.equal(map.has("a"), false);
    assert.equal(map.get("c"), 3);
    assert.equal(map.get("b"), 2);
  });

  it("refreshes recency on read", () => {
    const map = new BoundedMap<string, number>(2, "t-bounded-read");
    map.set("a", 1);
    map.set("b", 2);
    map.get("a");
    map.set("c", 3);
    assert.equal(map.has("a"), true);
    assert.equal(map.has("b"), false);
  });

  it("runs the eviction hook so the holder can release the resource", () => {
    const released: string[] = [];
    const map = new BoundedMap<string, { id: string }>(2, "t-bounded-hook", (key) => { released.push(key); });
    map.set("a", { id: "a" });
    map.set("b", { id: "b" });
    map.set("c", { id: "c" });
    assert.deepEqual(released, ["a"]);
    assert.equal(map.evictOldest(), true);
    assert.deepEqual(released, ["a", "b"]);
    assert.equal(map.size, 1);
    assert.equal(map.evictOldest(), true);
    assert.equal(map.evictOldest(), false, "an empty map has nothing to evict");
  });

  it("survives an eviction hook that throws", () => {
    const map = new BoundedMap<string, number>(1, "t-bounded-throw", () => { throw new Error("hook failed"); });
    map.set("a", 1);
    assert.doesNotThrow(() => map.set("b", 2));
    assert.equal(map.size, 1);
    assert.equal(map.get("b"), 2);
  });

  it("exposes entries() and its counter row", () => {
    const map = new BoundedMap<string, number>(5, "t-bounded-entries");
    map.set("a", 1);
    assert.deepEqual([...map.entries()], [["a", 1]]);
    assert.deepEqual([...map], [["a", 1]]);
    assert.deepEqual(map.stats(), { name: "t-bounded-entries", size: 1, capacity: 5, bytes: 0 });
    assert.equal(map.capacityLimit, 5);
  });
});

describe("cache stats registry", () => {
  beforeEach(() => resetCacheStatsRegistry());

  it("collects snapshots sorted by name and totals them", () => {
    registerCacheStats("zeta", () => ({ name: "zeta", size: 2, capacity: 4, bytes: 20 }));
    registerCacheStats("alpha", () => ({ name: "alpha", size: 1, capacity: 4, bytes: 10 }));
    assert.deepEqual(cacheNames(), ["alpha", "zeta"]);
    const stats = collectCacheStats();
    assert.deepEqual(stats.map((s) => s.name), ["alpha", "zeta"]);
    assert.deepEqual(cacheTotals(stats), { caches: 2, entries: 3, bytes: 30 });
  });

  it("replaces a duplicate name instead of double counting", () => {
    registerCacheStats("dup", () => ({ name: "dup", size: 1, capacity: 2, bytes: 1 }));
    registerCacheStats("dup", () => ({ name: "dup", size: 1, capacity: 9, bytes: 1 }));
    assert.equal(collectCacheStats().length, 1);
    assert.equal(collectCacheStats()[0]!.capacity, 9);
  });

  it("skips a snapshot that throws rather than failing the whole surface", () => {
    registerCacheStats("broken", () => { throw new Error("boom"); });
    registerCacheStats("fine", () => ({ name: "fine", size: 1, capacity: 1, bytes: 0 }));
    const stats = collectCacheStats();
    assert.equal(stats.length, 2);
    assert.deepEqual(stats.find((s) => s.name === "broken"), { name: "broken", size: 0, capacity: 0, bytes: 0 });
  });

  it("unregisters by name", () => {
    registerCacheStats("gone", () => ({ name: "gone", size: 0, capacity: 1, bytes: 0 }));
    unregisterCacheStats("gone");
    assert.deepEqual(cacheNames(), []);
  });
});
