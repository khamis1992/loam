/**
 * Harness2 (H8/H9): learned-lesson REST surface.
 *
 * Exercises the `/api/learning/lessons` and `/api/learning/corrections` routes
 * end to end against a real (temp) store: seed a lesson through the H2
 * experience store, then read it back over the route, strip-check the vector
 * fields, PATCH the disabled flag, DELETE it, and confirm the 404s.
 *
 * The route handler is called directly (same harness style as
 * knowledgeRoutes.test.ts) so the test covers the real wiring without a
 * network hop. The store keeps one `entities` row per lesson in the shared
 * SQLite file, so the data dir is pointed at a temp folder before the store is
 * first touched.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { LearningRouteContext } from "../routes/learning.js";

let tmpDir = "";

type Body = Record<string, unknown>;

interface Captured {
  status?: number;
  body?: Body;
  rawBody?: string;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(text?: unknown) {
      captured.rawBody = text === undefined ? undefined : String(text);
      captured.body = text === undefined ? undefined : (JSON.parse(String(text)) as Body);
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: LearningRouteContext,
) => Promise<boolean>;

let handleLearningRoutes: Handler;
let store: typeof import("../../learning/harness/experienceStore.js");

/** Seed one lesson through the real H2 store (the same writer the agent uses). */
async function seedLesson(overrides: Partial<{ domain: string; lesson: string; confidence: "low" | "medium" | "high" }> = {}) {
  return store.addLesson({
    agentId: null,
    domain: overrides.domain ?? "nutrio-content",
    source: "correction",
    sourceRef: "cor_test",
    d: {
      cue: "when writing Arabic content about the app",
      lesson: overrides.lesson ?? "Write the name «نتريو» in Arabic, not Nutrio.",
      evidence: "the user corrected the spelling of the name",
      confidence: overrides.confidence ?? "high",
    },
  });
}

async function call(
  method: string,
  p: string,
  body?: unknown,
  ctx: LearningRouteContext = {},
): Promise<Captured> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  req.method = method;
  // The handler reads req.url to parse query params, so pass the real target.
  req.url = p.startsWith("http") ? p : `http://127.0.0.1${p}`;
  const { res, captured } = fakeRes();
  const handled = await handleLearningRoutes(req, res, p, ctx);
  assert.equal(handled, true, `${method} ${p} must be handled by the module`);
  return captured;
}

function bodyOf(cap: Captured): Body {
  assert.ok(cap.body, "expected a decoded JSON body");
  return cap.body;
}

/** Narrow a lesson payload out of `{ data: Lesson }` / `{ data: Lesson[] }`. */
function lessonOf(cap: Captured): Body {
  return bodyOf(cap).data as Body;
}

