import assert from "node:assert";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, it, afterEach } from "node:test";

import {
  registerStudioEngine,
  unregisterStudioEngine,
  clearStudioEngines,
  listStudioEngines,
  runStudioCommand,
  isStudioApp,
  LIST_COMMANDS_ID,
  type StudioCommandSpec,
  type StudioEngine,
} from "../../tools/loamStudioHost.js";
import { handleStudioHostRoutes } from "../routes/studioHost.js";

interface MockOpts {
  enabled?: boolean;
  reason?: string;
}

function mockEngine(app: StudioEngine["app"], opts: MockOpts = {}): StudioEngine {
  const enabled = opts.enabled !== false;
  return {
    app,
    title: `Mock ${app}`,
    description: `mock engine for ${app}`,
    enabled: () => (enabled ? { enabled: true } : { enabled: false, reason: opts.reason }),
    commands: () => [
      { id: "new", title: "Create", params: { name: { type: "string", required: true } } },
      { id: "rename", title: "Rename" },
      { id: "boom", title: "Always fails" },
      { id: "crash", title: "Throws" },
    ],
    run: (id, params) => {
      if (id === "boom") return { ok: false, error: "boom exploded" };
      if (id === "crash") throw new Error("engine crashed");
      return { ok: true, data: { id, params } };
    },
  };
}

function jsonRes() {
  const out = { statusCode: 0, headers: undefined as unknown, body: "", sent: false };
  const res = {
    writeHead(status: number, headers?: unknown) {
      out.statusCode = status;
      out.headers = headers;
      return res;
    },
    end(text?: unknown) {
      out.body = typeof text === "string" ? text : "";
      out.sent = true;
      return res;
    },
  } as unknown as http.ServerResponse;
  return { res, out, json: () => JSON.parse(out.body) as Record<string, unknown> };
}

function makeReq(method: string, url: string, body?: unknown): http.IncomingMessage {
  const req = new Readable({ read() {} });
  Object.defineProperty(req, "method", { value: method });
  Object.defineProperty(req, "headers", { value: { host: "127.0.0.1:3939" } });
  Object.defineProperty(req, "url", { value: url });
  if (body !== undefined) req.push(Buffer.from(JSON.stringify(body), "utf8"));
  req.push(null);
  return req as unknown as http.IncomingMessage;
}

describe("loamStudioHost registry", () => {
  afterEach(() => clearStudioEngines());

  it("isStudioApp accepts only known apps", () => {
    assert.ok(isStudioApp("video"));
    assert.ok(isStudioApp("design"));
    assert.ok(!isStudioApp("spaces"));
    assert.ok(!isStudioApp(42));
  });

  it("lists registered engines in STUDIO_APPS order with availability", () => {
    registerStudioEngine(mockEngine("doc", { enabled: false, reason: "engine offline" }));
    registerStudioEngine(mockEngine("video"));
    const studios = listStudioEngines();
    assert.deepStrictEqual(studios.map((s) => s.app), ["video", "doc"]);
    assert.strictEqual(studios[0]!.available, true);
    assert.deepStrictEqual(studios[0]!.commands, ["new", "rename", "boom", "crash"]);
    assert.strictEqual(studios[1]!.available, false);
    assert.strictEqual(studios[1]!.reason, "engine offline");
    unregisterStudioEngine("video");
    assert.deepStrictEqual(listStudioEngines().map((s) => s.app), ["doc"]);
  });
});

describe("loamStudioHost command proxy", () => {
  afterEach(() => clearStudioEngines());

  it("rejects unknown apps and malformed requests", async () => {
    const unknown = await runStudioCommand("spaces", { id: "new" });
    assert.ok(!unknown.ok && unknown.kind === "unknown_app");

    const unregistered = await runStudioCommand("sheet", { id: "new" });
    assert.ok(!unregistered.ok && unregistered.kind === "unknown_app");

    registerStudioEngine(mockEngine("doc"));
    const missingId = await runStudioCommand("doc", {});
    assert.ok(!missingId.ok && missingId.kind === "bad_request");
    const badParams = await runStudioCommand("doc", { id: "new", params: [1, 2] });
    assert.ok(!badParams.ok && badParams.kind === "bad_request");
  });

  it("list_commands returns the self-describing catalog even when disabled", async () => {
    registerStudioEngine(mockEngine("slides", { enabled: false, reason: "renderer not ready" }));
    const listed = await runStudioCommand("slides", { id: LIST_COMMANDS_ID });
    assert.ok(listed.ok && listed.kind === "commands");
    const catalog = (listed as { commands: StudioCommandSpec[] }).commands;
    assert.deepStrictEqual(catalog.map((c) => c.id), ["new", "rename", "boom", "crash"]);
    assert.deepStrictEqual(catalog[0]!.params, { name: { type: "string", required: true } });
  });

  it("disabled engines fail with a safe one-line reason", async () => {
    registerStudioEngine(mockEngine("doc", { enabled: false, reason: "line one\nline two " + "x".repeat(300) }));
    const res = await runStudioCommand("doc", { id: "new", params: { name: "a" } });
    assert.ok(!res.ok && res.kind === "disabled");
    if (!res.ok && res.kind === "disabled") {
      assert.strictEqual(res.error, "studio_disabled");
      assert.ok(!res.reason.includes("\n"));
      assert.ok(res.reason.length <= 240);
    }
  });

  it("runs declared commands, blocks undeclared ones, and contains engine failures", async () => {
    registerStudioEngine(mockEngine("doc"));
    const ok = await runStudioCommand("doc", { id: "new", params: { name: "report" } });
    assert.deepStrictEqual(ok, { ok: true, kind: "result", data: { id: "new", params: { name: "report" } } });

    const undeclared = await runStudioCommand("doc", { id: "delete" });
    assert.ok(!undeclared.ok && undeclared.kind === "unsupported_command" && undeclared.commandId === "delete");

    const failed = await runStudioCommand("doc", { id: "boom" });
    assert.ok(!failed.ok && failed.kind === "engine_error" && failed.error === "boom exploded");

    const crashed = await runStudioCommand("doc", { id: "crash" });
    assert.ok(!crashed.ok && crashed.kind === "engine_error" && crashed.error === "engine crashed");
  });

  it("honors an injected resolver (mock engine, no registry)", async () => {
    const res = await runStudioCommand("design", { id: "new", params: {} }, (app) => (app === "design" ? mockEngine("design") : undefined));
    assert.ok(res.ok && res.kind === "result");
    const none = await runStudioCommand("design", { id: "new" }, () => undefined);
    assert.ok(!none.ok && none.kind === "unknown_app");
  });
});

