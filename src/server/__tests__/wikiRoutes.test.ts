import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let workspace = "";

interface Captured {
  status?: number;
  body?: unknown;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(text?: unknown) {
      captured.body = text === undefined ? undefined : JSON.parse(String(text));
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

const fakeModel = {
  async chat(opts: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }> {
    const prompt = opts.messages.map((m) => m.content).join("\n");
    return { content: /Question:/.test(prompt) ? "The entry point is src/index.ts:1." : "Fake prose." };
  },
};

async function call(method: string, p: string, body?: unknown): Promise<Captured> {
  const { handleWikiRoutes } = await import("../routes/wiki.js");
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  req.method = method;
  const { res, captured } = fakeRes();
  const handled = await handleWikiRoutes(req, res, p, { workspace, ollama: fakeModel, model: "fake-model" });
  assert.equal(handled, true, `${method} ${p} must be handled by the module`);
  return captured;
}

describe("wiki routes", () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wiki-routes-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    workspace = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".loam"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "index.ts"), "export function main(): void {\n  console.log(1);\n}\n");
    fs.writeFileSync(
      path.join(workspace, ".loam", "wiki.json"),
      JSON.stringify({ project: "route-wiki", pages: [{ title: "Custom", purpose: "A custom page" }] }),
    );
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("POST /api/wiki/:project/generate builds and stores a wiki", async () => {
    const cap = await call("POST", "/api/wiki/route-wiki/generate");
    assert.equal(cap.status, 200);
    const wiki = (cap.body as { wiki: { project: string; pages: Array<{ title: string }> } }).wiki;
    assert.equal(wiki.project, "route-wiki");
    const titles = wiki.pages.map((p) => p.title);
    assert.ok(titles.includes("Overview"));
    assert.ok(titles.includes("Architecture"));
    assert.ok(titles.includes("src"));
    assert.ok(titles.includes("Custom"));
    assert.ok(fs.existsSync(path.join(tmpDir, "wikis", "route-wiki", "index.json")));
  });

  it("GET /api/wiki lists projects and pages", async () => {
    await call("POST", "/api/wiki/route-wiki/generate");
    const cap = await call("GET", "/api/wiki");
    assert.equal(cap.status, 200);
    const wikis = (cap.body as { wikis: Array<{ project: string; pages: Array<{ title: string }> }> }).wikis;
    const found = wikis.find((w) => w.project === "route-wiki");
    assert.ok(found, "route-wiki not listed");
    assert.ok(found.pages.some((p) => p.title === "Overview"));
  });

  it("GET /api/wiki/:project returns the page list", async () => {
    await call("POST", "/api/wiki/route-wiki/generate");
    const cap = await call("GET", "/api/wiki/route-wiki");
    assert.equal(cap.status, 200);
    const data = cap.body as { project: string; pages: Array<{ title: string; slug: string }> };
    assert.equal(data.project, "route-wiki");
    assert.ok(data.pages.length >= 4);
  });

  it("GET /api/wiki/:project/:slug returns one page", async () => {
    await call("POST", "/api/wiki/route-wiki/generate");
    const cap = await call("GET", "/api/wiki/route-wiki/overview");
    assert.equal(cap.status, 200);
    const page = (cap.body as { page: { title: string; content: string } }).page;
    assert.equal(page.title, "Overview");
    assert.match(page.content, /Source links/);
  });

  it("returns 404 for an unknown project or page", async () => {
    const missingProject = await call("GET", "/api/wiki/nope");
    assert.equal(missingProject.status, 404);
    await call("POST", "/api/wiki/route-wiki/generate");
    const missingPage = await call("GET", "/api/wiki/route-wiki/does-not-exist");
    assert.equal(missingPage.status, 404);
  });

  it("rejects a generate call without a model client", async () => {
    const { handleWikiRoutes } = await import("../routes/wiki.js");
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = "POST";
    const { res, captured } = fakeRes();
    const handled = await handleWikiRoutes(req, res, "/api/wiki/route-wiki/generate", { workspace });
    assert.equal(handled, true);
    assert.equal(captured.status, 409);
  });

  it("leaves unrelated paths unhandled", async () => {
    const { handleWikiRoutes } = await import("../routes/wiki.js");
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = "GET";
    const { res } = fakeRes();
    assert.equal(await handleWikiRoutes(req, res, "/api/agents"), false);
  });
});
