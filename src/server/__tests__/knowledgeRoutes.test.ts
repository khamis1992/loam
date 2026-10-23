/**
 * Neo N3: Knowledge Garden HTTP surface.
 *
 * Exercises the full `/api/knowledge` surface end to end: base CRUD, text
 * import, per-seed add/retag/delete, and hybrid search. The route handler is
 * called directly (same harness style as wikiRoutes.test.ts) so the test covers
 * the real wiring without a network hop.
 *
 * The store keeps one `entities` row per base in the shared SQLite file, so the
 * test points the data dir at a temp folder before the store is first touched.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, it, before, after } from "node:test";
import type { KnowledgeRouteContext } from "../routes/knowledge.js";

let tmpDir = "";
let workspace = "";

/** Minimal shape of a decoded JSON response body; tests narrow it further. */
type Body = Record<string, unknown>;

interface Captured {
  status?: number;
  body?: Body;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(text?: unknown) {
      captured.body = text === undefined ? undefined : (JSON.parse(String(text)) as Body);
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: KnowledgeRouteContext,
) => Promise<boolean>;

let handleKnowledgeRoutes: Handler;
const embedder = {
  async embed(texts: string[]): Promise<number[][]> {
    // Deterministic fake embedding: one dimension per distinct token, so a
    // seed that shares tokens with the query lands closer than one that does not.
    const vectors: number[][] = [];
    for (const text of texts) {
      const tokens = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));
      vectors.push([...tokens].map((t) => (t.length % 7) + 1));
    }
    return vectors;
  },
};

async function call(
  method: string,
  p: string,
  body?: unknown,
  ctx: Partial<KnowledgeRouteContext> = {},
): Promise<Captured> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  req.method = method;
  // The handler reads req.url to parse query params, so pass the real target.
  req.url = p.startsWith("http") ? p : `http://127.0.0.1${p}`;
  const { res, captured } = fakeRes();
  const handled = await handleKnowledgeRoutes(req, res, p, {
    workspace,
    embedder,
    model: "fake-embed",
    ...ctx,
  } as KnowledgeRouteContext);
  assert.equal(handled, true, `${method} ${p} must be handled by the module`);
  return captured;
}

/** Assert the capture has a decoded body, so later accesses are non-null. */
function bodyOf(cap: Captured): Body {
  assert.ok(cap.body, "expected a decoded JSON body");
  return cap.body;
}

/** Seed a base with two distinct topics so search ranking is observable. */
async function seedGarden(baseId: string): Promise<void> {
  await call("POST", `/api/knowledge/${baseId}/ingest`, {
    text: "# Billing\nOur billing service charges per seat and invoices monthly.\n\n# Deploy\nThe deploy pipeline runs on GitHub Actions and is idempotent.",
    tags: ["billing"],
  });
  await call("POST", `/api/knowledge/${baseId}/ingest`, {
    text: "Kubernetes pods are scheduled by the control plane.",
    tags: ["infra"],
  });
}

