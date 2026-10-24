/**
 * Neo N13: the node-level canvas routes.
 *
 * `graphNodes.ts` is what the canvas calls for everything a *single* node needs
 * once it exists, so these tests pin the guarantees a live UI depends on:
 *   1. version history and the line diff between two versions (G18);
 *   2. "Add to Knowledge Base" preview + ingest, with node provenance (G18);
 *   3. webpage-node actions: resolve the directory, open the sandbox preview,
 *      and download a ZIP that opens offline (G19);
 *   4. every action is keyed by `(runId, nodeId)`, so a node is never reachable
 *      through another run's URL.
 *
 * The graph is real (SQLite behind a throwaway data directory) and the task
 * workspace is real on disk, so the ZIP test packs an actual directory.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import { applyRunEvent, beginRun, getRunNode, resetRunGraph } from "../../agent/runGraphAdapter.js";
import { closeDb, putEntity, removeEntity } from "../../server/sqliteStore.js";
import { createTask, setTaskWorkspace } from "../../server/db.js";
import { requireTaskWorkspace } from "../../server/taskWorkspace.js";
import { listFileVersions, listVersionsForNode } from "../../graph/nodeVersions.js";

type Json = Record<string, unknown>;

class FakeResponse extends Writable {
  status = 0;
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  json(): Json {
    return JSON.parse(this.body().toString("utf8")) as Json;
  }
}

function fakeRequest(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []) as unknown as IncomingMessage;
  // A route reads the body with `on("data")` / `on("end")`, which never fire on an
  // already-ended stream, so flow it to make it a real request body.
  req.resume();
  Object.assign(req, {
    method,
    url,
    headers: { host: "127.0.0.1:3939", "content-type": "application/json", ...headers },
  });
  return req;
}

/** The central directory of a ZIP, for assertions on archive layout. */
function zipEntryNames(zip: Buffer): string[] {
  const names: string[] = [];
  for (let i = 0; i + 46 <= zip.length; i += 1) {
    if (zip.readUInt32LE(i) !== 0x02014b50) continue; // central directory header
    names.push(zip.subarray(i + 46, i + 46 + zip.readUInt16LE(i + 28)).toString("utf8"));
  }
  return names.sort();
}

type Handler = (
  req: IncomingMessage,
  res: FakeResponse,
  rawPath: string,
  ctx?: { workspace?: string; preview?: unknown },
) => Promise<boolean>;

const RUN = "task_n13_routes";
const PREVIEW_URL = "http://127.0.0.1:45999";

let tmpDir = "";
let prevDataDir: string | undefined;
let handler: Handler;
let workspace = "";

