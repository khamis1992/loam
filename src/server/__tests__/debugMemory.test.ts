/**
 * J6: the local `debug:memory` HTTP route.
 *
 * The route is the only network-shaped surface J6 adds, so these tests pin its
 * boundary: GET only, 405 for anything else, `cache-control: no-store`, and a
 * body that reports per-process RSS plus one counter row per bounded cache —
 * without leaking prompt text, file paths or tokens.
 */
import assert from "node:assert";
import { Readable, Writable } from "node:stream";
import { describe, it, beforeEach, after } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleDebugMemoryRoutes } from "../routes/debugMemory.js";
import { registerCacheStats, resetCacheStatsRegistry } from "../../memory/stats.js";
import { reportRendererMemory, resetMemoryProfile } from "../../memory/profile.js";

class FakeResponse extends Writable {
  statusCode = 0;
  statusMessage = "";
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): Buffer { return Buffer.concat(this.chunks); }
  json(): Record<string, unknown> { return JSON.parse(this.body().toString("utf8")) as Record<string, unknown>; }
}

function fakeRequest(method: string, url: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: "127.0.0.1:4321" } });
  return req;
}

/** Drive the route with a fake request/response pair and resolve with the response. */
function callRoute(method: string, url: string): Promise<FakeResponse> {
  const res = new FakeResponse() as FakeResponse & ServerResponse;
  return handleDebugMemoryRoutes(fakeRequest(method, url), res, url).then(() => res);
}


interface ProfileBody {
  at?: string;
  uptimeSeconds?: number;
  platform?: string;
  arch?: string;
  server?: { pid?: number; rssBytes?: number; heapUsedBytes?: number; heapTotalBytes?: number };
  main?: { rssBytes?: number };
  renderer?: { rssBytes?: number; heapUsedBytes?: number; count?: number } | null;
  system?: { totalBytes?: number; freeBytes?: number };
  caches?: Array<{ name: string; size: number; capacity: number; bytes: number; maxBytes: number }>;
  totals?: { caches: number; entries: number; bytes: number };
}

describe("debug:memory route", () => {
  beforeEach(() => {
    resetCacheStatsRegistry();
    resetMemoryProfile();
  });

  after(() => {
    resetCacheStatsRegistry();
    resetMemoryProfile();
  });

  it("ignores any path other than /api/debug/memory", async () => {
    const res = await callRoute("GET", "/api/debug/other");
    assert.equal(res.statusCode, 0);
    assert.equal(res.body().length, 0);
  });

  it("returns per-process RSS for this server process", async () => {
    const res = await callRoute("GET", "/api/debug/memory");
    assert.equal(res.statusCode, 200);
    const body = res.json() as ProfileBody;
    assert.equal(body.server?.pid, process.pid);
    assert.ok((body.server?.rssBytes ?? 0) > 0, "RSS must be a positive number of bytes");
    assert.ok((body.server?.heapUsedBytes ?? 0) > 0);
    assert.equal(body.platform, process.platform);
    assert.equal(body.arch, process.arch);
    assert.ok((body.at ?? "").length > 0);
    assert.ok((body.uptimeSeconds ?? -1) >= 0);
    assert.ok((body.system?.totalBytes ?? 0) > 0);
    assert.ok((body.system?.freeBytes ?? -1) >= 0);
  });

  it("is marked no-store and JSON", async () => {
    const res = await callRoute("GET", "/api/debug/memory");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(String(res.headers["content-type"]), /^application\/json/);
    assert.equal(Number(res.headers["content-length"]), res.body().length);
  });

  it("reports one counter row per registered cache, with the configured cap", async () => {
    registerCacheStats("alpha-cache", () => ({ name: "alpha-cache", size: 3, capacity: 32, bytes: 300, maxBytes: 0 }));
    registerCacheStats("beta-cache", () => ({ name: "beta-cache", size: 1, capacity: 8, bytes: 0, maxBytes: 0 }));
    const res = await callRoute("GET", "/api/debug/memory");
    const body = res.json() as ProfileBody;
    const names = (body.caches ?? []).map((c) => c.name);
    assert.deepEqual(names, ["alpha-cache", "beta-cache"]);
    assert.deepEqual(body.caches?.find((c) => c.name === "alpha-cache"), { name: "alpha-cache", size: 3, capacity: 32, bytes: 300, maxBytes: 0 });
    assert.deepEqual(body.totals, { caches: 2, entries: 4, bytes: 300 });
  });

  it("never reports more live entries than the configured cap", async () => {
    registerCacheStats("tight", () => ({ name: "tight", size: 4, capacity: 4, bytes: 0, maxBytes: 0 }));
    const res = await callRoute("GET", "/api/debug/memory");
    const body = res.json() as ProfileBody;
    for (const cache of body.caches ?? []) {
      assert.ok(cache.size <= cache.capacity, `${cache.name}: ${cache.size} > ${cache.capacity}`);
    }
  });

  it("sums renderer RSS samples reported by the desktop main process", async () => {
    reportRendererMemory({ pid: 101, rssBytes: 1024 * 1024, heapUsedBytes: 512 * 1024 });
    reportRendererMemory({ pid: 102, rssBytes: 2 * 1024 * 1024, heapUsedBytes: 1024 * 1024 });
    const res = await callRoute("GET", "/api/debug/memory");
    const body = res.json() as ProfileBody;
    assert.equal(body.renderer?.count, 2);
    assert.equal(body.renderer?.rssBytes, 3 * 1024 * 1024);
    assert.equal(body.renderer?.heapUsedBytes, 1536 * 1024);
  });

  it("reports no renderer section outside the desktop shell", async () => {
    const res = await callRoute("GET", "/api/debug/memory");
    const body = res.json() as ProfileBody;
    assert.equal(body.renderer, null);
  });

  it("replaces a renderer sample when the same pid reports again", async () => {
    reportRendererMemory({ pid: 101, rssBytes: 1024, heapUsedBytes: 0 });
    reportRendererMemory({ pid: 101, rssBytes: 4096, heapUsedBytes: 0 });
    const res = await callRoute("GET", "/api/debug/memory");
    const body = res.json() as ProfileBody;
    assert.equal(body.renderer?.count, 1);
    assert.equal(body.renderer?.rssBytes, 4096);
  });

  it("caps retained renderer samples so a window leak cannot grow the profile", async () => {
    for (let pid = 1; pid <= 40; pid++) reportRendererMemory({ pid, rssBytes: 1024, heapUsedBytes: 0 });
    const res = await callRoute("GET", "/api/debug/memory");
    const body = res.json() as ProfileBody;
    assert.ok((body.renderer?.count ?? 0) <= 16, `expected <= 16 renderer samples, got ${body.renderer?.count}`);
  });

  it("rejects every method other than GET", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
      const res = await callRoute(method, "/api/debug/memory");
      assert.equal(res.statusCode, 405, `${method} must be rejected`);
      assert.equal((res.json() as { error?: string }).error, "Method not allowed");
    }
  });
});
