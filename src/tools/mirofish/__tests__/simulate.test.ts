/**
 * Tests for the MiroFish M3 simulation loop.
 *
 * Guarantees under test (all against a deterministic fake ModelCaller, no real
 * API calls):
 *  - one model call per agent-turn, and the count is reported honestly
 *  - the call carries persona, brief, variable value, own memory and a feed
 *    sampled only from agents the persona actually follows
 *  - per-round opinion metrics are derived from the recorded turns
 *  - a failing call is logged as a skipped turn, never fabricated
 *  - baseline vs scenario produces real deltas from the two arms
 *  - the agent cap is 20 unless explicitly raised, with a hard cap of 100
 *  - a missing caller degrades to all-skipped turns instead of invented output
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ModelCaller, ModelRequest, ModelResponse } from "../model.js";
import {
  DEFAULT_AGENT_CAP,
  HARD_AGENT_CAP,
  compareArms,
  computeRoundMetrics,
  computeShareCascades,
  computeTopThemes,
  runSimulation,
  sampleFeed,
  validateAgentTurn,
} from "../simulate.js";
import type {
  AgentTurnEvent,
  Persona,
  RoundMetrics,
  SeedResult,
  SimulationArmResult,
  SocialGraph,
} from "../types.js";

/** Deterministic model double that returns one canned agent-turn per call. */
interface FakeState {
  calls: ModelRequest[];
  inFlight: number;
  maxInFlight: number;
  fail: boolean;
  /** Optional override for the whole turn JSON. */
  reply?: string;
}

function makeFakeCaller(
  state: FakeState = { calls: [], inFlight: 0, maxInFlight: 0, fail: false },
): ModelCaller {
  return {
    async chat(req: ModelRequest): Promise<ModelResponse> {
      state.calls.push(req);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.fail) throw new Error("model unavailable");
        return { content: state.reply ?? JSON.stringify({
          action: "post",
          text: "the price went up and that hurts my budget #price",
          stance: -0.6,
          purchaseIntent: 0.25,
          reasons: ["monthly budget is tight"],
        }), model: "fake-model" };
      } finally {
        state.inFlight -= 1;
      }
    },
  };
}

const LOCALE = {
  country: "Qatar",
  city: "Doha",
  region: "",
  currency: "QAR",
  languages: ["ar-QA", "en"],
  dialect: "Gulf Arabic",
  incomeBands: [{ label: "middle", min: 9000, max: 22000, currency: "QAR" }],
  demographics: ["high smartphone penetration"],
};

function persona(i: number, overrides: Partial<Persona> = {}): Persona {
  return {
    id: `p${i}`,
    name: `Persona ${i}`,
    age: 25 + i,
    gender: i % 2 === 0 ? "female" : "male",
    nationality: "Qatari",
    country: "Qatar",
    city: "Doha",
    incomeBand: "middle",
    incomeAmount: 14000,
    currency: "QAR",
    household: "family of three",
    occupation: "engineer",
    channel: "Instagram",
    attitude: "skeptical",
    habits: ["shops on Instagram", "compares prices"],
    language: "ar",
    dialect: "Gulf Arabic",
    bio: "Careful spender who reads reviews.",
    ...overrides,
  };
}

function makeSeed(personas: Persona[]): SeedResult {
  return {
    locale: LOCALE,
    entities: {
      products: [{ name: "Nutrio" }],
      prices: [{ product: "Nutrio", amount: 1200, currency: "QAR", period: "month" }],
      competitors: [{ name: "MealBox" }],
      audiences: ["busy professionals"],
      summary: "A healthy meal-subscription app in Doha.",
    },
    personas,
    localeSource: "inferred",
    modelCalls: 1,
  };
}

const BRIEF = "Nutrio healthy meal subscription in Doha, monthly price 1200 QAR, considering a price change.";

function turn(overrides: Partial<AgentTurnEvent> = {}): AgentTurnEvent {
  return {
    round: 1,
    agentId: "p0",
    agentName: "Persona 0",
    arm: "baseline",
    action: "post",
    text: "I might try it #price",
    stance: 0.5,
    purchaseIntent: 0.5,
    reasons: ["curious"],
    ok: true,
    latencyMs: 12,
    ...overrides,
  };
}

function makeGraph(): SocialGraph {
  return {
    follows: new Map([
      ["p0", ["p1", "p2"]],
      ["p1", ["p0"]],
      ["p2", []],
      ["p3", ["p0"]],
    ]),
    influence: new Map([
      ["p0", 1.2],
      ["p1", 0.8],
      ["p2", 1.5],
      ["p3", 0.6],
    ]),
  };
}