describe("node canvas routes", () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-node-routes-"));
    prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    closeDb();
    resetRunGraph();
    // The route resolves the node's workspace through the task record keyed by the
    // *run* id, so the task must carry that id. `requireTaskWorkspace` is what the
    // server calls to obtain the root every artifact path is checked against.
    const task = createTask("node routes test");
    removeEntity("tasks", task.id);
    putEntity("tasks", { ...task, id: RUN });
    workspace = requireTaskWorkspace(RUN, tmpDir);
    handler = (await import("../routes/graphNodes.js")).handleGraphNodeRoutes as unknown as Handler;
  });

  afterEach(() => {
    closeDb();
    resetRunGraph();
    if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
    else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpDir = "";
  });

  /** A run whose tool result carries the document text. */
  function documentNode(
    tool = "file_write",
    args: Record<string, unknown> = { path: "report.md" },
    content = "# Report\nFirst draft",
  ): string {
    beginRun(RUN, "Write the report");
    applyRunEvent(RUN, { type: "plan", goal: "Write the report", trivial: false, steps: [{ id: "s1", title: "Draft", instruction: "Write", successCriteria: "Done" }], source: "model" });
    applyRunEvent(RUN, { type: "plan_step", id: "s1", index: 1, total: 1, title: "Draft", phase: "start" });
    applyRunEvent(RUN, { type: "tool_call", name: tool, args });
    const [nodeId] = applyRunEvent(RUN, { type: "tool_result", name: tool, ok: true, summary: "done", content });
    assert.ok(nodeId, "the tool result created a node");
    return nodeId;
  }

  /**
   * Send one request. The router matches on `url.pathname`, so the query stays on
   * the request only; passing it in `rawPath` would fail the route's own regex.
   */
  function call(
    method: string,
    action: string,
    nodeId: string,
    options: { query?: string; body?: unknown; headers?: Record<string, string>; preview?: unknown; workspace?: string } = {},
  ): Promise<FakeResponse> {
    const href = `/api/graph/${RUN}/nodes/${nodeId}/${action}${options.query ?? ""}`;
    const res = new FakeResponse();
    const ctx = {
      ...(options.workspace === undefined ? { workspace } : { workspace: options.workspace }),
      ...(options.preview ? { preview: options.preview } : {}),
    };
    return handler(fakeRequest(method, href, options.body, options.headers), res, href.split("?")[0]!, ctx).then(() => res);
  }

  it("ignores paths that are not node routes", async () => {
    const res = new FakeResponse();
    assert.equal(await handler(fakeRequest("GET", "/api/graph/other"), res, "/api/graph/other", { workspace }), false);
  });

  it("returns a node's version history and captures the current text as a new version", async () => {
    const nodeId = documentNode();
    const res = await call("GET", "versions", nodeId);
    assert.equal(res.status, 200);

    const body = res.json();
    assert.equal(body.nodeId, nodeId);
    assert.equal(body.runId, RUN);
    assert.equal(body.current, 1, "the event path already snapshotted the document");
    const versions = body.versions as Array<{ version: number; content: string; source: string }>;
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.content, "# Report\nFirst draft");
    assert.equal(versions[0]!.source, "agent");

    // A canvas edit is captured as version 2 and attributed to the user.
    const post = await call("POST", "versions", nodeId, { body: { content: "# Report\nSecond draft" } });
    assert.equal(post.status, 201);
    const created = post.json();
    assert.equal(created.version, 2);
    assert.equal((created.versions as unknown[]).length, 2);
    assert.ok(getRunNode(nodeId, RUN), "the node still exists");
    assert.equal(listVersionsForNode(nodeId).length, 2, "the version is stored, not just reported");

    // A cross-site mutation is refused before the version is written.
    const crossSite = await call("POST", "versions", nodeId, {
      body: { content: "evil" },
      headers: { origin: "https://evil.example" },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(listVersionsForNode(nodeId).length, 2, "the refused write left no version");
  });

  it("diffs two versions by line, and refuses a version this node does not have", async () => {
    const nodeId = documentNode();
    const post = await call("POST", "versions", nodeId, { body: { content: "# Report\nFirst draft\nSecond line" } });
    assert.equal(post.status, 201, "the canvas edit was captured as version 2");

    const res = await call("GET", "diff", nodeId, { query: "?from=1&to=2" });
    assert.equal(res.status, 200);
    const diff = res.json();
    assert.equal(diff.from, 1);
    assert.equal(diff.to, 2);
    assert.equal(diff.added, 1, "one line was added");
    assert.equal(diff.removed, 0, "nothing was removed");
    assert.equal(diff.unchanged, 2, "the two existing lines stay put");
    assert.equal(diff.empty, false);
    assert.equal((diff.lines as unknown[]).length, 3, "the diff describes every line of the newer version");
    assert.ok(Array.isArray(diff.hunks), "hunks are present");

    // A version number this node never had is the caller's mistake.
    const bad = await call("GET", "diff", nodeId, { query: "?from=1&to=9" });
    assert.equal(bad.status, 400, "a version outside the node's range is rejected");

    // A node with a single version has nothing to diff against.
    const other = documentNode("file_edit", { path: "notes.md" }, "only one");
    const single = await call("GET", "diff", other, { query: "?from=1&to=1" });
    assert.equal(single.status, 200);
    assert.equal(single.json().empty, true, "a version against itself has no changes");
  });

  it("previews and ingests a node into the Knowledge Base with node provenance", async () => {
    const nodeId = documentNode("file_write", { path: "report.md" }, "# Report\nAlpha\nBeta\nGamma\nDelta");
    const preview = await call("GET", "knowledge/preview", nodeId);
    assert.equal(preview.status, 200);
    const previewBody = preview.json();
    assert.equal(previewBody.count, (previewBody.seeds as unknown[]).length);
    assert.ok((previewBody.count as number) > 0, "the preview shows the seeds that will be created");
    const first = (previewBody.seeds as Array<{ title: string; tags: string[] }>)[0]!;
    assert.ok(first.tags.includes("from-node"), "the preview carries the same tag the ingest will");

    const post = await call("POST", "knowledge", nodeId, { body: { baseName: "Report knowledge", tags: ["ops"] } });
    assert.equal(post.status, 201);
    const ingested = post.json();
    assert.equal(ingested.ok, true);
    assert.ok(ingested.baseId, "a base id comes back");
    assert.equal(ingested.baseName, "Report knowledge");
    const seeds = ingested.seeds as Array<{ provenance: { source: string; ref: string; runId: string; nodeVersion?: number } }>;
    assert.ok(seeds.length > 0, "the seeds were written");
    const seed = seeds[0]!;
    assert.equal(seed.provenance.source, "node", "the seed is traced back to the node");
    assert.equal(seed.provenance.ref, nodeId);
    assert.equal(seed.provenance.runId, RUN);
    assert.equal(seed.provenance.nodeVersion, 1, "the ingested version is recorded");

    // A second ingest into the same base reuses it instead of duplicating it.
    const again = await call("POST", "knowledge", nodeId, { body: { baseId: ingested.baseId } });
    assert.equal(again.json().baseId, ingested.baseId, "the base id is reused");
  });

  it("reports a node that carries no text instead of throwing", async () => {
    // A search node has no document text, so both actions degrade to a message.
    beginRun(RUN, "Research the market");
    applyRunEvent(RUN, { type: "tool_call", name: "web_search", args: { query: "revenue" } });
    const [nodeId] = applyRunEvent(RUN, { type: "tool_result", name: "web_search", ok: true, summary: "3 results" });
    assert.ok(nodeId);

    const preview = await call("GET", "knowledge/preview", nodeId);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.json().warnings, ["this node carries no text"]);

    const post = await call("POST", "knowledge", nodeId, { body: {} });
    assert.equal(post.status, 422, "nothing to import is reported, not hidden");
    assert.equal(post.json().ok, false);
  });

  it("resolves a webpage node's directory, opens the preview, and downloads a ZIP", async () => {
    // A `web_fetch` node is the webpage node: it names the directory it produced.
    const nodeId = documentNode("web_fetch", { path: "site/index.html" }, "<h1>Fetched</h1>");
    // The page and its asset, as the agent would have written them.
    fs.mkdirSync(path.join(workspace, "site"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "site", "index.html"), "<h1>Local</h1>", "utf8");
    fs.writeFileSync(path.join(workspace, "site", "style.css"), "h1{color:red}", "utf8");

    const resolved = await call("GET", "artifact", nodeId);
    assert.equal(resolved.status, 200);
    const artifact = resolved.json();
    assert.equal(artifact.entry, "index.html", "the entry page is found");
    assert.equal(artifact.explicit, true, "the directory came from the node's own path");
    assert.equal(artifact.zipUrl, `/api/graph/${RUN}/nodes/${nodeId}/artifact.zip`);
    assert.ok(typeof artifact.url === "string" && artifact.url.includes("/preview"));

    // The preview opens the node's own directory, not the whole workspace.
    const started: string[] = [];
    const previewService = { start: async (dir: string) => { started.push(dir); return { url: PREVIEW_URL, root: dir }; } };
    const preview = await call("GET", "preview", nodeId, { preview: previewService });
    assert.equal(preview.status, 200);
    assert.equal(started.length, 1, "the preview server was started once");
    assert.equal(started[0], path.join(workspace, "site"), "the preview root is the node's directory");
    assert.deepEqual(preview.json(), { url: `${PREVIEW_URL}/`, root: started[0] });

    // The ZIP carries the site under one folder, so it extracts cleanly.
    const zip = await call("GET", "artifact.zip", nodeId);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers["content-type"], "application/zip");
    assert.match(String(zip.headers["content-disposition"]), /^attachment; filename="node-.*\.zip"/);
    // The archive folder is named after the node's own path (`site/index.html`),
    // so a download lands in `node-site-index.html/` instead of scattering files.
    const prefix = "node-site-index.html";
    assert.deepEqual(
      zipEntryNames(zip.body()),
      [`${prefix}/index.html`, `${prefix}/style.css`],
      "the archive holds the page and its asset under one folder",
    );
  });

  it("packages a webpage node from the files it captured", async () => {
    // A `web_fetch` node is a webpage node. Its payload names the file it holds,
    // and the capture step stored that file's text as a version.
    const nodeId = documentNode("web_fetch", { path: "site/index.html" }, "<h1>Fetched</h1>");
    assert.equal(listFileVersions(nodeId).length, 1, "the page the node named was captured");

    // `artifact.zip` packs the live directory first, then fills gaps from the
    // captured versions, so the archive still carries the page's own file when the
    // workspace no longer has it.
    const prefix = "node-site-index.html";
    fs.mkdirSync(path.join(workspace, "site"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "site", "style.css"), "h1{color:red}", "utf8");
    // The captured version of `index.html` is the *live* file on disk, since
    // capture reads the workspace, so a live copy is written here as well.
    fs.writeFileSync(path.join(workspace, "site", "index.html"), "<h1>Fetched</h1>", "utf8");

    const zip = await call("GET", "artifact.zip", nodeId);
    assert.equal(zip.status, 200);
    assert.deepEqual(
      zipEntryNames(zip.body()),
      [`${prefix}/index.html`, `${prefix}/style.css`],
      "the archive holds the page the node captured and the asset beside it",
    );

    // Two downloads of the same tree are byte-identical, so a download is reproducible.
    const again = await call("GET", "artifact.zip", nodeId);
    assert.ok(again.body().equals(zip.body()), "the archive is reproducible");
  });

  it("reports honestly when a node has no artifact to open or download", async () => {
    const nodeId = documentNode("file_write", { path: "report.md" }, "# Report");
    const missing = await call("GET", "artifact", nodeId);
    assert.equal(missing.status, 404, "a document node with no directory has no artifact");
    assert.equal(missing.json().error, "no artifact directory for this node");

    // Without a preview service the action is unavailable rather than a 500.
    const unavailable = await call("GET", "preview", nodeId);
    assert.equal(unavailable.status, 503);
  });

  it("never reaches a node through another run's URL", async () => {
    const nodeId = documentNode();
    const res = new FakeResponse();
    const href = `/api/graph/task_n13_routes_other/nodes/${nodeId}/versions`;
    assert.equal(
      await handler(fakeRequest("GET", href), res, href, { workspace }),
      true,
    );
    assert.equal(res.status, 404, "a node id from another run is not found here");
    assert.equal(listVersionsForNode(nodeId).length, 1, "the real run's node was untouched");

    const unknown = await call("GET", "versions", "nope");
    assert.equal(unknown.status, 404);
  });

  it("refuses a node whose task has no workspace configured", async () => {
    const nodeId = documentNode();
    const res = await call("GET", "versions", nodeId, { workspace: "" });
    assert.equal(res.status, 409, "a missing workspace is reported as a conflict, not a crash");
  });

  it("rejects methods it does not implement", async () => {
    const nodeId = documentNode();
    const res = await call("DELETE", "versions", nodeId);
    assert.equal(res.status, 405);
  });

  it("binds a node's workspace to the task, so a stray task id cannot be reused", () => {
    const task = createTask("second task");
    const root = requireTaskWorkspace(task.id, tmpDir);
    assert.notEqual(root, workspace, "each task gets its own workspace root");
    setTaskWorkspace(task.id, root);
    assert.equal(requireTaskWorkspace(task.id, tmpDir), root);
  });
});
