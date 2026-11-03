/**
 * int-f3 regression: on desktop the renderer's studio iframes point at the
 * protocol adapter's origin (the same origin used for /api/*), so plain GET
 * page requests — /office-preview.html and its asset siblings — must reach the
 * Loam server's static handler through the adapter. Before the fix the adapter
 * answered every non-/api path with a literal 404 "not found", so the desktop
 * studio panel never rendered a document preview.
 *
 * Drives the real adapter on an ephemeral port against a stub Loam server.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { startProtocolAdapter, type ProtocolAdapter } from "../adapter.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-studio-pages-"));
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
process.env.LOAM_AUTH_DISABLED = "true";

const STUDIO_PAGE = "<!doctype html><title>studio</title><p>studio page ok</p>";

/** Stub of the main Loam server: serves the studio page, 404s the rest. */
const stubServer = http.createServer((req, res) => {
  const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (req.method === "GET" && (p === "/office-preview.html" || p === "/creative-render.html" || p === "/office-preview-entry.js")) {
    res.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" }).end(STUDIO_PAGE);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("loam-server 404");
});

let adapter: ProtocolAdapter | undefined;

before(async () => {
  await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
  const stubPort = (stubServer.address() as { port: number }).port;
  process.env.LOAM_PORT = String(stubPort);
  adapter = await startProtocolAdapter({
    cfg: { model: "test-model", workspace: process.cwd(), policy: { networkEnabled: false } } as never,
    runTask: (async () => ({ taskId: "t", text: "" })) as never,
    getTask: () => undefined,
    port: 0,
  });
});

after(async () => {
  await adapter?.close();
  adapter = undefined;
  await new Promise<void>((resolve) => stubServer.close(() => resolve()));
  delete process.env.LOAM_PORT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("protocol adapter studio page pass-through", () => {
  it("serves the studio page the renderer's iframe requests", async () => {
    const res = await fetch(`http://127.0.0.1:${adapter!.port}/office-preview.html?taskId=abc`);
    assert.equal(res.status, 200, "the studio page must load through the adapter");
    assert.equal(await res.text(), STUDIO_PAGE);
  });

  it("serves the page's asset siblings too", async () => {
    const res = await fetch(`http://127.0.0.1:${adapter!.port}/office-preview-entry.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
  });

  it("propagates the main server's 404 for unknown pages (not the adapter's literal one)", async () => {
    const res = await fetch(`http://127.0.0.1:${adapter!.port}/no-such-page.html`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "loam-server 404");
  });

  it("keeps non-GET non-API methods on the adapter's own 404", async () => {
    const res = await fetch(`http://127.0.0.1:${adapter!.port}/office-preview.html`, { method: "POST" });
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "not found");
  });

  it("keeps /api/health adapter-owned", async () => {
    const res = await fetch(`http://127.0.0.1:${adapter!.port}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { service?: string };
    assert.equal(body.service, "protocol-adapter");
  });
});
