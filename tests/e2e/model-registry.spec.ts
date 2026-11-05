import { expect, test } from "@playwright/test";
import { anthropicToolStub, failingModelsStub, ollamaTagsStub, openaiToolStub } from "./stubs/servers";

const secret = "sk-test-REDACTED-0000";

test("E1 ollama stub lists a model", async ({ request }) => {
  const stub = await ollamaTagsStub();
  try {
    const response = await request.get(`${stub.url}/api/tags`);
    expect(response.ok()).toBeTruthy();
    await expect(response.json()).resolves.toEqual({ models: [{ name: "qwen-test:latest" }] });
  } finally {
    await stub.close();
  }
});

test("E2 openai stub lists models and does not echo a key", async ({ request }) => {
  const stub = await openaiToolStub();
  try {
    const response = await request.get(`${stub.url}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
    const body = JSON.stringify(await response.json());
    expect(body).toContain("alpha");
    expect(body).not.toContain(secret);
  } finally {
    await stub.close();
  }
});

test("E3 and E4 a closed list returns 500", async ({ request }) => {
  const stub = await failingModelsStub();
  try {
    const response = await request.get(`${stub.url}/v1/models`);
    expect(response.status()).toBe(500);
  } finally {
    await stub.close();
  }
});

test("E7 anthropic stub rejects a missing key", async ({ request }) => {
  const stub = await anthropicToolStub(secret);
  try {
    const response = await request.post(stub.url, { data: { ping: true } });
    expect(response.status()).toBe(400);
    expect(await response.text()).not.toContain(secret);
  } finally {
    await stub.close();
  }
});
