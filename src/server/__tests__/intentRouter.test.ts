/**
 * Tests for the intent router (UI overhaul W-U2).
 *
 * Three layers are pinned:
 *   - the deterministic keyword classifier (src/server/intentKeywords.ts);
 *   - the model layer (src/server/intentModel.ts) with an injected fake model
 *     (ollama.chat stub), including garbage / unknown-id / throwing replies;
 *   - the HTTP endpoint POST /api/intent/route booted through the real
 *     startServer dispatcher (http.ts), like eventsRoutes.test.ts does, so the
 *     token gate, the 405/400 guards and the never-500 degradation are
 *     exercised as the app wires them.
 *
 * Isolation first: redirects MANUS_LOCAL_DATA_DIR / LOAM_ROOT before config.ts
 * is evaluated (see src/test/isolation.ts).
 */
import "../../test/isolation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ChatOptions, ChatResult, OllamaClient } from "../../ollama.js";

import { cleanupIsolatedDataDir, isolatedDataDir } from "../../test/isolation.js";

const { loadConfig } = await import("../../config.js");
const { closeDb } = await import("../sqliteStore.js");
const { INTENT_MODE_IDS, classifyIntentByKeywords, KEYWORD_MIN_SCORE } = await import("../intentKeywords.js");
const { buildUserMessage, classifyIntentByModel, extractIntentJson, INTENT_MODEL_TIMEOUT_MS } = await import("../intentModel.js");
const { routeIntent } = await import("../intentRouter.js");
const { getOrCreateLocalToken } = await import("../../security/localAuth.js");

type Config = Awaited<ReturnType<typeof loadConfig>>;

/** A duck-typed OllamaClient whose chat() returns a canned body and records calls. */
function fakeOllama(respond: (opts: ChatOptions) => string): { client: OllamaClient; calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  const client = {
    chat: async (opts: ChatOptions): Promise<ChatResult> => {
      calls.push(opts);
      return {
        content: respond(opts),
        toolCalls: [],
        model: opts.model,
        usage: { promptTokens: 11, completionTokens: 7, durationMs: 2 },
      };
    },
  } as unknown as OllamaClient;
  return { client, calls };
}

function makeCfg(): Config {
  const root = isolatedDataDir();
  const workspace = path.join(root, "workspace-unit");
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(root, "config-unit.json");
  fs.writeFileSync(configPath, JSON.stringify({
    workspace,
    memory: { enabled: false },
    screen: { enabled: false },
    selfImprove: { enabled: false },
    computerUse: { enabled: false },
    mcpServers: {},
    model: "stub-intent-a",
    fallbackModel: "stub-intent-b",
  }), "utf8");
  process.env.LOAM_CONFIG = configPath;
  return loadConfig();
}

describe("intent keyword layer (classifyIntentByKeywords)", () => {
  it("routes an Arabic build brief to build", () => {
    const got = classifyIntentByKeywords("ابن لي تطبيق ويب لتسجيل المبيعات مع صفحة ويب للطلبات");
    assert.equal(got.mode, "build");
    assert.ok(got.score >= KEYWORD_MIN_SCORE, `score ${got.score} below threshold`);
    assert.ok(got.matched.includes("ابن لي"));
  });

  it("routes an Arabic research brief to research", () => {
    const got = classifyIntentByKeywords("ابحث لي عن مصادر حديثة حول الطاقة الشمسية وقارن بين الأدلة");
    assert.equal(got.mode, "research");
    assert.ok(got.score >= KEYWORD_MIN_SCORE);
  });

  it("keeps a plain question on ask", () => {
    const got = classifyIntentByKeywords("ما هي افضل طريقة لتعلم البرمجة؟");
    assert.equal(got.mode, "ask");
    assert.ok(got.score < KEYWORD_MIN_SCORE, `score ${got.score} should stay under the threshold`);
  });

  it("routes English variants: build, research and data", () => {
    assert.equal(classifyIntentByKeywords("build me a landing page for my coffee shop with an order form").mode, "build");
    assert.equal(classifyIntentByKeywords("research the latest papers on solar energy and compare the sources").mode, "research");
    assert.equal(classifyIntentByKeywords("analyze the csv dataset and chart the monthly totals").mode, "data");
  });

  it("a single weak word stays on ask (threshold behavior)", () => {
    assert.equal(classifyIntentByKeywords("كود").mode, "ask");
    assert.equal(classifyIntentByKeywords("موقع").mode, "ask");
  });

  it("empty or whitespace text resolves to ask", () => {
    assert.equal(classifyIntentByKeywords("").mode, "ask");
    assert.equal(classifyIntentByKeywords("   ").mode, "ask");
  });

  it("only ever returns real catalog mode ids", () => {
    for (const text of [
      "ابن لي تطبيق ويب", "ابحث عن مصادر", "اكتب مقال", "حلل البيانات", "صمم مشهد ثلاثي الابعاد",
      "فحص امني للثغرات", "مراجعة عقد قانوني", "فك تشفير apk", "github issue و pull request", "اتمتة خطوات متكررة",
    ]) {
      const got = classifyIntentByKeywords(text);
      assert.ok(INTENT_MODE_IDS.has(got.mode), `${got.mode} is not a catalog mode id`);
    }
  });
});