describe("learning routes", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-learning-routes-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    handleLearningRoutes = (await import("../routes/learning.js")).handleLearningRoutes;
    store = await import("../../learning/harness/experienceStore.js");
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("lists seeded lessons and strips the embedding vector", async () => {
    await seedLesson();
    const cap = await call("GET", "/api/learning/lessons");
    assert.equal(cap.status, 200);
    const data = bodyOf(cap).data as Body[];
    assert.ok(Array.isArray(data) && data.length >= 1, "expected at least the seeded lesson");

    const row = data.find((l) => l.domain === "nutrio-content");
    assert.ok(row, "the seeded lesson must be listed");
    assert.equal(row.lesson, "Write the name «نتريو» in Arabic, not Nutrio.");
    assert.equal(row.source, "correction");
    // Section 8: vector fields are never shipped to the browser.
    assert.equal("vector" in row, false);
    assert.equal("dim" in row, false);
  });

  it("filters by domain and by agentId", async () => {
    const byDomain = await call("GET", "/api/learning/lessons?domain=general");
    assert.equal(byDomain.status, 200);
    const rows = bodyOf(byDomain).data as Body[];
    assert.ok(rows.every((l) => l.domain === "general"));

    // No agentId => the route context scopes the caller.
    const scoped = await call("GET", "/api/learning/lessons", undefined, { agentId: "agent-none" });
    assert.equal(scoped.status, 200);
    const scopedRows = bodyOf(scoped).data as Body[];
    // agentId=null lessons are global, so they are always visible.
    assert.ok(scopedRows.length >= 1);
    assert.ok(scopedRows.every((l) => l.agentId === null || l.agentId === "agent-none"));
  });

  it("patches the disabled flag and returns the updated lesson", async () => {
    const created = await seedLesson({ lesson: "Confirm the path before writing." });
    assert.ok(created);
    const id = created!.id;

    const cap = await call("PATCH", `/api/learning/lessons/${id}`, { disabled: true });
    assert.equal(cap.status, 200);
    assert.equal(lessonOf(cap).disabled, true);
    assert.equal(lessonOf(cap).id, id);

    // The store keeps the row (the panel lists disabled ones too), so the
    // lesson is still listed, flagged as disabled.
    const listed = await call("GET", "/api/learning/lessons");
    const rows = bodyOf(listed).data as Body[];
    assert.ok(rows.some((l) => l.id === id && l.disabled === true));
  });

  it("rejects a non-boolean disabled flag as a caller error", async () => {
    const created = await seedLesson({ lesson: "A lesson to validate the patch body." });
    assert.ok(created);
    const cap = await call("PATCH", `/api/learning/lessons/${created!.id}`, { disabled: "yes" });
    assert.equal(cap.status, 400);
    assert.match(String(bodyOf(cap).error), /boolean/);
  });

  it("returns 404 for an unknown lesson on PATCH and DELETE", async () => {
    const patched = await call("PATCH", "/api/learning/lessons/les_nope", { disabled: true });
    assert.equal(patched.status, 404);

    const removed = await call("DELETE", "/api/learning/lessons/les_nope");
    assert.equal(removed.status, 404);
  });

  it("deletes a lesson with a 204 and no body, then 404s on the next try", async () => {
    const created = await seedLesson({ lesson: "Delete me." });
    assert.ok(created);
    const id = created!.id;

    const removed = await call("DELETE", `/api/learning/lessons/${id}`);
    assert.equal(removed.status, 204);
    assert.equal(removed.rawBody, undefined, "a 204 must carry no body");

    const again = await call("DELETE", `/api/learning/lessons/${id}`);
    assert.equal(again.status, 404);
  });

  it("lists correction events filtered by taskId", async () => {
    store.recordCorrection({
      agentId: null,
      taskId: "task_1",
      domain: "nutrio-content",
      priorAssistant: "Nutrio is a healthy meal app",
      userText: "لا، قلت لك اكتب اسم نتريو بالعربي",
    });
    store.recordCorrection({
      agentId: null,
      taskId: "task_2",
      domain: "general",
      priorAssistant: "done",
      userText: "actually use the other path",
    });

    const all = await call("GET", "/api/learning/corrections");
    assert.equal(all.status, 200);
    const allRows = bodyOf(all).data as Body[];
    assert.ok(allRows.length >= 2);

    const one = await call("GET", "/api/learning/corrections?taskId=task_1");
    assert.equal(one.status, 200);
    const rows = bodyOf(one).data as Body[];
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.taskId === "task_1"));
    assert.equal(rows[0]!.userText, "لا، قلت لك اكتب اسم نتريو بالعربي");
  });

  it("leaves unrelated paths and unmatched methods unhandled", async () => {
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = "GET";
    req.url = "http://127.0.0.1/api/agents";
    const { res } = fakeRes();
    assert.equal(await handleLearningRoutes(req, res, "/api/agents"), false);

    // /api/learning (the audit log) is a different module's path.
    const audit = Readable.from([]) as unknown as http.IncomingMessage;
    audit.method = "GET";
    audit.url = "http://127.0.0.1/api/learning";
    const second = fakeRes();
    assert.equal(await handleLearningRoutes(audit, second.res, "/api/learning"), false);
  });

  it("classifies a malformed PATCH body as a 400, never a server fault", async () => {
    const created = await seedLesson({ lesson: "A lesson to feed malformed JSON." });
    assert.ok(created);
    const req = Readable.from([Buffer.from("{not json")]) as unknown as http.IncomingMessage;
    req.method = "PATCH";
    req.url = `http://127.0.0.1/api/learning/lessons/${created!.id}`;
    const { res, captured } = fakeRes();
    assert.equal(await handleLearningRoutes(req, res, `/api/learning/lessons/${created!.id}`), true);
    assert.equal(captured.status, 400);
  });
});
