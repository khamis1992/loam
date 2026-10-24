import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

let dir: string;
let server: http.Server;
let base: string;
const cfg = { workspace: "", wiki: { enabled: false } } as { workspace: string; wiki?: { enabled: boolean } };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wikiroutes-"));
  process.env.MANUS_LOCAL_DATA_DIR = dir;
  cfg.workspace = path.join(dir, "ws");
  const { handleProjectWikiRoutes } = await import("../../server/routes/projectWiki.js");
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!(await handleProjectWikiRoutes(req, res, url.pathname, url, cfg as never))) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  (await import("../handoff.js")).closeHandoffs();
  (await import("../wikiIndex.js")).closeIndex();
  fs.rmSync(dir, { recursive: true, force: true });
});

const json = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("project wiki routes", () => {
  it("is disabled by default and can be switched on", async () => {
    assert.equal((await json("GET", "/api/project-wiki/status")).body.enabled, false);
    assert.equal((await json("GET", "/api/project-wiki/pages")).status, 409);
    assert.equal((await json("PUT", "/api/project-wiki/status", { enabled: "yes" })).status, 400);
    assert.equal((await json("PUT", "/api/project-wiki/status", { enabled: true })).body.enabled, true);
  });
  it("lists and reads pages, resolves a handoff once", async () => {
    const { writePage } = await import("../store.js");
    const { createHandoff } = await import("../handoff.js");
    const { wikiRoot } = await import("../paths.js");
    const root = wikiRoot(cfg.workspace);
    writePage(root, { kind: "note", id: "deploy", title: "Deploy", body: "run the release script", tags: [] });
    const h = createHandoff(root, { title: "Resume", body: "todo" });
    const pages = (await json("GET", "/api/project-wiki/pages?kind=note")).body.pages as { id: string }[];
    assert.equal(pages[0]?.id, "deploy");
    assert.equal((await json("GET", "/api/project-wiki/page?kind=note&id=deploy")).status, 200);
    assert.equal((await json("GET", "/api/project-wiki/page?kind=note&id=nope")).status, 404);
    assert.equal(((await json("GET", "/api/project-wiki/search?q=release")).body.hits as unknown[]).length > 0, true);
    assert.equal((await json("POST", `/api/handoffs/${h.id}`, { to: "accepted" })).status, 200);
    assert.equal((await json("POST", `/api/handoffs/${h.id}`, { to: "dismissed" })).status, 409);
  });
});
