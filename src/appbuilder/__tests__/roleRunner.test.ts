import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Config } from "../../config.js";
import { OllamaClient } from "../../ollama.js";
import type { AppProject } from "../types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createRunAgentRoleRunner } from "../engine.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-role-runner-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;
process.env.LOAM_TEST_CLOUD_KEY = "sk-role-runner-test";

function config(): Config {
  return {
    model: "glm-5.4-flash",
    fallbackModel: "qwen2.5:14b",
    ollamaUrl: "http://127.0.0.1:11434",
    failover: {
      providers: [{ id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "glm-5.4-flash", apiKeyEnv: "LOAM_TEST_CLOUD_KEY", enabled: true }],
    },
    vision: { enabled: true, maxImagesPerStep: 2 },
    agent: { maxSteps: 4, temperature: 0, requestTimeoutMs: 1000 },
    orchestration: { returnDirect: { enabled: true } },
    compression: { enabled: false },
  } as Config;
}

function project(): AppProject {
  return {
    id: "app_rolefast",
    taskId: "task_rolefast",
    title: "Fast app",
    description: "Todo list",
    templateId: "web-app",
    features: [],
    workspaceDir: tmp,
    appDir: "app",
    defaultFlavor: "quick",
    status: "idle",
    activeVersion: null,
    settings: { defaultTier: "auto", raceBranches: 2, verifyTier: "standard", devServerPort: null },
    remixOfProjectId: null,
    remixOfVersion: null,
    depsMode: "shared",
    ai: { baseUrl: null, model: null, dailyTokenCap: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("AppBuilder role turns delegate final verification to the project gate", async () => {
  const modelCalls: unknown[] = [];
  const ollama = new OllamaClient("http://127.0.0.1:11434");
  ollama.chat = async (options) => {
    modelCalls.push(options);
    return {
      content: "Implemented and tested.",
      toolCalls: [],
      model: "glm-5.4-flash",
      usage: { promptTokens: 10, completionTokens: 4, durationMs: 5 },
    };
  };
  const runRoleTurn = createRunAgentRoleRunner({
    cfg: config,
    ollama: () => ollama,
    baseTools: () => new ToolRegistry(),
  });

  const result = await runRoleTurn({
    project: project(),
    runId: "run_rolefast",
    role: "engineer",
    step: "implement",
    system: "Build quickly without weakening checks.",
    prompt: "Build a todo list",
    tools: [],
    maxToolCalls: 0,
  });

  assert.equal(result.text, "Implemented and tested.");
  assert.equal(modelCalls.length, 1, "the project-level verifier owns final verification, not another model call per role");
});

test("AppBuilder roles retain single-file and batch write choices", async () => {
  const offered: string[][] = [];
  const ollama = new OllamaClient("http://127.0.0.1:11434");
  ollama.chat = async (options) => {
    offered.push((options.tools ?? []).map((tool) => tool.function.name));
    return { content: "done", toolCalls: [], model: "glm-5.4-flash", usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  };
  const registry = new ToolRegistry();
  for (const name of ["file_read", "file_write", "file_write_batch", "app_verify"]) {
    registry.register({ name, description: "", parameters: {}, async run() { return { ok: true, content: "ok" }; } });
  }
  const runRoleTurn = createRunAgentRoleRunner({ cfg: config, ollama: () => ollama, baseTools: () => registry });
  const tools = ["file_read", "file_write", "file_write_batch", "app_verify"];
  const input = { runId: "run_batch", role: "engineer" as const, step: "implement" as const, system: "build", prompt: "build", tools, maxToolCalls: 0 };
  await runRoleTurn({ ...input, project: project() });
  await runRoleTurn({ ...input, project: { ...project(), activeVersion: 1 } });

  assert.deepEqual(offered[0], ["file_read", "file_write", "file_write_batch", "app_verify"]);
  assert.deepEqual(offered[1], ["file_read", "file_write", "file_write_batch", "app_verify"]);
});

test("AppBuilder tools execute inside the attached project workspace", async () => {
  const workspaces: string[] = [];
  const registry = new ToolRegistry();
  registry.register({ name: "file_read", description: "", parameters: {}, async run(_args, ctx) {
    workspaces.push(ctx.workspace);
    return { ok: true, content: "guide" };
  } });
  let calls = 0;
  const ollama = new OllamaClient("http://127.0.0.1:11434");
  ollama.chat = async () => {
    calls += 1;
    return calls === 1
      ? { content: "", toolCalls: [{ function: { name: "file_read", arguments: { path: "app/LOAM_AGENT_GUIDE.md" } } }], model: "glm-5.4-flash", usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } }
      : { content: "done", toolCalls: [], model: "glm-5.4-flash", usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  };
  const runRoleTurn = createRunAgentRoleRunner({ cfg: config, ollama: () => ollama, baseTools: () => registry });
  const attached = project();
  await runRoleTurn({ project: attached, runId: "run_workspace", role: "engineer", step: "implement", system: "build", prompt: "build", tools: ["file_read"], maxToolCalls: 1 });
  assert.deepEqual(workspaces, [attached.workspaceDir]);
});

test("a passing app verification returns directly without another model turn", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "app_verify", description: "", parameters: {}, async run() {
    return { ok: true, content: "app_verify PASSED", returnDirect: true };
  } });
  let calls = 0;
  const ollama = new OllamaClient("http://127.0.0.1:11434");
  ollama.chat = async () => {
    calls += 1;
    return { content: "", toolCalls: [{ function: { name: "app_verify", arguments: {} } }], model: "glm-5.4-flash", usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  };
  const runRoleTurn = createRunAgentRoleRunner({ cfg: config, ollama: () => ollama, baseTools: () => registry });
  const result = await runRoleTurn({ project: project(), runId: "run_verified", role: "engineer", step: "implement", system: "build", prompt: "build", tools: ["app_verify"], maxToolCalls: 1 });
  assert.equal(calls, 1);
  assert.equal(result.text, "app_verify PASSED");
});
