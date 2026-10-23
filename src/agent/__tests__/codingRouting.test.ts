/**
 * Integration tests: coding-model routing wired into the agent loop (C17).
 *
 * The routing unit is covered in `llm/__tests__/codingRouter.test.ts`; these
 * tests cover the other half of the acceptance criterion: that a real
 * `runAgent` coding turn actually goes through the configured coder chain and
 * that the workspace edits it produces are attributed to the model that made
 * them. Everything runs against injected fakes — no network, no real model API.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { Config } from "../../config.js";
import type { ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";
import type { Emit } from "../events.js";
import type { CooldownStore, FailoverProvider, ProviderClient } from "../../llm/failover.js";
import type { Tool } from "../../tools/registry.js";

// The edit audit appends to `DATA_DIR/model-edits.jsonl`, and DATA_DIR is a
// module-level constant in `config.ts`. Point it at a temp folder *before* any
// value import that transitively loads config, so running these tests never
// writes fake edit records into the repository's data folder. The imports above
// are type-only and erased at runtime; the value imports below are dynamic for
// exactly this ordering reason.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-coding-routing-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");

const { runAgent } = await import("../loop.js");
const { ToolRegistry: RegistryCtor, str } = await import("../../tools/registry.js");
const { editModelCounts, readEditModelLog, recentEditModels, resetEditModelMemory } = await import("../../llm/modelAudit.js");
const { DATA_DIR } = await import("../../config.js");
// Importing the loop pulls in `server/runControl.js`; the eval runner pulls in
// `server/db.js`, whose `newId` lazily opens a SQLite file under DATA_DIR. Close
// it in `after()` so the temp data dir can be removed.
const { closeDb } = await import("../../server/sqliteStore.js");

type ToolRegistry = import("../../tools/registry.js").ToolRegistry;

let workspace = "";

before(() => {
  workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
});

after(() => {
  // Release the lazily-opened SQLite handle before deleting the temp data dir;
  // on Windows an open handle makes the directory removal fail with EPERM.
  closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.error(`[codingRouting] temp cleanup failed: ${String(err)}`);
  }
});

const CODER_KEY = "CODER_API_KEY";

function codingProvider(overrides: Partial<FailoverProvider> = {}): FailoverProvider {
  return {
    id: "coder",
    kind: "openai-compatible",
    baseUrl: "http://coder/v1",
    model: "coder-x",
    apiKeyEnv: CODER_KEY,
    enabled: true,
    ...overrides,
  };
}

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    model: "weak-default",
    fallbackModel: "",
    ollamaUrl: "http://localhost:11434",
    server: { host: "127.0.0.1", port: 3939 },
    agent: { maxSteps: 6, temperature: 0.2, requestTimeoutMs: 600000 },
    workspace,
    policy: {
      networkEnabled: true,
      allowOutsideWorkspaceRead: true,
      denyCommandPatterns: [],
      allowCommandPatterns: [],
      maxCommandSeconds: 180,
      sandboxMode: "workspace-write",
    },
    browser: { channel: "msedge", headless: false, viewport: { width: 1280, height: 800 } },
    computerUse: { enabled: false, screenshotDir: "/tmp/screenshots" },
    memory: { enabled: false, model: "", file: "", autoStore: false, recallTop: 0, minScore: 0, maxEntries: 0, dedupeThreshold: 0 },
    screen: { enabled: false, fps: 1, quality: 60, maxWidth: 1280 },
    vision: { enabled: false, maxImagesPerStep: 0 },
    selfImprove: { enabled: false, reviewEvery: 1, model: "", maxSteps: 1, writeApproval: false },
    evaluation: { enabled: false, intervalMinutes: 360, suite: "core", critique: false, keepRuns: 0, transcripts: false },
    selfPlay: { maxCases: 0 },
    orchestrator: { enabled: false, plannerModel: "", verifierModel: "", maxPlanSteps: 1, maxStepsPerWorker: 1, maxRevisionsPerStep: 1, maxReplans: 1, verifyFinal: false },
    mcpServers: {},
    compression: { enabled: false, thresholdPercent: 0.5, protectLead: 3, protectTail: 20, targetRatio: 0.2, model: "", contextWindow: {} },
    sessionLog: { enabled: false },
    subagent: { maxDepth: 2, maxConcurrentChildren: 4 },
    coding: { enabled: true, chain: ["coder-x"], logEdits: true },
    ...overrides,
  } as unknown as Config;
}

/** In-memory cooldown store: no provider failure ever leaves a process-wide mark. */
function memoryStore(): CooldownStore {
  const map = new Map<string, { expiresAt: number; backoffCount: number }>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => void map.set(key, entry),
    entries: () => [...map.entries()],
    save: () => {},
  };
}