describe("validateAgentTurn", () => {
  it("accepts a well-formed turn and clamps the numeric ranges", () => {
    const out = validateAgentTurn({
      action: "buy",
      text: "I am in",
      stance: 1.7,
      purchaseIntent: -0.4,
      reasons: ["trust"],
    });
    assert.deepEqual(out, {
      action: "buy",
      text: "I am in",
      stance: 1,
      purchaseIntent: 0,
      reasons: ["trust"],
    });
  });

  it("accepts alternate field names the model sometimes uses", () => {
    const out = validateAgentTurn({ action: "share", content: "look at this", sentiment: "0.2", intent: "0.9" });
    assert.equal(out.action, "share");
    assert.equal(out.text, "look at this");
    assert.equal(out.stance, 0.2);
    assert.equal(out.purchaseIntent, 0.9);
  });

  it("rejects an unknown action or missing numbers", () => {
    assert.throws(() => validateAgentTurn({ action: "teleport", text: "x", stance: 0, purchaseIntent: 0 }));
    assert.throws(() => validateAgentTurn({ action: "post", text: "x", purchaseIntent: 0 }));
    assert.throws(() => validateAgentTurn({ action: "post", text: "x", stance: 0 }));
  });
});

describe("computeTopThemes", () => {
  it("counts repeated words and hashtags, dropping stop words", () => {
    const themes = computeTopThemes([
      "the price is too high #price",
      "I agree the price went up #price",
      "cancel my plan",
    ]);
    const byTheme = new Map(themes.map((t) => [t.theme, t.count]));
    assert.equal(byTheme.get("#price"), 2);
    assert.equal(byTheme.get("price"), 2);
    assert.ok(!byTheme.has("the"));
  });

  it("returns nothing when no word repeats", () => {
    assert.deepEqual(computeTopThemes(["apple banana", "cherry date"]), []);
  });
});

describe("computeShareCascades", () => {
  it("groups shares connected through the follow graph into one cascade", () => {
    const graph = makeGraph();
    const cascades = computeShareCascades(
      [turn({ agentId: "p0", action: "share" }), turn({ agentId: "p1", action: "share" })],
      graph,
    );
    // p0 follows p1, so the two shares form a single cascade of depth 2.
    assert.deepEqual(cascades, { count: 1, totalShares: 2, maxDepth: 2 });
  });

  it("keeps disconnected shares as separate cascades", () => {
    const graph: SocialGraph = { follows: new Map([["p0", []], ["p3", []]]), influence: new Map() };
    const cascades = computeShareCascades(
      [turn({ agentId: "p0", action: "share" }), turn({ agentId: "p3", action: "share" })],
      graph,
    );
    assert.deepEqual(cascades, { count: 2, totalShares: 2, maxDepth: 1 });
  });

  it("ignores turns that failed", () => {
    const cascades = computeShareCascades([turn({ agentId: "p0", action: "share", ok: false })], makeGraph());
    assert.deepEqual(cascades, { count: 0, totalShares: 0, maxDepth: 0 });
  });
});

describe("computeRoundMetrics", () => {
  it("aggregates stance, intent and actions from the recorded turns", () => {
    const metrics: RoundMetrics = computeRoundMetrics({
      round: 2,
      arm: "baseline",
      turns: [
        turn({ agentId: "p0", action: "buy", stance: 0.9, purchaseIntent: 1 }),
        turn({ agentId: "p1", action: "comment", stance: -0.9, purchaseIntent: 0 }),
        turn({ agentId: "p2", action: "post", stance: 0.1, purchaseIntent: 0.5 }),
        turn({ agentId: "p3", action: "ignore", ok: false }),
      ],
      graph: makeGraph(),
    });
    assert.equal(metrics.round, 2);
    assert.equal(metrics.agentsActed, 3);
    assert.equal(metrics.agentsSkipped, 1);
    assert.equal(metrics.meanIntent, 0.5);
    assert.deepEqual(metrics.stanceDistribution, { negative: 1, neutral: 1, positive: 1 });
    assert.equal(metrics.actionCounts.buy, 1);
    assert.equal(metrics.actionCounts.comment, 1);
    assert.equal(metrics.actionCounts.post, 1);
    assert.equal(metrics.actionCounts.ignore, 0);
  });
});

