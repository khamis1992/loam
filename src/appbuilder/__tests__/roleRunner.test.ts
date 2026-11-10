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
