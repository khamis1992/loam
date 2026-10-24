/**
 * HTTP-route validation for the M3 conversational surface.
 *
 * Guarantees under test (real server, throwaway data/workspace dirs, a fake
 * provider client, no network):
 *  - POST /api/mirofish/chat delegates to the model-aware swarm simulation when
 *    the server was started with a provider client (`deps.ollama`)
 *  - the response carries honest usage (`model_calls`, `model_unavailable`,
 *    `rounds_completed`) and the run's legacy artifacts exist on disk
 *  - the locale is derived from the brief, not hard-coded: a Riyadh brief with a
 *    SAR price yields SAR personas/artifacts, and a neutral brief degrades
 *    instead of inventing a market
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

type ChatResult = import("../../ollama.js").ChatResult;
type ModelRequest = import("../../tools/mirofish/model.js").ModelRequest;
type ModelResponse = import("../../tools/mirofish/model.js").ModelResponse;

/** Calls the fake client saw, so a run on the wrong object is detectable. */
interface FakeState {
  seedCalls: ModelRequest[];
  agentCalls: ModelRequest[];
  /** Set when the locale call could not place the brief, so later stages follow
   *  the neutral profile the seed falls back to. */
  ambiguous?: boolean;
}

function makeFakeClient(state: FakeState): { chat: (opts: unknown) => Promise<ChatResult>; marker: string } {
  const json = (value: unknown): string => JSON.stringify(value);
  const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
  const respond = (system: string, prompt: string): string => {
    // A bare generic brief is one the model cannot place: the seed must fall
    // back to the neutral global profile instead of inventing a market.
    const ambiguous = /generic product/i.test(prompt);
    if (system.includes("market-research analyst")) {
      state.seedCalls.push({ system, prompt });
      if (ambiguous) {
        state.ambiguous = true;
        return "";
      }
      return json({
        country: "Saudi Arabia",
        city: "Riyadh",
        region: "",
        currency: "SAR",
        languages: ["ar-SA", "en"],
        dialect: "Najdi Arabic",
        incomeBands: [{ label: "middle", min: 8000, max: 18000, currency: "SAR" }],
        demographics: ["young urban professionals"],
      });
    }
    if (system.includes("market-analysis engine")) {
      state.seedCalls.push({ system, prompt });
      if (ambiguous) {
        return json({
          products: [],
          prices: [],
          competitors: [],
          audiences: [],
          summary: "A generic product with no stated market.",
        });
      }
      return json({
        products: [{ name: "Sahafah", kind: "service", detail: "Arabic short-story reading app" }],
        prices: [{ product: "Sahafah", amount: 79, currency: "SAR", period: "month" }],
        competitors: [{ name: "Kutub", kind: "competitor" }],
        audiences: ["students"],
        summary: "An Arabic short-story reading subscription for young readers in Riyadh.",
      });
    }
    if (system.includes("customer-persona designer")) {
      state.seedCalls.push({ system, prompt });
      const count = Number((prompt.match(/EXACTLY (\d+)/) ?? [])[1] ?? 2);
      if (state.ambiguous) {
        // Personas follow the neutral locale the seed fell back to.
        return json(
          Array.from({ length: count }, (_, i) => ({
            id: `persona_${i}`,
            name: `Persona ${i + 1}`,
            age: 30,
            gender: i % 2 === 0 ? "female" : "male",
            nationality: "Global",
            country: "Global",
            city: "",
            incomeBand: "middle",
            incomeAmount: 2500,
            currency: "USD",
            household: "single",
            occupation: "professional",
            channel: "search",
            attitude: "neutral",
            habits: [],
            diet: "",
            language: "en",
            dialect: "",
            bio: "A neutral global customer.",
          })),
        );
      }
      const names = ["Noura Al-Otaibi", "Faisal Al-Harbi", "Luluwa Saleh", "Mishal Anwar"];
      return json(
        Array.from({ length: count }, (_, i) => ({
          id: `persona_${i}`,
          name: names[i % names.length],
          age: 22 + i * 3,
          gender: i % 2 === 0 ? "female" : "male",
          nationality: "Saudi",
          country: "Saudi Arabia",
          city: "Riyadh",
          incomeBand: "middle",
          incomeAmount: 12000,
          currency: "SAR",
          household: "single",
          occupation: "student",
          channel: "TikTok",
          attitude: "curious",
          habits: ["reads after midnight"],
          diet: "",
          language: "ar-SA",
          dialect: "Najdi Arabic",
          bio: "A student in Riyadh who reads short stories on her phone.",
        })),
      );
    }
    state.agentCalls.push({ system, prompt });
    if (state.ambiguous) {
      return json({ action: "ignore", text: "", stance: 0, purchaseIntent: 0, reasons: ["no market signal"] });
    }
    return json({
      action: "post",
      text: "79 ريال شهرياً سعر معقول لتطبيق قراءة #سعر",
      stance: 0.4,
      purchaseIntent: 0.6,
      reasons: ["the price feels fair for the content"],
    });
  };

  return {
    marker: "http-fixture-client",
    chat: async (options: unknown): Promise<ChatResult> => {
      const messages = (options as { messages: Array<{ role: string; content: string }> }).messages;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const prompt = messages.find((m) => m.role === "user")?.content ?? "";
      const model: ModelResponse = { content: respond(system, prompt), model: "fixture-model" };
      return { content: model.content, toolCalls: [], model: model.model ?? "fixture-model", usage };
    },
  };
}