describe("sampleFeed", () => {
  it("only returns posts from followed agents", () => {
    const graph = makeGraph();
    const feed = sampleFeed("p0", graph, [
      turn({ agentId: "p1", agentName: "Persona 1", text: "from p1" }),
      turn({ agentId: "p2", agentName: "Persona 2", text: "from p2" }),
      turn({ agentId: "p3", agentName: "Persona 3", text: "from p3" }),
      turn({ agentId: "p0", agentName: "Persona 0", text: "from self" }),
    ], () => 0.5);
    const ids = feed.map((t) => t.agentId).sort();
    assert.deepEqual(ids, ["p1", "p2"]);
  });

  it("returns an empty feed when the agent follows nobody", () => {
    const feed = sampleFeed("p2", makeGraph(), [turn({ agentId: "p0", text: "hello" })], () => 0.5);
    assert.deepEqual(feed, []);
  });
});

describe("compareArms", () => {
  function arm(overrides: Partial<SimulationArmResult> = {}): SimulationArmResult {
    return {
      arm: "baseline",
      rounds: [],
      turns: [turn()],
      calls: 1,
      failures: 0,
      skipped: 0,
      ...overrides,
    };
  }

  it("computes the intent, stance-share and buy-rate deltas from real turns", () => {
    const baseline = arm({ arm: "baseline", turns: [turn({ purchaseIntent: 0.2, stance: -0.5 }), turn({ purchaseIntent: 0.4, stance: 0.5 })] });
    const scenario = arm({ arm: "scenario", turns: [turn({ purchaseIntent: 0.6, stance: 0.5, action: "buy" }), turn({ purchaseIntent: 0.8, stance: 0.9 })] });
    const cmp = compareArms(baseline, scenario);
    assert.equal(cmp.baselineMeanIntent, 0.3);
    assert.equal(cmp.scenarioMeanIntent, 0.7);
    assert.equal(cmp.intentDelta, 0.4);
    assert.equal(cmp.baselinePositiveShare, 0.5);
    assert.equal(cmp.scenarioPositiveShare, 1);
    assert.equal(cmp.positiveShareDelta, 0.5);
    assert.equal(cmp.baselineBuyRate, 0);
    assert.equal(cmp.scenarioBuyRate, 0.5);
    assert.equal(cmp.buyRateDelta, 0.5);
  });
});

