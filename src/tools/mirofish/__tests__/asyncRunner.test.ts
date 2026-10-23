/**
 * Tests for the M3 wiring: the conversational surface delegating to the real
 * swarm simulation.
 *
 * Guarantees under test (all against a deterministic fake ModelCaller, no real
 * API calls):
 *  - `runConversationalMirofish` stays synchronous and backward compatible
 *  - the async entry point requires a Config and runs the M2 seed + M3 loop
 *  - the run writes the legacy artifacts the UI reads (profile JSON/CSV, report.md)
 *  - the active session is persisted so the follow-up branches keep working
 *  - a missing caller degrades to skipped turns and `model_unavailable: true`
 *  - the `mirofish_chat` tool takes the async path only when the context carries
 *    a provider client
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Config } from "../../../config.js";
import type { ModelCaller, ModelRequest, ModelResponse } from "../model.js";
import { runConversationalMirofish, runConversationalMirofishAsync, mirofishTools } from "../../mirofish.js";
import { loadActiveMirofishSession } from "../../mirofish.js";

interface FakeState {
  calls: ModelRequest[];
  fail: boolean;
}

function makeFakeCaller(state: FakeState = { calls: [], fail: false }): ModelCaller {
  let personaBatch = 0;
  return {
    async chat(req: ModelRequest): Promise<ModelResponse> {
      state.calls.push(req);
      if (state.fail) throw new Error("model unavailable");
      const p = req.prompt;
      if (p.includes("market-research analyst")) {
        return {
          content: JSON.stringify({
            country: "Qatar",
            city: "Doha",
            region: "",
            currency: "QAR",
            languages: ["ar-QA", "en"],
            dialect: "Gulf Arabic",
            incomeBands: [{ label: "middle", min: 9000, max: 22000, currency: "QAR" }],
            demographics: ["high smartphone penetration"],
          }),
          model: "fake-model",
        };
      }
      if (p.includes("market-analysis engine")) {
        return {
          content: JSON.stringify({
            products: [{ name: "Nutrio", kind: "service", detail: "meal-planning subscription" }],
            prices: [{ product: "Nutrio", amount: 1200, currency: "QAR", period: "month" }],
            competitors: [{ name: "MealBox", kind: "competitor" }],
            audiences: ["busy professionals"],
            summary: "A meal-planning subscription for health-conscious professionals.",
          }),
          model: "fake-model",
        };
      }
      if (p.includes("customer-persona designer")) {
        const count = Number((p.match(/EXACTLY (\d+)/) ?? [])[1] ?? 2);
        const names = ["Layla Haddad", "James Whitfield", "Omar Al-Mansoori", "Priya Sharma"];
        const out = [];
        for (let i = 0; i < count; i++) {
          const index = personaBatch * count + i;
          out.push({
            id: `persona_${index}`,
            name: names[index % names.length],
            age: 24 + i * 3,
            gender: i % 2 === 0 ? "female" : "male",
            nationality: "Qatari",
            country: "Qatar",
            city: "Doha",
            incomeBand: "middle",
            incomeAmount: 15000,
            currency: "QAR",
            household: "family with young children",
            occupation: "accountant",
            channel: "Instagram",
            attitude: "curious",
            habits: ["compares prices before buying"],
            language: "ar-QA",
            dialect: "Gulf Arabic",
            bio: "A local professional exploring meal plans.",
          });
        }
        personaBatch += 1;
        return { content: JSON.stringify(out), model: "fake-model" };
      }
      // Agent-turn prompt.
      return {
        content: JSON.stringify({
          action: "post",
          text: "the price went up and that hurts my budget #price",
          stance: -0.6,
          purchaseIntent: 0.25,
          reasons: ["monthly budget is tight"],
        }),
        model: "fake-model",
      };
    },
  };
}

/** Minimal Config for the async path; the caller is injected so no network. */
function testConfig(workspace: string): Config {
  return {
    model: "fake-model",
    fallbackModel: "fake-model",
    ollamaUrl: "http://127.0.0.1:11434",
    agent: { maxSteps: 1, temperature: 0.2, requestTimeoutMs: 15000 },
    workspace,
  } as unknown as Config;
}

/** Anything the run emitted on its event bus, for progress assertions. */
type BusEvent = { type: string; sessionId?: string; payload?: unknown };