describe("studioHost routes", () => {
  afterEach(() => clearStudioEngines());

  it("ignores unrelated paths and taskId'd studio reads", async () => {
    const { res, out } = jsonRes();
    assert.strictEqual(await handleStudioHostRoutes(makeReq("GET", "/api/agents"), res, "/api/agents"), false);
    assert.strictEqual(await handleStudioHostRoutes(makeReq("GET", "/api/studio?taskId=t1"), res, "/api/studio"), false);
    assert.strictEqual(out.sent, false); // legacy handler must still get the request
  });

  it("GET /api/studio lists studios (registry and ctx-injected resolver)", async () => {
    registerStudioEngine(mockEngine("sheet"));
    const { res, out, json } = jsonRes();
    assert.strictEqual(await handleStudioHostRoutes(makeReq("GET", "/api/studio"), res, "/api/studio"), true);
    assert.strictEqual(out.statusCode, 200);
    const listed = json().studios as { app: string }[];
    assert.deepStrictEqual(listed.map((s) => s.app), ["sheet"]);

    const injected = { studioEngineResolver: (app: string) => (app === "video" ? mockEngine("video") : undefined) };
    const r2 = jsonRes();
    assert.strictEqual(await handleStudioHostRoutes(makeReq("GET", "/api/studio"), r2.res, "/api/studio", injected), true);
    assert.deepStrictEqual((r2.json().studios as { app: string }[]).map((s) => s.app), ["video"]);
  });

  it("POST /api/studio/:app/command proxies list_commands and results", async () => {
    registerStudioEngine(mockEngine("doc"));
    const r1 = jsonRes();
    assert.strictEqual(await handleStudioHostRoutes(makeReq("POST", "/api/studio/doc/command", { id: LIST_COMMANDS_ID }), r1.res, "/api/studio/doc/command"), true);
    assert.strictEqual(r1.out.statusCode, 200);
    assert.ok((r1.json().commands as { id: string }[]).some((c) => c.id === "new"));

    const r2 = jsonRes();
    assert.strictEqual(await handleStudioHostRoutes(makeReq("POST", "/api/studio/doc/command", { id: "rename", params: { name: "x" } }), r2.res, "/api/studio/doc/command"), true);
    assert.deepStrictEqual(r2.json(), { ok: true, data: { id: "rename", params: { name: "x" } } });
  });

  it("maps engine failures to safe envelopes", async () => {
    registerStudioEngine(mockEngine("doc", { enabled: false, reason: "not ready" }));
    const off = jsonRes();
    await handleStudioHostRoutes(makeReq("POST", "/api/studio/doc/command", { id: "new" }), off.res, "/api/studio/doc/command");
    assert.strictEqual(off.out.statusCode, 200);
    assert.deepStrictEqual(off.json(), { ok: false, error: "studio_disabled", reason: "not ready" });

    const missing = jsonRes();
    await handleStudioHostRoutes(makeReq("POST", "/api/studio/spaces/command", { id: "new" }), missing.res, "/api/studio/spaces/command");
    assert.strictEqual(missing.out.statusCode, 404);
    assert.strictEqual(missing.json().error, 'unknown studio app "spaces"');

    const badBody = jsonRes();
    await handleStudioHostRoutes(makeReq("POST", "/api/studio/doc/command", { params: {} }), badBody.res, "/api/studio/doc/command");
    assert.strictEqual(badBody.out.statusCode, 400);

    const wrongMethod = jsonRes();
    await handleStudioHostRoutes(makeReq("GET", "/api/studio/doc/command"), wrongMethod.res, "/api/studio/doc/command");
    assert.strictEqual(wrongMethod.out.statusCode, 405);
  });

  it("returns false for non-command /api/studio/* forms", async () => {
    const { res } = jsonRes();
    assert.strictEqual(await handleStudioHostRoutes(makeReq("POST", "/api/studio/import"), res, "/api/studio/import"), false);
    assert.strictEqual(await handleStudioHostRoutes(makeReq("GET", "/api/studio/preview?taskId=t1"), res, "/api/studio/preview"), false);
  });
});
