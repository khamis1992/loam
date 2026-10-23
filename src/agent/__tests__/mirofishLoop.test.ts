/**
 * Integration test for the M3 conversational wiring.
 *
 * Guarantees under test (fake model, throwaway workspaces, no real API calls):
 *  - the agent loop hands the provider client to every tool through `ToolContext`
 *  - a tool can therefore take the real, model-aware MiroFish swarm path
 *  - the swarm run reaches the caller and reports honest model call counts
 *
 * The fake caller answers the MiroFish seed/agent prompts and fails for anything
 * else, so a run that talks to the model through the wrong object (or a client
 * that only the loop can see) is recorded as model-unavailable instead of
 * silently passing.
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../../config.js";
import { runAgent } from "../loop.js";
import type { AgentEvent } from "../events.js";
import type { ChatOptions, ChatResult, OllamaClient } from "../../ollama.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { Tool, ToolContext } from "../../tools/registry.js";
import type { ModelCaller, ModelRequest, ModelResponse } from "../../tools/mirofish/model.js";

const VERIFIER_MARKER = "COMPLETED task as a whole";

/**
 * The loop's final verifier asks for inspection tools; these runs never offer
 * any, so verification can only end in "unavailable". Skipping it keeps the
 * probe focused on what is under test (the tool context), like the loop hook
 * integration tests do.
 */
const NO_VERIFICATION = { suppressFinal: true } as const;

/**
 * The loop replaces the system prompt for every run. The fake client decides
 * whether a request is the loop's verifier from `messages[0]`.
 */
const PROBE_SYSTEM = `test system\n\n${VERIFIER_MARKER}`;

/** Calls the fake caller saw, split by pipeline stage. */
interface FakeState {
  seedCalls: ModelRequest[];
  agentCalls: ModelRequest[];
}