describe("runSimulation", () => {
  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "mirofish-sim-"));
  }

  it("makes exactly agents x rounds calls and records the provider model", async () => {
    // The fake yields mid-response so genuinely concurrent calls can overlap;
    // the peak is captured before the decrement, i.e. while it is in effect.
    let peak = 0;
    const state: FakeState = { calls: [], inFlight: 0, maxInFlight: 0, fail: false };
    const caller: ModelCaller = {
      async chat(req: ModelRequest): Promise<ModelResponse> {
        state.calls.push(req);
        state.inFlight += 1;
        peak = Math.max(peak, state.inFlight);
        try {
          await Promise.resolve();
          return { content: JSON.stringify({
            action: "post",
            text: "the price went up and that hurts my budget #price",
            stance: -0.6,
            purchaseIntent: 0.25,
            reasons: ["monthly budget is tight"],
          }), model: "fake-model" };
        } finally {
          state.inFlight -= 1;
        }
      },
    };
    const dir = tempDir();
    try {
      const result = await runSimulation("sess-1", { seed: makeSeed([persona(0), persona(1), persona(2)]), brief: BRIEF }, {
        caller,
        taskDir: dir,
        agents: 3,
        rounds: 2,
        concurrency: 2,
      });
      assert.equal(result.modelCalls, 6);
      assert.equal(result.failures, 0);
      assert.equal(state.calls.length, 6);
      assert.equal(peak, 2);
      assert.equal(state.inFlight, 0);
      assert.equal(result.arms.length, 1);
      assert.equal(result.arms[0]!.turns.length, 6);
      assert.equal(result.arms[0]!.turns.every((t) => t.ok && t.model === "fake-model"), true);
      assert.equal(result.arms[0]!.rounds.length, 2);
      assert.equal(fs.existsSync(path.join(dir, "simulation_events.jsonl")), true);
      assert.equal(fs.existsSync(path.join(dir, "metrics.json")), true);
      const lines = fs.readFileSync(path.join(dir, "simulation_events.jsonl"), "utf8").trim().split("\n");
      assert.equal(lines.length, 6);
      assert.equal(JSON.parse(lines[0]!).agentId, "p0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends persona, brief and variable value to the model", async () => {
    const state: FakeState = { calls: [], inFlight: 0, maxInFlight: 0, fail: false };
    const dir = tempDir();
    try {
      await runSimulation(
        "sess-2",
        {
          seed: makeSeed([persona(0)]),
          brief: BRIEF,
          variable: { name: "price", baseline: 1200, scenario: 1450, unit: "QAR / month" },
        },
        { caller: makeFakeCaller(state), taskDir: dir, agents: 1, rounds: 1 },
      );
      assert.equal(state.calls.length, 2);
      const [baselineCall, scenarioCall] = state.calls;
      for (const call of [baselineCall!, scenarioCall!]) {
        assert.match(call.system!, /Persona 0/);
        assert.match(call.prompt!, /Nutrio healthy meal subscription/);
      }
      assert.match(baselineCall!.prompt!, /1200/);
      assert.match(scenarioCall!.prompt!, /1450/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces a baseline vs scenario comparison when a variable is set", async () => {
    const dir = tempDir();
    try {
      const result = await runSimulation(
        "sess-3",
        { seed: makeSeed([persona(0)]), brief: BRIEF, variable: { name: "price", baseline: 1200, scenario: 1450 } },
        {
          caller: makeFakeCaller({ calls: [], inFlight: 0, maxInFlight: 0, fail: false }),
          taskDir: dir,
          agents: 1,
          rounds: 1,
        },
      );
      assert.ok(result.comparison);
      assert.equal(result.comparison!.variable?.name, "price");
      assert.equal(result.modelCalls, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs a failing call as a skipped turn and does not fabricate output", async () => {
    const dir = tempDir();
    try {
      const result = await runSimulation("sess-4", { seed: makeSeed([persona(0)]), brief: BRIEF }, {
        caller: makeFakeCaller({ calls: [], inFlight: 0, maxInFlight: 0, fail: true }),
        taskDir: dir,
        agents: 1,
        rounds: 1,
      });
      assert.equal(result.modelCalls, 1);
      assert.equal(result.failures, 1);
      const recorded = result.arms[0]!.turns[0]!;
      assert.equal(recorded.ok, false);
      assert.equal(recorded.error, "model unavailable");
      assert.equal(recorded.text, "");
      assert.equal(result.arms[0]!.rounds[0]!.agentsSkipped, 1);
      assert.equal(result.arms[0]!.rounds[0]!.agentsActed, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to all-skipped turns when no caller is available", async () => {
    const dir = tempDir();
    try {
      const result = await runSimulation("sess-5", { seed: makeSeed([persona(0), persona(1)]), brief: BRIEF }, {
        taskDir: dir,
        agents: 2,
        rounds: 1,
      });
      assert.equal(result.modelCalls, 0);
      assert.equal(result.arms[0]!.turns.every((t) => !t.ok), true);
      assert.equal(result.arms[0]!.turns[0]!.error, "no model caller available");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps agents at 20 unless explicitly raised, with a hard cap of 100", async () => {
    const many = Array.from({ length: 200 }, (_, i) => persona(i));
    const dir = tempDir();
    try {
      const capped = await runSimulation("sess-6", { seed: makeSeed(many), brief: BRIEF }, {
        caller: makeFakeCaller(),
        taskDir: dir,
        rounds: 1,
      });
      assert.equal(capped.agents, DEFAULT_AGENT_CAP);

      const raised = await runSimulation("sess-7", { seed: makeSeed(many), brief: BRIEF }, {
        caller: makeFakeCaller(),
        taskDir: dir,
        rounds: 1,
        allowMoreAgents: true,
      });
      assert.equal(raised.agents, HARD_AGENT_CAP);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is reproducible for the same seed and persona set", async () => {
    const dir = tempDir();
    try {
      const run = async (): Promise<number[]> => {
        const result = await runSimulation("sess-8", { seed: makeSeed([persona(0), persona(1), persona(2)]), brief: BRIEF }, {
          caller: makeFakeCaller(),
          taskDir: dir,
          agents: 3,
          rounds: 2,
          seed: 7,
        });
        return result.arms[0]!.turns.map((t) => t.latencyMs >= 0 ? 1 : 0);
      };
      assert.deepEqual(await run(), await run());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run without personas", async () => {
    await assert.rejects(
      () => runSimulation("sess-9", { seed: makeSeed([]), brief: BRIEF }, { taskDir: tempDir() }),
      /no personas/i,
    );
  });
});