describe("intent model layer (classifyIntentByModel with a fake model)", () => {
  const cfg = makeCfg();

  it("routes to the mode the model returned, with its Arabic reason", async () => {
    const { client, calls } = fakeOllama(() => '{"mode":"data","reason_ar":"طلب تحليل بيانات"}');
    const got = await classifyIntentByModel("عالج لي الموضوع التالي بالتفصيل", { cfg, ollama: client });
    assert.ok(got, "model reply should classify");
    assert.equal(got!.mode, "data");
    assert.equal(got!.reason, "طلب تحليل بيانات");
    assert.equal(calls.length, 1, "exactly one classification call");
    const opts = calls[0]!;
    assert.equal(opts.temperature, 0);
    assert.equal(opts.timeoutMs, INTENT_MODEL_TIMEOUT_MS);
    assert.equal(opts.tools, undefined, "no tools are sent");
    assert.equal(opts.messages[0]!.role, "system");
    assert.ok(opts.messages[0]!.content.includes("الأوضاع المتاحة"));
    assert.ok(opts.messages[0]!.content.includes("data:"), "the catalog list names the real ids");
    assert.equal(opts.messages[1]!.role, "user");
    assert.equal(opts.messages[1]!.content, "عالج لي الموضوع التالي بالتفصيل");
  });

  it("rejects an unknown mode id and returns null", async () => {
    const { client } = fakeOllama(() => '{"mode":"quantum","reason_ar":"وضع غير موجود"}');
    const got = await classifyIntentByModel("اي شيء", { cfg, ollama: client });
    assert.equal(got, null);
  });

  it("survives garbage output and returns null", async () => {
    const { client } = fakeOllama(() => "أنا لست جسون إطلاقًا، لا أقواس هنا");
    const got = await classifyIntentByModel("اي شيء", { cfg, ollama: client });
    assert.equal(got, null);
  });

  it("survives a throwing model call and returns null", async () => {
    const { client } = fakeOllama(() => { throw new Error("connection refused"); });
    const got = await classifyIntentByModel("اي شيء", { cfg, ollama: client });
    assert.equal(got, null);
  });

  it("parses leniently: prose-wrapped and fenced JSON both work, junk does not", () => {
    const wrapped = extractIntentJson('النتيجة: {"mode":"legal","reason_ar":"طلب قانوني"} شكرًا') as { mode?: string };
    assert.equal(wrapped.mode, "legal");
    const fenced = extractIntentJson('```json\n{"mode":"automate","reason_ar":"خطوات"}\n```') as { mode?: string };
    assert.equal(fenced.mode, "automate");
    assert.equal(extractIntentJson("لا شيء هنا"), null);
    assert.equal(extractIntentJson(""), null);
  });

  it("buildUserMessage is a pure { role, content } builder", () => {
    assert.deepEqual(buildUserMessage("نص المستخدم"), { role: "user", content: "نص المستخدم" });
    assert.deepEqual(buildUserMessage(""), { role: "user", content: "" });
  });
});

describe("routeIntent (thin router)", () => {
  const cfg = makeCfg();

  it("empty text asks immediately without calling the model", async () => {
    const { client, calls } = fakeOllama(() => '{"mode":"build","reason_ar":"x"}');
    const got = await routeIntent("   ", { cfg, ollama: client });
    assert.equal(got.mode, "ask");
    assert.equal(got.source, "keywords");
    assert.equal(calls.length, 0, "no model call for empty text");
    assert.ok(["solo", "lite", "full"].includes(got.effort.effort));
  });

  it("a model decision wins and carries source model", async () => {
    const { client } = fakeOllama(() => '{"mode":"write","reason_ar":"طلب كتابة واضح"}');
    const got = await routeIntent("عالج لي الموضوع التالي بالتفصيل", { cfg, ollama: client });
    assert.equal(got.mode, "write");
    assert.equal(got.reason, "طلب كتابة واضح");
    assert.equal(got.source, "model");
  });

  it("a garbage model falls back to the keyword layer", async () => {
    const { client } = fakeOllama(() => "not json at all");
    const got = await routeIntent("ابن لي تطبيق ويب لتسجيل المبيعات", { cfg, ollama: client });
    assert.equal(got.source, "keywords");
    assert.equal(got.mode, "build");
    assert.ok(got.reason.length > 0);
  });

  it("a throwing model never rejects the caller", async () => {
    const { client } = fakeOllama(() => { throw new Error("boom"); });
    const got = await routeIntent("ابحث لي عن مصادر حول الطاقة الشمسية وقارن بينها", { cfg, ollama: client });
    assert.equal(got.mode, "research");
    assert.equal(got.source, "keywords");
    assert.ok(INTENT_MODE_IDS.has(got.mode));
  });
});