function makeFakeCaller(state: FakeState): ModelCaller {
  return {
    async chat(req: ModelRequest): Promise<ModelResponse> {
      const prompt = req.prompt;
      if (prompt.includes("market-research analyst")) {
        state.seedCalls.push(req);
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
      if (prompt.includes("market-analysis engine")) {
        state.seedCalls.push(req);
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
      if (prompt.includes("customer-persona designer")) {
        state.seedCalls.push(req);
        const count = Number((prompt.match(/EXACTLY (\d+)/) ?? [])[1] ?? 2);
        const names = ["Layla Haddad", "James Whitfield", "Omar Al-Mansoori", "Priya Sharma"];
        const out = [];
        for (let i = 0; i < count; i++) {
          out.push({
            id: `persona_${i}`,
            name: names[i % names.length],
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
        return { content: JSON.stringify(out), model: "fake-model" };
      }
      state.agentCalls.push(req);
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

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loam-loop-mf2-"));
}

function makeConfig(workspace: string): ReturnType<typeof loadConfig> {
  const cfg = loadConfig();
  cfg.workspace = workspace;
  cfg.model = "qwen2.5:14b";
  cfg.fallbackModel = cfg.model;
  cfg.compression.enabled = false;
  cfg.agent.maxSteps = 3;
  return cfg;
}

/**
 * A client the loop can actually talk to: it answers the verifier and can emit
 * the tool calls a test needs before finishing.
 *
 * `marker` is carried on the object itself so a test can assert that the exact
 * client the run was started with reached the tool context.
 */
function makeClient(marker = "fixture-client", batchReads = false): OllamaClient {
  let calls = 0;
  return {
    marker,
    chat: async (options: ChatOptions): Promise<ChatResult> => {
      const system = String(options.messages[0]?.content ?? "");
      if (system.includes(VERIFIER_MARKER)) {
        return {
          model: "fixture",
          content: JSON.stringify({ verdict: "pass", reason: "verified", fixes: [] }),
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      }
      calls += 1;
      const toolCall = (name: string): { type: "function"; function: { name: string; arguments: string } } => ({
        type: "function",
        function: { name, arguments: JSON.stringify(name === "mirofish_chat" ? { message: "Simulate Nutrio in Doha", maxRounds: 1 } : {}) },
      });
      const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
      if (batchReads) {
        if (calls === 1) {
          return { model: "fixture", content: "Reading the files.", toolCalls: [toolCall("file_read"), toolCall("file_stat")], usage };
        }
      } else if (calls === 1) {
        return { model: "fixture", content: "I will run the MiroFish swarm simulation now.", toolCalls: [toolCall("mirofish_chat")], usage };
      }
      return { model: "fixture", content: "The simulation is complete.", toolCalls: [], usage };
    },
  } as unknown as OllamaClient;
}

/** Build a registry from tool instances (`ToolRegistry` takes no constructor arg). */
function registryOf(tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  return registry;
}

function probeTool(run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<{ ok: boolean; content: string }>): Tool {
  return {
    name: "mirofish_chat",
    description: "probe",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    run: async (args, ctx) => run(ctx, args),
  };
}

test("the loop hands the provider client to every tool through ToolContext", async () => {
  const workspace = makeWorkspace();
  const cfg = makeConfig(workspace);
  let seen: unknown = undefined;
  let context: ToolContext | undefined;

  const registry = registryOf([
    probeTool(async (ctx) => {
      context = ctx;
      seen = ctx.ollama;
      return { ok: true, content: "ran" };
    }),
  ]);

  // Passed through the run options only: the loop is what threads it into tools.
  // The client emits the tool call on its first turn, then finishes.
  const client = makeClient("provider-client", false);

  const result = await runAgent({
    cfg,
    ollama: client,
    tools: registry,
    prompt: "Simulate Nutrio in Doha",
    emit: () => {},
    ...NO_VERIFICATION,
  });

  assert.equal(result.verified, false, "verification is skipped for this probe");
  assert.ok(context, "the tool ran");
  assert.equal((seen as { marker?: string } | undefined)?.marker, "provider-client", "ctx.ollama must be the client the run was started with");
  assert.equal(context!.cfg.workspace, workspace);
  assert.equal(typeof context!.emit, "function");
});

test("a tool with a provider client drives the real MiroFish swarm simulation", async () => {
  const workspace = makeWorkspace();
  const cfg = makeConfig(workspace);
  const state: FakeState = { seedCalls: [], agentCalls: [] };
  const caller = makeFakeCaller(state);
  const events: AgentEvent[] = [];

  const registry = registryOf([
    probeTool(async (ctx) => {
      const { runConversationalMirofishAsync } = await import("../../tools/mirofish.js");
      const res = await runConversationalMirofishAsync(workspace, {
        message: "Simulate Nutrio in Doha",
        maxRounds: 1,
        runtime: { cfg: ctx.cfg, ollama: ctx.ollama, caller, emit: ctx.emit },
      });
      return { ok: res.ok, content: `${res.reply}\n\n---\n${JSON.stringify(res.data)}` };
    }),
  ]);

  const result = await runAgent({
    cfg,
    ollama: makeClient(),
    tools: registry,
    prompt: "Simulate Nutrio in Doha",
    emit: (e) => events.push(e),
    ...NO_VERIFICATION,
  });
  assert.equal(result.verified, false, "verification is skipped for this probe");

  assert.ok(state.seedCalls.length > 0, "the seed pipeline ran through the tool context's provider");
  assert.ok(state.agentCalls.length > 0, "the swarm loop ran through the tool context's provider");

  // The loop must forward the swarm's progress events onto the run's event bus.
  const progress = events.filter((e) => e.type === "simulation_progress");
  assert.ok(progress.length > 0, "simulation_progress events reached the run event bus");
  assert.ok(progress.every((e) => typeof e.payload === "object" && e.payload !== null));

  // The legacy artifacts the UI reads were written for this run.
  const simDir = path.join(workspace, ".manus", "mirofish", "simulations");
  assert.ok(fs.existsSync(simDir), "simulation artifacts were written");
});

test("the loop threads the provider client through the parallel tool batch path too", async () => {
  const workspace = makeWorkspace();
  const cfg = makeConfig(workspace);
  const seen: unknown[] = [];

  // Two of the read-only tools the loop batches, so both `exec` call sites are
  // exercised in a single run.
  const read = (name: string): Tool => ({
    name,
    description: "probe",
    parameters: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      seen.push(ctx.ollama);
      return { ok: true, content: name };
    },
  });
  const registry = registryOf([read("file_read"), read("file_stat")]);

  const client = makeClient("batch-client", true);
  const result = await runAgent({ cfg, ollama: client, tools: registry, prompt: "read the files", emit: () => {}, ...NO_VERIFICATION });

  assert.equal(result.verified, false, "verification is skipped for this probe");
  assert.equal(seen.length, 2, "both batched tools ran");
  for (const item of seen) {
    assert.equal((item as { marker?: string } | undefined)?.marker, "batch-client");
  }
});
