import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it, before, after } from "node:test";

interface Captured {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) captured.headers = { ...captured.headers, ...headers };
      return res;
    },
    end(text?: string) {
      captured.body = text === undefined ? undefined : String(text);
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

function fakeReq(method: string): http.IncomingMessage {
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  req.method = method;
  return req;
}

describe("docs routes (N22)", () => {
  let tmpDir = "";

  before(() => {
    // The route resolves `docs/neo` from ROOT, which `config.ts` derives from its
    // own location. Point `LOAM_ROOT` at a scratch tree carrying the real guide,
    // so the fixture is the real `docs/neo` set without depending on the repo's
    // own working tree being present at test time.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-docs-routes-"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "loam" }), "utf8");
    const dir = path.join(tmpDir, "docs", "neo");
    fs.mkdirSync(dir, { recursive: true });
    const files: Record<string, string> = {
      "README.md": "# Loam long-horizon guide (EN)\n\n## 1. What it covers\n\nSee [canvas.md](canvas.md).\n\nRelated: [missions.md](missions.md)\n",
      "README.ar.md": "# دليل لُوام للمهام الطويلة (عربي)\n\n## ١. ماذا يغطي\n\nراجع [canvas.md](canvas.md).\n\nRelated: [missions.md](missions.md)\n",
      "canvas.md": "# Canvas\n\n## What you are looking at\n\nA graph.\n\nRelated: [README.md](README.md)\n",
      "canvas.ar.md": "# اللوحة\n\n## ما الذي تراه\n\nرسم بياني.\n\nRelated: [README.md](README.md)\n",
      "recipe.md": "# Recipe\n\n## What the Recipe is\n\nSteps.\n\nRelated: [canvas.md](canvas.md)\n",
      "recipe.ar.md": "# الوصفة\n\n## ما هي الوصفة\n\nخطوات.\n\nRelated: [canvas.md](canvas.md)\n",
      "knowledge-garden.md": "# Knowledge Garden\n\n## Bases and seeds\n\nSeeds.\n\nRelated: [canvas.md](canvas.md)\n",
      "knowledge-garden.ar.md": "# حديقة المعرفة\n\n## القواعد والبذور\n\nبذور.\n\nRelated: [canvas.md](canvas.md)\n",
      "missions.md": "# Missions\n\n## Why a Mission exists\n\nBudgets.\n\nRelated: [canvas.md](canvas.md)\n",
      "missions.ar.md": "# المهمات\n\n## لماذا توجد المهمة\n\nميزانيات.\n\nRelated: [canvas.md](canvas.md)\n",
    };
    for (const [file, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), body, "utf8");
    }
    process.env.LOAM_ROOT = tmpDir;
    delete process.env.MANUS_LOCAL_DATA_DIR;
  });

  after(() => {
    delete process.env.LOAM_ROOT;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("leaves unrelated paths unhandled", async () => {
    const { handleDocsRoutes } = await import("../routes/docs.js");
    const { res } = fakeRes();
    assert.equal(await handleDocsRoutes(fakeReq("GET"), res, "/api/agents"), false);
  });

  it("GET /api/docs lists every subject with its Arabic twin", async () => {
    const { handleDocsRoutes } = await import("../routes/docs.js");
    const { res, captured } = fakeRes();
    assert.equal(await handleDocsRoutes(fakeReq("GET"), res, "/api/docs"), true);
    assert.equal(captured.status, 200);
    const body = JSON.parse(captured.body ?? "{}") as {
      docs: Array<{ subject: string; file: string; arabicFile: string | null; arabicTitle: string | null }>;
    };
    assert.equal(body.docs.length, 5, "five subjects, one entry each");
    const canvas = body.docs.find((d) => d.subject === "canvas");
    assert.ok(canvas, "canvas entry present");
    assert.equal(canvas.file, "canvas.md");
    assert.equal(canvas.arabicFile, "canvas.ar.md");
    assert.equal(canvas.arabicTitle, "اللوحة");
  });

  it("GET /api/docs/:file returns one page's Markdown with its locale", async () => {
    const { handleDocsRoutes } = await import("../routes/docs.js");
    const { res, captured } = fakeRes();
    assert.equal(await handleDocsRoutes(fakeReq("GET"), res, "/api/docs/canvas.md"), true);
    assert.equal(captured.status, 200);
    assert.equal(captured.headers?.["content-language"], "en");
    assert.match(captured.body ?? "", /# Canvas/);

    const ar = fakeRes();
    await handleDocsRoutes(fakeReq("GET"), ar.res, "/api/docs/canvas.ar.md");
    assert.equal(ar.captured.status, 200);
    assert.equal(ar.captured.headers?.["content-language"], "ar");
    assert.match(ar.captured.body ?? "", /# اللوحة/);
  });

  it("rejects a file that is not part of the guide", async () => {
    const { handleDocsRoutes } = await import("../routes/docs.js");
    const { res, captured } = fakeRes();
    assert.equal(await handleDocsRoutes(fakeReq("GET"), res, "/api/docs/../../package.json"), true);
    assert.equal(captured.status, 404);
    const absolute = fakeRes();
    await handleDocsRoutes(fakeReq("GET"), absolute.res, "/api/docs/C:/Windows/win.ini");
    assert.equal(absolute.captured.status, 404);
    const unknown = fakeRes();
    await handleDocsRoutes(fakeReq("GET"), unknown.res, "/api/docs/nope.md");
    assert.equal(unknown.captured.status, 404);
  });

  it("refuses non-GET methods", async () => {
    const { handleDocsRoutes } = await import("../routes/docs.js");
    const { res, captured } = fakeRes();
    assert.equal(await handleDocsRoutes(fakeReq("POST"), res, "/api/docs"), true);
    assert.equal(captured.status, 405);
  });

  it("sends one anchor per section heading, in the same order", async () => {
    const { handleDocsRoutes } = await import("../routes/docs.js");
    const { res, captured } = fakeRes();
    await handleDocsRoutes(fakeReq("GET"), res, "/api/docs");
    const body = JSON.parse(captured.body ?? "{}") as {
      docs: Array<{ subject: string; sections: string[]; anchors: string[] }>;
    };
    const canvas = body.docs.find((d) => d.subject === "canvas");
    assert.ok(canvas);
    // The page title counts as a section, so the first anchor is the title's.
    assert.deepEqual(canvas.sections, ["Canvas", "What you are looking at"]);
    assert.deepEqual(canvas.anchors, ["canvas", "what-you-are-looking-at"]);
    // The UI must not re-derive these, so the count must always match.
    for (const entry of body.docs) {
      assert.equal(
        entry.anchors.length,
        entry.sections.length,
        `${entry.subject} sends one anchor per section`,
      );
      assert.ok(entry.anchors.every((anchor) => anchor.length > 0), `${entry.subject} has no empty anchor`);
    }
  });

  it("docsLocale reads the locale off the file name", async () => {
    const { docsLocale } = await import("../routes/docs.js");
    assert.equal(docsLocale("canvas.md"), "en");
    assert.equal(docsLocale("canvas.ar.md"), "ar");
    assert.equal(docsLocale("README.md"), "en");
    assert.equal(docsLocale("README.ar.md"), "ar");
  });
});