describe("POST /api/mirofish/chat (M3 wiring)", () => {
  let tmpDir = "";
  let workspace = "";
  let server: http.Server;
  let base = "";
  let taskId = "";
  let state: FakeState;
  let closeDb: () => void;
  let db: typeof import("../db.js");

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mf2-http-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    process.env.MANUS_LOCAL_SKILLS_DIR = path.join(tmpDir, "skills");
    process.env.MANUS_LOCAL_EVALS_DIR = path.join(tmpDir, "evals");
    process.env.LOAM_AUTH_DISABLED = "true";
    workspace = path.join(tmpDir, "workspace");
    const configFile = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({ workspace, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, computerUse: { enabled: false }, mcpServers: {} }),
      "utf8",
    );
    process.env.LOAM_CONFIG = configFile;

    db = await import("../db.js");
    closeDb = (await import("../sqliteStore.js")).closeDb;
    const { loadConfig } = await import("../../config.js");
    const { startServer } = await import("../http.js");

    const task = db.createTask("mirofish http validation", "http");
    taskId = task.id;
    db.setTaskWorkspace(taskId, workspace);

    const cfg = loadConfig();
    cfg.server.host = "127.0.0.1";
    cfg.server.port = 0;
    // The developer config.json may list remote providers; without this the
    // route's failover chain would reach them instead of the injected client.
    cfg.failover = { ...(cfg.failover ?? {}), providers: [] };

    state = { seedCalls: [], agentCalls: [] };
    // The route must have a provider client to take the real M3 path.
    server = await startServer({
      cfg,
      ollama: makeFakeClient(state) as never,
      runTask: async () => ({ taskId, text: "" }),
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { closeDb(); } catch { /* already closed */ }
    for (const key of ["MANUS_LOCAL_DATA_DIR", "MANUS_LOCAL_SKILLS_DIR", "MANUS_LOCAL_EVALS_DIR", "LOAM_AUTH_DISABLED", "LOAM_CONFIG"]) {
      delete process.env[key];
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function postChat(message: string, maxRounds = 1): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}/api/mirofish/chat?taskId=${encodeURIComponent(taskId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, maxRounds }),
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  it("runs the real swarm simulation through the server's provider client", async () => {
    const out = await postChat("Simulate Sahafah, an Arabic reading app at 79 SAR/month in Riyadh.", 1);
    const data = out.data as Record<string, unknown>;

    assert.equal(out.ok, true);
    // The model layer was reached through the client the server was started with.
    assert.ok(state.seedCalls.length > 0, "the seed pipeline ran through the server's provider client");
    assert.ok(state.agentCalls.length > 0, "the swarm loop ran through the server's provider client");
    // Honest usage: nothing fabricated, nothing hidden.
    assert.equal(data.model_unavailable, false);
    assert.ok(Number(data.model_calls) > 0, "the route reports real model calls");
    assert.ok(Number(data.rounds_completed) >= 1, "the route reports the rounds it ran");
    assert.equal((data.target_name as string).toLowerCase(), "sahafah");
  });

  it("derives the locale from the brief (no hard-coded Qatar/QAR) and writes locale-faithful artifacts", async () => {
    const out = await postChat("Simulate Sahafah, an Arabic reading app at 79 SAR/month in Riyadh.", 1);
    const data = out.data as Record<string, unknown>;
    const simulationId = String(data.simulation_id);
    const simDir = path.join(workspace, ".manus", "mirofish", "simulations", simulationId);

    const profiles = JSON.parse(fs.readFileSync(path.join(simDir, "reddit_profiles.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.ok(profiles.length > 0);
    assert.ok(profiles.every((p) => String(p.country) === "Saudi Arabia"), "personas follow the brief's locale");

    // The legacy Twitter CSV the UI reads carries the same locale.
    const csv = fs.readFileSync(path.join(simDir, "twitter_profiles.csv"), "utf8");
    assert.match(csv, /Saudi Arabia|Riyadh/);

    // The seed artifact records the resolved locale, city included.
    const seedDir = path.join(workspace, ".manus", "mirofish", "seeds");
    const seedFiles = fs.readdirSync(seedDir);
    assert.ok(seedFiles.length > 0, "the seed artifact was written");
    const seed = JSON.parse(fs.readFileSync(path.join(seedDir, seedFiles[0]!), "utf8")) as { locale: { currency: string; city?: string } };
    assert.equal(seed.locale.currency, "SAR", "the locale currency comes from the brief, not a hard-coded default");
    // The brief is English but the seed echoes the city in the brief's market
    // language, so the city is matched on either script.
    assert.ok(
      ["Riyadh", "الرياض"].includes(String(seed.locale.city)),
      `the locale city follows the brief (got ${String(seed.locale.city)})`,
    );

    const metrics = JSON.parse(fs.readFileSync(path.join(simDir, "metrics.json"), "utf8")) as { arms: Array<{ calls: number; failures: number }> };
    const calls = metrics.arms.reduce((sum, arm) => sum + arm.calls, 0);
    assert.ok(calls > 0, "metrics record the calls the run made");

    // The report exists and names the target.
    const reportPath = String(data.report_md_path);
    assert.ok(fs.existsSync(reportPath), "report.md was written");
    assert.match(fs.readFileSync(reportPath, "utf8"), /Sahafah/);
  });

  it("persists the active session so the follow-up branches keep working", async () => {
    const out = await postChat("Simulate Sahafah, an Arabic reading app at 79 SAR/month in Riyadh.", 1);
    const data = out.data as Record<string, unknown>;
    const res = await fetch(`${base}/api/mirofish/session?taskId=${encodeURIComponent(taskId)}`);
    assert.equal(res.status, 200);
    const session = ((await res.json()) as { session: Record<string, unknown> | null }).session;
    assert.ok(session, "the active session must be persisted");
    assert.equal(session!.simulation_id, data.simulation_id);
    assert.equal(session!.target_name, data.target_name);
  });

  it("degrades to a neutral locale instead of inventing a market when the brief has none", async () => {
    const neutralState: FakeState = { seedCalls: [], agentCalls: [] };
    // Reuse the same server; the workspace is resolved per taskId, so this
    // brief simply runs under its own task workspace.
    const neutralTask = db.createTask("neutral brief", "neutral");
    const neutralWorkspace = path.join(tmpDir, "neutral-workspace");
    db.setTaskWorkspace(neutralTask.id, neutralWorkspace);

    const res = await fetch(`${base}/api/mirofish/chat?taskId=${encodeURIComponent(neutralTask.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Simulate a generic product.", maxRounds: 1 }),
    });
    assert.equal(res.status, 200);
    const out = (await res.json()) as Record<string, unknown>;
    const data = out.data as Record<string, unknown>;
    assert.equal(out.ok, true, "the run still completes");
    assert.equal(data.model_unavailable, false);
    // Nothing was invented: the locale is the neutral global fallback.
    const simDir = path.join(neutralWorkspace, ".manus", "mirofish", "simulations", String(data.simulation_id));
    const profiles = JSON.parse(fs.readFileSync(path.join(simDir, "reddit_profiles.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.ok(profiles.length > 0, "personas still exist from the rule-based fallback");
    assert.ok(profiles.every((p) => String(p.country) === "Global"), "an ambiguous brief resolves to the neutral locale, not a hard-coded place");
    const seedDir = path.join(neutralWorkspace, ".manus", "mirofish", "seeds");
    const seed = JSON.parse(fs.readFileSync(path.join(seedDir, fs.readdirSync(seedDir)[0]!), "utf8")) as { locale: { currency: string; country: string } };
    assert.equal(seed.locale.country, "Global");
    assert.equal(seed.locale.currency, "USD", "an ambiguous brief keeps the neutral currency, not a hard-coded one");
  });
});
