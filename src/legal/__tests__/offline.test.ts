import assert from "node:assert/strict";
import { test } from "node:test";
import { createLegalModelPort } from "../model/legalModelPort.js";

test("an unavailable local model fails closed even with cloud failover configured", async () => {
  const originalFetch = globalThis.fetch;
  const destinations: string[] = [];
  globalThis.fetch = async (input) => {
    const destination = String(input);
    destinations.push(destination);
    throw new Error("local Ollama unavailable");
  };
  try {
    const config = {
      localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:9",
      failover: { baseUrl: "https://cloud.invalid/v1", model: "forbidden-cloud" },
    };
    const { port } = createLegalModelPort({ config });
    await assert.rejects(port({ model: config.localModel, messages: [{ role: "user", content: "synthetic" }] }), /unavailable/);
    assert.deepEqual(destinations, ["http://127.0.0.1:9/api/chat"]);
    assert.equal(destinations.some((destination) => destination.includes("cloud.invalid")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