describe("knowledge routes", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-knowledge-routes-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    workspace = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "notes.md"), "# Notes\nLocal markdown note about release process.\n");
    handleKnowledgeRoutes = (await import("../routes/knowledge.js")).handleKnowledgeRoutes;
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates, lists and reads a base", async () => {
    const created = await call("POST", "/api/knowledge", { name: "Product docs", description: "specs" });
    assert.equal(created.status, 201);
    const base = bodyOf(created).base as { id: string; name: string; seeds: number };
    assert.equal(base.name, "Product docs");
    assert.equal(base.seeds, 0);

    const list = await call("GET", "/api/knowledge");
    assert.equal(list.status, 200);
    const bases = bodyOf(list).bases as Array<{ id: string; name: string }>;
    assert.ok(bases.some((b) => b.id === base.id));

    const one = await call("GET", `/api/knowledge/${base.id}`);
    assert.equal(one.status, 200);
    assert.equal((bodyOf(one).base as { name: string }).name, "Product docs");
    assert.deepEqual(bodyOf(one).seeds, []);
  });

  it("rejects an unnamed base and a duplicate name", async () => {
    const blank = await call("POST", "/api/knowledge", { name: "   " });
    assert.equal(blank.status, 400);

    await call("POST", "/api/knowledge", { name: "Dup" });
    const dup = await call("POST", "/api/knowledge", { name: "Dup" });
    assert.equal(dup.status, 400);
    assert.match(String(bodyOf(dup).error), /already exists/);
  });

  it("imports inline text, splitting it into seeds", async () => {
    const created = await call("POST", "/api/knowledge", { name: "Import" });
    const baseId = (bodyOf(created).base as { id: string }).id;
    const cap = await call("POST", `/api/knowledge/${baseId}/ingest`, { text: "Alpha topic. Beta topic.", tags: ["misc"] });
    assert.equal(cap.status, 201);
    const seeds = bodyOf(cap).seeds as Array<{ id: string; title: string; body: string; tags: string[] }>;
    assert.ok(seeds.length >= 1, "expected at least one seed");
    assert.ok(seeds.every((s) => s.id && s.body));
    assert.deepEqual(seeds[0]!.tags, ["misc"]);
    assert.ok(bodyOf(cap).smartSplit === false, "no smart splitter wired => fixed fallback");
  });

  it("imports a workspace file by relative path", async () => {
    const created = await call("POST", "/api/knowledge", { name: "Files" });
    const baseId = (bodyOf(created).base as { id: string }).id;
    const cap = await call("POST", `/api/knowledge/${baseId}/ingest`, { path: "docs/notes.md" });
    assert.equal(cap.status, 201);
    const seeds = bodyOf(cap).seeds as Array<{ title: string; body: string }>;
    assert.ok(String(seeds[0]!.title).length > 0);
    assert.match(String(seeds[0]!.body), /release process/);
  });

  it("refuses a file import without a workspace", async () => {
    const created = await call("POST", "/api/knowledge", { name: "NoWorkspace" });
    const baseId = (bodyOf(created).base as { id: string }).id;
    const cap = await call("POST", `/api/knowledge/${baseId}/ingest`, { path: "docs/notes.md" }, { workspace: undefined });
    assert.equal(cap.status, 409);
  });

  it("reports 422 (not a crash) when nothing is extractable", async () => {
    const created = await call("POST", "/api/knowledge", { name: "Empty" });
    const baseId = (bodyOf(created).base as { id: string }).id;
    const unsupported = await call("POST", `/api/knowledge/${baseId}/ingest`, { path: "docs/photo.xyz" });
    assert.equal(unsupported.status, 422);
    assert.equal(bodyOf(unsupported).ok, false);
    assert.ok(Array.isArray(bodyOf(unsupported).warnings));
  });

  it("rejects an import that supplies two sources at once", async () => {
    const created = await call("POST", "/api/knowledge", { name: "TwoSources" });
    const baseId = (bodyOf(created).base as { id: string }).id;
    const cap = await call("POST", `/api/knowledge/${baseId}/ingest`, { text: "a", url: "https://example.com" });
    assert.equal(cap.status, 400);
    assert.match(String(bodyOf(cap).error), /exactly one/);
  });

  it("adds, retags and deletes a single seed", async () => {
    const created = await call("POST", "/api/knowledge", { name: "Seeds" });
    const baseId = (bodyOf(created).base as { id: string }).id;

    const added = await call("POST", `/api/knowledge/${baseId}/seeds`, { title: "Manual", body: "hand written note", tags: ["a", "a"] });
    assert.equal(added.status, 201);
    const seed = bodyOf(added).seed as { id: string; tags: string[] };
    assert.deepEqual(seed.tags, ["a"], "duplicate tags are normalized away");

    const retagged = await call("PUT", `/api/knowledge/${baseId}/seeds/${seed.id}`, { tags: ["b", "c"] });
    assert.equal(retagged.status, 200);
    assert.deepEqual((bodyOf(retagged).seed as { tags: string[] }).tags, ["b", "c"]);

    const deleted = await call("DELETE", `/api/knowledge/${baseId}/seeds/${seed.id}`);
    assert.equal(deleted.status, 200);
    const after = await call("GET", `/api/knowledge/${baseId}`);
    const seeds = bodyOf(after).seeds as Array<{ id: string }>;
    assert.ok(!seeds.some((s) => s.id === seed.id));
  });

  it("searches the garden and reports the ranking mode", async () => {
    const created = await call("POST", "/api/knowledge", { name: "Searchable" });
    const baseId = (bodyOf(created).base as { id: string }).id;
    await seedGarden(baseId);

    const cap = await call("GET", `/api/knowledge/search?query=${encodeURIComponent("billing invoice")}`);
    assert.equal(cap.status, 200);
    const hits = bodyOf(cap).hits as Array<{ seedId: string; title: string; score: number }>;
    assert.ok(hits.length > 0, "expected hits");
    assert.equal(bodyOf(cap).mode, "hybrid");
    assert.match(hits[0]!.title.toLowerCase(), /billing/);
    assert.ok(hits[0]!.score > 0);
  });

  it("falls back to lexical-only search when no embedder is wired", async () => {
    const created = await call("POST", "/api/knowledge", { name: "Lexical" });
    const baseId = (bodyOf(created).base as { id: string }).id;
    await seedGarden(baseId);
    const cap = await call(
      "GET",
      `/api/knowledge/search?query=${encodeURIComponent("kubernetes pods")}`,
      undefined,
      { embedder: undefined },
    );
    assert.equal(cap.status, 200);
    assert.equal(bodyOf(cap).mode, "lexical");
    const hits = bodyOf(cap).hits as Array<{ title: string }>;
    assert.match(String(hits[0]!.title).toLowerCase(), /kubernetes/);
  });

  it("returns 404 for an unknown base and leaves unrelated paths unhandled", async () => {
    const missing = await call("GET", "/api/knowledge/kb-does-not-exist");
    assert.equal(missing.status, 404);

    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = "GET";
    const { res } = fakeRes();
    assert.equal(await handleKnowledgeRoutes(req, res, "/api/agents"), false);
  });

  it("deletes a base together with its seeds", async () => {
    const created = await call("POST", "/api/knowledge", { name: "Disposable" });
    const baseId = (bodyOf(created).base as { id: string }).id;
    await call("POST", `/api/knowledge/${baseId}/ingest`, { text: "temporary content" });

    const deleted = await call("DELETE", `/api/knowledge/${baseId}`);
    assert.equal(deleted.status, 200);
    const again = await call("GET", `/api/knowledge/${baseId}`);
    assert.equal(again.status, 404);
  });

  it("classifies a caller's bad path as 400, never as a server fault", async () => {
    const created = await call("POST", "/api/knowledge", { name: "Path checks" });
    const baseId = (bodyOf(created).base as { id: string }).id;

    // Escaping the workspace is the caller's mistake: 400, not 500.
    const escape = await call("POST", `/api/knowledge/${baseId}/ingest`, { path: "../../../etc/hosts" });
    assert.equal(escape.status, 400, "workspace escape must be a 400");
    assert.match(String(bodyOf(escape).error), /outside workspace/);
    // The refusal must not leak the file's contents.
    assert.doesNotMatch(JSON.stringify(bodyOf(escape)), /root:x:/);

    // A missing file is reported as an unprocessable import (422), not a crash.
    const missing = await call("POST", `/api/knowledge/${baseId}/ingest`, { path: "nope.md" });
    assert.equal(missing.status, 422);
    assert.equal(bodyOf(missing).ok, false);

    // A malformed body is the caller's fault too.
    const req = Readable.from([Buffer.from("{not json")]) as unknown as http.IncomingMessage;
    req.method = "POST";
    req.url = `http://127.0.0.1/api/knowledge/${baseId}/ingest`;
    const { res, captured } = fakeRes();
    assert.equal(await handleKnowledgeRoutes(req, res, `/api/knowledge/${baseId}/ingest`, { workspace, embedder } as KnowledgeRouteContext), true);
    assert.equal(captured.status, 400, "malformed JSON must be a 400");
  });
});