describe("runConversationalMirofishAsync (M3 wiring)", () => {
  let workspace = "";

  it("rejects when no Config is supplied", async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mf2-m3-async-"));
    await assert.rejects(
      () => runConversationalMirofishAsync(workspace, { message: "simulate Nutrio in Doha" }),
      /requires runtime\.cfg/,
    );
  });

  it("runs the real seed + swarm loop and writes the legacy artifacts", async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mf2-m3-async-"));
    const state: FakeState = { calls: [], fail: false };
    const caller = makeFakeCaller(state);

    const res = await runConversationalMirofishAsync(workspace, {
      message: "Simulate Nutrio in Doha",
      maxRounds: 2,
      runtime: { cfg: testConfig(workspace), caller },
    });

    assert.equal(res.ok, true);
    assert.equal(res.data.model_unavailable, false);
    assert.ok(Number(res.data.model_calls) > 0, "the run must record real model calls");
    assert.ok(Number(res.data.rounds_completed) >= 1, "the run must record the rounds it executed");
    assert.match(res.reply, /MiroFish/i);
    assert.ok(String(res.data.report_md_path).endsWith("report.md"));

    const reportPath = String(res.data.report_md_path);
    assert.ok(fs.existsSync(reportPath), "report.md must be written");
    const report = fs.readFileSync(reportPath, "utf8");
    assert.match(report, /Nutrio/);
    assert.match(report, /MiroFish/i);

    // Legacy artifacts the UI already reads.
    const simDir = path.join(workspace, ".manus", "mirofish", "simulations", String(res.data.simulation_id));
    assert.ok(fs.existsSync(path.join(simDir, "reddit_profiles.json")), "reddit_profiles.json must exist");
    assert.ok(fs.existsSync(path.join(simDir, "twitter_profiles.csv")), "twitter_profiles.csv must exist");
    assert.ok(fs.existsSync(path.join(simDir, "simulation_events.jsonl")), "event log must exist");
    assert.ok(fs.existsSync(path.join(simDir, "metrics.json")), "metrics must exist");

    // The active session keeps the follow-up branches working.
    const session = loadActiveMirofishSession(workspace);
    assert.ok(session, "active session must be persisted");
    assert.equal(session!.simulation_id, res.data.simulation_id);
    assert.equal(session!.target_name, "Nutrio");

    // The fake caller saw the seed calls and the agent turns.
    assert.ok(state.calls.some((c) => c.prompt.includes("market-research analyst")));
    assert.ok(state.calls.some((c) => c.prompt.includes("acting in round")));
  });

  it("degrades honestly when no caller is available", async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mf2-m3-async-"));
    const res = await runConversationalMirofishAsync(workspace, {
      message: "Simulate Nutrio in Doha",
      maxRounds: 1,
      runtime: { cfg: testConfig(workspace) },
    });

    assert.equal(res.ok, true);
    assert.equal(res.data.model_unavailable, true);
    assert.equal(Number(res.data.model_calls), 0);
    assert.match(res.reply, /model/i);
    // The rule-based personas still exist, but nothing was invented.
    const simDir = path.join(workspace, ".manus", "mirofish", "simulations", String(res.data.simulation_id));
    const profiles = JSON.parse(fs.readFileSync(path.join(simDir, "reddit_profiles.json"), "utf8"));
    assert.ok(Array.isArray(profiles) && profiles.length > 0);
  });

  it("reports progress on the run's event bus and writes the seed artifact", async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mf2-m3-async-"));
    const state: FakeState = { calls: [], fail: false };
    const events: BusEvent[] = [];

    const res = await runConversationalMirofishAsync(workspace, {
      message: "Simulate Nutrio in Doha",
      maxRounds: 2,
      runtime: { cfg: testConfig(workspace), caller: makeFakeCaller(state), emit: (e: BusEvent) => events.push(e) },
    });

    // M3 progress reaches the surrounding run, tagged with this run's id.
    const progress = events.filter((e) => e.type === "simulation_progress");
    assert.ok(progress.length > 0, "simulation_progress events must reach the run event bus");
    assert.ok(
      progress.every((e) => e.sessionId === String(res.data.simulation_id)),
      "progress events are tagged with the simulation id",
    );
    assert.ok(
      progress.some((e) => (e.payload as { type?: string } | undefined)?.type === "simulation_round"),
      "round progress is reported",
    );
    const done = progress.filter((e) => (e.payload as { type?: string } | undefined)?.type === "simulation_done");
    assert.ok(done.length > 0, "the run reports completion");
    assert.equal(
      (done[0]!.payload as { rounds: number }).rounds,
      Number(res.data.rounds_completed),
      "the completion event agrees with the reported rounds",
    );

    // The seed artifact the synchronous runner leaves, on this surface too.
    const seedPath = path.join(workspace, ".manus", "mirofish", "seeds", "seed.json");
    assert.ok(fs.existsSync(seedPath), "seed.json must be written");
    const seed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as {
      locale: { country: string; city: string; currency: string };
      locale_source: string;
      model_calls: number;
    };
    assert.equal(seed.locale.country, "Qatar", "the resolved locale is recorded");
    assert.equal(seed.locale.currency, "QAR");
    // The locale prompt asks labels to match the market's primary language, so
    // the city may be returned in the brief's script; the country is stable.
    assert.ok(["Doha", "الدوحة"].includes(seed.locale.city), `the city follows the brief (got ${seed.locale.city})`);
    assert.equal(seed.locale_source, "user", "a place named in the brief stays authoritative");
    assert.ok(seed.model_calls > 0, "the seed records how many model calls it made");
  });

  it("keeps the synchronous entry point backward compatible", () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mf2-m3-async-"));
    const res = runConversationalMirofish(workspace, { message: "Analyze the app", maxRounds: 1 });
    assert.equal(res.ok, true);
    assert.equal(res.intent, "full_application_analysis");
    assert.match(res.reply, /MiroFish/i);
    assert.ok(String(res.data.report_md_path).length > 0);
  });
});

describe("mirofish_chat tool (M3 wiring)", () => {
  it("takes the async path only when the context carries a provider client", async () => {
    const tool = mirofishTools().find((t) => t.name === "mirofish_chat");
    assert.ok(tool);

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mf2-m3-tool-"));
    const base = { cfg: testConfig(workspace), workspace, emit: () => undefined };

    // No provider client -> the legacy synchronous path, no model calls.
    const legacy = await tool!.run({ message: "Analyze the app", maxRounds: 1 }, base);
    assert.equal(legacy.ok, true);
    assert.doesNotMatch(legacy.content, /"model_unavailable"/);

    // With a provider client the tool delegates to the async path. A bare stub
    // client cannot serve real requests, so the run must degrade to skipped
    // turns and report `model_unavailable` instead of inventing output.
    const asyncResult = await tool!.run(
      { message: "Simulate Nutrio in Doha", maxRounds: 1 },
      { ...base, ollama: {} as never },
    );
    assert.equal(asyncResult.ok, true);
    assert.match(asyncResult.content, /"model_unavailable": true/);
  });
});