describe("POST /api/intent/route over the real server (http.ts mount)", () => {
  let server: http.Server;
  let base = "";
  let token = "";

  before(async () => {
    const root = isolatedDataDir();
    const workspace = path.join(root, "workspace-http");
    fs.mkdirSync(workspace, { recursive: true });
    const configPath = path.join(root, "config-http.json");
    fs.writeFileSync(configPath, JSON.stringify({
      workspace,
      memory: { enabled: false },
      screen: { enabled: false },
      selfImprove: { enabled: false },
      computerUse: { enabled: false },
      mcpServers: {},
      model: "stub-intent-a",
      fallbackModel: "stub-intent-b",
    }), "utf8");
    process.env.LOAM_CONFIG = configPath;
    // Auth stays ON (no LOAM_AUTH_DISABLED): the 401 path is part of the contract.
    const tokenDir = path.join(root, "token");
    process.env.LOAM_LOCAL_TOKEN_DIR = tokenDir;
    token = getOrCreateLocalToken(tokenDir);

    const { startServer } = await import("../http.js");
    // The fake model answers the writer mode for normal requests and returns
    // garbage when the text carries the "blocking" marker, so one server
    // exercises both the model path and the keyword fallback over the wire.
    const fake = fakeOllama((opts) => {
      const user = opts.messages.find((m) => m.role === "user");
      return user && user.content.includes("وسم المحجوب") ? "I am plain prose, not JSON" : '{"mode":"write","reason_ar":"طلب كتابة واضح"}';
    });
    const cfg = loadConfig();
    cfg.server.host = "127.0.0.1";
    cfg.server.port = 0;
    server = await startServer({
      cfg,
      ollama: fake.client,
      runTask: async () => ({ taskId: "test", text: "" }),
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    delete process.env.LOAM_LOCAL_TOKEN_DIR;
    delete process.env.LOAM_CONFIG;
    cleanupIsolatedDataDir();
  });

  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/api/intent/route`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("refuses requests without the install token (401)", async () => {
    const res = await post({ text: "ابن لي تطبيق ويب" });
    assert.equal(res.status, 401);
  });

  it("refuses a wrong token (401)", async () => {
    const res = await post({ text: "ابن لي تطبيق ويب" }, { "x-loam-local-token": "wrong-token" });
    assert.equal(res.status, 401);
  });

  it("routes through the model with the full contract body", async () => {
    const res = await post({ text: "اكتب لي مقترح عمل منظم بالأهداف والنطاق" }, { "x-loam-local-token": token });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mode: string; effort: string; reason: string; source: string };
    assert.equal(body.mode, "write");
    assert.equal(body.source, "model");
    assert.equal(body.reason, "طلب كتابة واضح");
    assert.ok(["solo", "lite", "full"].includes(body.effort), `effort ${body.effort} not a pipeline size`);
  });

  it("falls back to keywords over the wire when the model returns garbage", async () => {
    const res = await post({ text: "وسم المحجوب: ابن لي تطبيق ويب لتسجيل المبيعات" }, { "x-loam-local-token": token });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mode: string; source: string };
    assert.equal(body.source, "keywords");
    assert.equal(body.mode, "build");
  });

  it("answers 400 for an empty/missing text (documented choice)", async () => {
    const empty = await post({ text: "   " }, { "x-loam-local-token": token });
    assert.equal(empty.status, 400);
    const missing = await post({}, { "x-loam-local-token": token });
    assert.equal(missing.status, 400);
  });

  it("answers 400 above the 4000-char cap", async () => {
    const res = await post({ text: "ا".repeat(4001) }, { "x-loam-local-token": token });
    assert.equal(res.status, 400);
    // exactly 4000 Arabic chars (2 UTF-8 bytes each) must still pass the body cap
    const ok = await post({ text: "ا".repeat(4000) }, { "x-loam-local-token": token });
    assert.equal(ok.status, 200);
  });

  it("answers 405 for non-POST", async () => {
    const res = await fetch(`${base}/api/intent/route`, { headers: { "x-loam-local-token": token } });
    assert.equal(res.status, 405);
  });
});