describe("knowledge tool policy", () => {
  it("keeps the kb_* tool set in one place", async () => {
    const mod = await import("../knowledgeTools.js");
    assert.deepEqual(mod.KNOWLEDGE_TOOL_NAMES, ["kb_search", "kb_ingest", "kb_manage"]);
    assert.equal(mod.isKnowledgeTool("kb_search"), true);
    assert.equal(mod.isKnowledgeTool("read_file"), false);
    assert.deepEqual(
      mod.excludeKnowledgeTools(["kb_search", "read_file", "kb_manage"]),
      ["read_file"],
    );
  });

  it("is non-vacuous: the gateway actually hands kb_* to the run allowlist", async () => {
    // Regression guard for the N3 defect where the per-run toggle did nothing:
    // the `knowledge` service was granted by no work mode, so kb_* never entered
    // `capabilities.allow` and `excludeKnowledgeTools` filtered an empty set.
    const gateway = await import("../companionGateway.js");
    const policy = await import("../knowledgeTools.js");
    const registered = [...new Set(gateway.COMPANION_SERVICES.flatMap((service) => service.tools))];

    for (const workMode of gateway.WORK_MODES) {
      const resolved = gateway.resolveCompanionCapabilities({
        mode: "build",
        workMode: workMode.id,
        registeredTools: registered,
      });
      const kb = resolved.allow.filter(policy.isKnowledgeTool);
      assert.deepEqual(
        kb.slice().sort(),
        [...policy.KNOWLEDGE_TOOL_NAMES].sort(),
        `${workMode.id} must grant every kb_* tool, otherwise the per-run garden toggle is dead`,
      );
    }

    // The gate itself: same input, on keeps the garden tools, off strips them.
    const on = policy.applyKnowledgeGate(["file_read", "kb_search", "kb_ingest", "kb_manage"], true);
    const off = policy.applyKnowledgeGate(["file_read", "kb_search", "kb_ingest", "kb_manage"], false);
    assert.deepEqual(on, ["file_read", "kb_search", "kb_ingest", "kb_manage"]);
    assert.deepEqual(off, ["file_read"]);
  });
});