/** A `file_write` tool: writes into the workspace so the edit really lands. */
function writeTool(): Tool {
  return {
    name: "file_write",
    description: "Write a file into the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    async run(args, ctx) {
      const target = path.join(ctx.workspace, str(args, "path"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, str(args, "content"), "utf8");
      return { ok: true, content: `wrote ${str(args, "path")}` };
    },
  };
}

const EDIT_CALL: OllamaToolCall = {
  function: { name: "file_write", arguments: { path: "src/app.ts", content: "export const answer = 1;\n" } },
};

/**
 * Fake client that plays `calls` on its first turn, then answers directly.
 * The first-turn-only shape keeps every run finite: the agent loop stops as soon
 * as a turn carries no tool calls.
 */
function finiteClient(calls: OllamaToolCall[], model = "weak-default"): OllamaClient {
  let count = 0;
  return {
    async chat(): Promise<ChatResult> {
      count++;
      if (count === 1) {
        return { content: "", toolCalls: calls, model, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
      }
      return { content: "done", toolCalls: [], model, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    },
  } as unknown as OllamaClient;
}

/** Provider client that plays the configured coder: one edit, then done. */
function coderClient(model: string): ProviderClient {
  let count = 0;
  return {
    async chat(): Promise<ChatResult> {
      count++;
      if (count === 1) {
        return { content: "", toolCalls: [EDIT_CALL], model, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
      }
      return { content: "done", toolCalls: [], model, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    },
  };
}

function registry(): ToolRegistry {
  const base = new RegistryCtor();
  base.registerAll([writeTool()]);
  return base.forAllowlist(["file_write"]);
}

describe("runAgent coding-model routing", () => {
  it("routes a coding turn through the configured coder and logs the edit model", async () => {
    resetEditModelMemory();
    const calls: string[] = [];
    const routed: Array<{ model: string; chain: string[]; providerId?: string }> = [];
    // One stateful client instance: the router builds a client per call, so a
    // fresh fake per call would restart its turn counter every step.
    const coder = coderClient("coder-x");

    const result = await runAgent({
      cfg: cfg({
        failover: { providers: [codingProvider()] },
        coding: { enabled: true, chain: ["coder-x"], logEdits: true },
      }),
      ollama: finiteClient([]),
      tools: registry(),
      emit: (() => {}) as Emit,
      prompt: "Fix the bug in src/app.ts",
      suppressFinal: true,
      maxSteps: 4,
      env: { [CODER_KEY]: "super-secret-coder-key" },
      cooldownStore: memoryStore(),
      createProviderClient: (provider: FailoverProvider) => {
        calls.push(provider.id);
        return coder;
      },
      onCodingRoute: (info) => routed.push(info),
    });

    assert.ok(calls.length >= 1 && calls[0] === "coder", `the coding turn must start with the configured coder, saw ${calls.join(" > ")}`);
    assert.equal(result.model, "coder-x", "the edit is attributed to the coder that produced it");
    assert.deepEqual(routed[0], { model: "coder-x", chain: ["coder-x"], providerId: "coder" });
    assert.deepEqual(editModelCounts(), { "coder-x": 1 }, "the model-edit audit names the coder");

    const record = recentEditModels()[0]!;
    assert.equal(record.tool, "file_write");
    assert.equal(record.path, "src/app.ts");
    assert.equal(record.ok, true);
    assert.ok(!JSON.stringify(record).includes("super-secret"), "no key material in the audit log");

    // The audit is persisted, not just kept in memory, and it must land in the
    // redirected DATA_DIR. Asserting where the write actually went (rather than
    // only that the repo stays clean) proves the isolation redirects the write
    // instead of the write silently failing, which would let the pollution check
    // pass vacuously.
    assert.equal(
      fs.realpathSync(DATA_DIR),
      fs.realpathSync(path.join(tmp, "data")),
      "DATA_DIR must resolve to the temp folder, not the repository",
    );
    const persisted = readEditModelLog();
    assert.ok(persisted.length >= 1, "the edit must be persisted to the audit file");
    assert.equal(persisted.at(-1)!.model, "coder-x");
    assert.ok(fs.existsSync(path.join(DATA_DIR, "model-edits.jsonl")), "the audit file must exist under the redirected data dir");
  });

  it("keeps the weak default model when routing is disabled", async () => {
    resetEditModelMemory();
    const ollama = finiteClient([EDIT_CALL], "weak-default");
    const result = await runAgent({
      cfg: cfg({ coding: { enabled: false, chain: ["coder-x"], logEdits: true } }),
      ollama,
      tools: registry(),
      emit: (() => {}) as Emit,
      prompt: "Fix the bug in src/app.ts",
      suppressFinal: true,
      maxSteps: 4,
    });

    assert.equal(result.model, "weak-default");
    assert.deepEqual(editModelCounts(), { "weak-default": 1 });
  });

  it("does not record edits when coding.logEdits is false", async () => {
    resetEditModelMemory();
    const calls: string[] = [];
    const coder = coderClient("coder-x");

    const result = await runAgent({
      cfg: cfg({
        failover: { providers: [codingProvider()] },
        coding: { enabled: true, chain: ["coder-x"], logEdits: false },
      }),
      ollama: finiteClient([]),
      tools: registry(),
      emit: (() => {}) as Emit,
      prompt: "Fix the bug in src/app.ts",
      suppressFinal: true,
      maxSteps: 4,
      env: { [CODER_KEY]: "super-secret-coder-key" },
      cooldownStore: memoryStore(),
      createProviderClient: () => {
        calls.push("coder");
        return coder;
      },
    });

    assert.ok(calls.length >= 1 && calls[0] === "coder", `the coding turn must start with the configured coder, saw ${calls.join(" > ")}`);
    assert.equal(result.model, "coder-x");
    assert.deepEqual(editModelCounts(), {}, "auditing disabled must leave the edit log empty");
  });

  it("falls back to the caller's client when the coding chain is unusable", async () => {
    resetEditModelMemory();
    // The chain names a coder whose key is missing, so no provider is usable and
    // the run falls back to the caller's client.
    const result = await runAgent({
      cfg: cfg({ failover: { providers: [codingProvider()] } }),
      ollama: finiteClient([EDIT_CALL], "weak-default"),
      tools: registry(),
      emit: (() => {}) as Emit,
      prompt: "Fix the bug in src/app.ts",
      suppressFinal: true,
      maxSteps: 4,
      env: {},
      cooldownStore: memoryStore(),
    });

    assert.equal(result.model, "weak-default");
    assert.deepEqual(editModelCounts(), { "weak-default": 1 });
  });

  it("does not log edits for a plain chat turn", async () => {
    resetEditModelMemory();
    await runAgent({
      cfg: cfg(),
      ollama: finiteClient([]),
      tools: registry(),
      emit: (() => {}) as Emit,
      prompt: "What is the capital of France?",
      suppressFinal: true,
      maxSteps: 4,
    });

    assert.deepEqual(editModelCounts(), {}, "a chat turn must not touch the edit audit log");
  });
});

/**
 * Neo N10: an output type narrows the run's tool set at the agent boundary.
 *
 * The router decides *which* tools belong to an output type
 * (`llm/__tests__/router.test.ts`); these tests assert what `runAgent` actually
 * hands to the model. Regression guard: narrowing to the pipeline alone left the
 * model without `finish` (the only tool that emits `done` and runs the workspace
 * gates) and, in a mode that grants no pipeline tool, with an empty tool set.
 */
describe("runAgent output-type tool narrowing", () => {
  /** Registry holding a pipeline tool plus every tool the run must keep. */
  function pipelineRegistry(): ToolRegistry {
    const base = new RegistryCtor();
    for (const name of ["loam_studio", "loam_document", "office_export", "finish", "think", "artifact_publish", "file_read", "file_stat", "file_list"]) {
      base.register({
        name,
        description: `${name} tool`,
        parameters: { type: "object", properties: {} },
        async run() {
          return { ok: true, content: "ok" };
        },
      });
    }
    return base.forAllowlist(["loam_studio", "loam_document", "office_export", "finish", "think", "artifact_publish", "file_read", "file_stat", "file_list"]);
  }

  /** Capture the tool names the model is offered on its first turn. */
  function recordingClient(model = "weak-default"): { ollama: OllamaClient; seen: string[] } {
    const seen: string[] = [];
    let count = 0;
    const ollama = {
      async chat(options: { tools?: Array<{ function?: { name?: string } }> }): Promise<ChatResult> {
        if (count === 0) seen.push(...(options.tools ?? []).map((tool) => tool.function?.name ?? ""));
        count++;
        return { content: "done", toolCalls: [] as OllamaToolCall[], model, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
      },
    } as unknown as OllamaClient;
    return { ollama, seen };
  }

  it("keeps the control surface when an output type narrows the tools", async () => {
    const { ollama, seen } = recordingClient();
    await runAgent({
      cfg: cfg(),
      ollama,
      tools: pipelineRegistry(),
      emit: (() => {}) as Emit,
      prompt: "Build a deck",
      suppressFinal: true,
      maxSteps: 3,
      outputType: "slides",
    });

    assert.ok(seen.length > 0, "the model must receive tools");
    for (const essential of ["finish", "artifact_publish", "file_read"]) {
      assert.ok(seen.includes(essential), `a Slides run must keep ${essential}; got ${JSON.stringify(seen)}`);
    }
    assert.ok(seen.includes("loam_studio"), "the Slides pipeline tool stays in the set");
  });

  it("never leaves the model with an empty tool set", async () => {
    // A read-only mode grants no pipeline tool, so the old narrowing produced []
    // and the run could neither work nor finish.
    const base = new RegistryCtor();
    for (const name of ["finish", "think", "file_read", "file_stat", "file_list"]) {
      base.register({
        name,
        description: `${name} tool`,
        parameters: { type: "object", properties: {} },
        async run() {
          return { ok: true, content: "ok" };
        },
      });
    }
    const { ollama, seen } = recordingClient();
    await runAgent({
      cfg: cfg(),
      ollama,
      tools: base.forAllowlist(["finish", "think", "file_read", "file_stat", "file_list"]),
      emit: (() => {}) as Emit,
      prompt: "Answer a question",
      suppressFinal: true,
      maxSteps: 3,
      outputType: "website",
    });

    assert.ok(seen.length > 0, "an output-type run must never receive an empty tool set");
    assert.ok(seen.includes("finish"), `a run must always be able to finish; got ${JSON.stringify(seen)}`);
  });

  it("leaves an `auto` run's scope untouched", async () => {
    const { ollama, seen } = recordingClient();
    const tools = pipelineRegistry();
    const before = tools.names().length;
    await runAgent({
      cfg: cfg(),
      ollama,
      tools,
      emit: (() => {}) as Emit,
      prompt: "Do something general",
      suppressFinal: true,
      maxSteps: 3,
      outputType: "auto",
    });

    assert.equal(seen.length, before, `auto must not narrow the run; got ${JSON.stringify(seen)}`);
  });
});
