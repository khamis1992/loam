/**
 * Design Studio HTTP surface tests.
 *
 * Guards two things: the /api/design contract itself, and — critically — that
 * src/server/http.ts actually mounts handleDesignStudioRoutes. The route module
 * shipped unmounted (dead code), so every /api/design call 404'd while the
 * agent tool kept advertising `GET /api/design/outputs/<id>/image`.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { describe, it, before, after } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

type Json = Record<string, unknown>;

class FakeResponse extends Writable {
  status = 0;
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];
  private _headers: Record<string, unknown> = {};

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  setHeader(name: string, value: unknown): this { this._headers[name.toLowerCase()] = value; return this; }
  getHeader(name: string): unknown { return this._headers[name.toLowerCase()]; }
  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): Buffer { return Buffer.concat(this.chunks); }
  json(): Json { return JSON.parse(this.body().toString("utf8")) as Json; }
}

function fakeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: "127.0.0.1:3939", "content-type": "application/json" } });
  return req;
}

describe("design studio routes", () => {
  let tmpDir = "";
  let closeDb: () => void;
  let handler: (req: IncomingMessage, res: ServerResponse, p: string) => Promise<boolean>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-design-routes-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    closeDb = (await import("../sqliteStore.js")).closeDb;
    handler = (await import("../routes/designStudio.js")).handleDesignStudioRoutes;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Mirrors http.ts: the handler receives url.pathname, while url keeps the query. */
  async function call(method: string, url: string, body?: unknown): Promise<FakeResponse> {
    const res = new FakeResponse() as unknown as FakeResponse & ServerResponse;
    const p = new URL(url, "http://127.0.0.1:3939").pathname;
    await handler(fakeRequest(method, url, body), res as unknown as ServerResponse, p);
    return res;
  }

  it("is mounted by the HTTP server", () => {
    const http = fs.readFileSync(path.join(import.meta.dirname, "..", "http.ts"), "utf8");
    assert.match(http, /import\s*\{\s*handleDesignStudioRoutes\s*\}\s*from\s*"\.\/routes\/designStudio\.js"/, "http.ts must import the design routes");
    assert.match(http, /await\s+handleDesignStudioRoutes\(req,\s*res,\s*p\)/, "http.ts must dispatch to the design routes");
  });

  it("declines paths outside /api/design", async () => {
    const res = new FakeResponse() as unknown as FakeResponse & ServerResponse;
    assert.strictEqual(await handler(fakeRequest("GET", "/api/other"), res as unknown as ServerResponse, "/api/other"), false);
  });

  it("lists templates", async () => {
    const res = await call("GET", "/api/design/templates");
    assert.strictEqual(res.status, 200);
    const ids = ((res.json().templates as { id: string }[]).map((t) => t.id)).sort();
    assert.deepStrictEqual(ids, ["banner", "poster", "social_card"]);
  });

  it("creates, reads, updates, and deletes a brand kit", async () => {
    const created = await call("POST", "/api/design/brand-kits", { name: "Route Kit", colors: { primary: "#22aa55" } });
    assert.strictEqual(created.status, 200);
    const kit = created.json().kit as { id: string; name: string; colors: { primary: string } };
    assert.match(kit.id, /^kit_/);
    assert.strictEqual(kit.colors.primary, "#22aa55");

    const read = await call("GET", `/api/design/brand-kits/${kit.id}`);
    assert.strictEqual(read.status, 200);
    assert.strictEqual((read.json().kit as { name: string }).name, "Route Kit");

    const updated = await call("PUT", `/api/design/brand-kits/${kit.id}`, { name: "Route Kit 2" });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual((updated.json().kit as { name: string }).name, "Route Kit 2");

    const removed = await call("DELETE", `/api/design/brand-kits/${kit.id}`);
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.json().deleted, true);
    assert.strictEqual((await call("GET", `/api/design/brand-kits/${kit.id}`)).status, 404);
  });

  it("rejects an invalid brand kit and an oversized body", async () => {
    assert.strictEqual((await call("POST", "/api/design/brand-kits", { colors: { primary: "#111111" } })).status, 400);
    const big = await call("POST", "/api/design/brand-kits", { name: "x".repeat(70_000) });
    assert.strictEqual(big.status, 400);
  });

  it("generates a design and serves its raster", async () => {
    const gen = await call("POST", "/api/design/generate", { brief: "Poster for the weekend food fair" });
    assert.strictEqual(gen.status, 200);
    const design = gen.json().design as { id: string; svgFile: string };
    assert.match(design.id, /^design_/);
    assert.ok(fs.existsSync(design.svgFile));

    const image = await call("GET", `/api/design/outputs/${design.id}/image`);
    assert.strictEqual(image.status, 200);
    assert.match(String(image.headers["content-type"]), /^image\//);
    assert.ok(image.body().length > 0);

    const listed = await call("GET", "/api/design/outputs?limit=5");
    assert.strictEqual(listed.status, 200);
    assert.ok((listed.json().designs as unknown[]).length >= 1);
  });

  it("returns 400 for an empty brief and 404 for an unknown design", async () => {
    assert.strictEqual((await call("POST", "/api/design/generate", { brief: "   " })).status, 400);
    assert.strictEqual((await call("GET", "/api/design/outputs/design_missing")).status, 404);
  });
});
