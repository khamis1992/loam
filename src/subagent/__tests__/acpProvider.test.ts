import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createAcpProvider } from "../acpProvider.js";
import type { SubagentEvent } from "../types.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp.mjs");

interface RunOptions {
  mode?: string;
  permissionPolicy?: "allow" | "reject";
  timeoutMs?: number;
  graceMs?: number;
  env?: Record<string, string>;
}

async function run(opts: RunOptions = {}) {
  const provider = createAcpProvider();
  const handle = await provider.start({
    provider: "acp",
    prompt: "do the thing",
    cwd: process.cwd(),
    command: process.execPath,
    args: [FIXTURE],
    permissionPolicy: opts.permissionPolicy ?? "reject",
    timeoutMs: opts.timeoutMs ?? 5000,
    graceMs: opts.graceMs ?? 100,
    env: {
      FAKE_ACP_MODE: opts.mode ?? "normal",
      ...(opts.env ?? {}),
    },
  });
  const texts: string[] = [];
  const events: SubagentEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    if (event.type === "text") texts.push(event.text);
  }
  const result = await handle.result();
  return { handle, texts, events, result };
}

test("ACP provider performs initialize -> session/new -> session/prompt and returns text", async () => {
  const { result, texts } = await run();
  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "hello world");
  assert.deepEqual(texts, ["hello ", "world"]);
});

test("ACP provider answers session/request_permission with the reject policy", async () => {
  const { result } = await run({ mode: "permission", permissionPolicy: "reject" });
  assert.equal(result.stopReason, "completed");
  assert.match(result.text, /"outcome":"cancelled"/);
});

test("ACP provider answers session/request_permission with the allow policy", async () => {
  const { result } = await run({ mode: "permission", permissionPolicy: "allow" });
  assert.equal(result.stopReason, "completed");
  assert.match(result.text, /"outcome":"selected"/);
  assert.match(result.text, /"optionId":"allow-once"/);
});

test("ACP provider reports a timeout when the child never responds", async () => {
  const { result } = await run({ mode: "silent", timeoutMs: 200, graceMs: 50 });
  assert.equal(result.stopReason, "timeout");
});

test("ACP provider cancels a hung child", async () => {
  const provider = createAcpProvider();
  const handle = await provider.start({
    provider: "acp",
    prompt: "hang",
    cwd: process.cwd(),
    command: process.execPath,
    args: [FIXTURE],
    timeoutMs: 5000,
    graceMs: 50,
    env: { FAKE_ACP_MODE: "hang" },
  });
  handle.cancel();
  const result = await handle.result();
  assert.equal(result.stopReason, "cancelled");
});

test("ACP provider cancels when the parent signal aborts before startup", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = createAcpProvider();
  const handle = await provider.start({
    provider: "acp",
    prompt: "x",
    cwd: process.cwd(),
    command: process.execPath,
    args: [FIXTURE],
    timeoutMs: 5000,
    graceMs: 50,
    env: { FAKE_ACP_MODE: "normal" },
    signal: controller.signal,
  });
  const result = await handle.result();
  assert.equal(result.stopReason, "cancelled");
});

test("ACP provider cancels when the parent signal aborts during startup", async () => {
  const controller = new AbortController();
  const provider = createAcpProvider();
  const startPromise = provider.start({
    provider: "acp",
    prompt: "x",
    cwd: process.cwd(),
    command: process.execPath,
    args: [FIXTURE],
    timeoutMs: 5000,
    graceMs: 50,
    env: { FAKE_ACP_INIT_DELAY_MS: "300" },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const handle = await startPromise;
  const result = await handle.result();
  assert.equal(result.stopReason, "cancelled");
});

test("ACP child env is scrubbed of credentials but receives explicit extras", async () => {
  process.env.FAKE_ACP_SECRET_PROBE = "classified";
  try {
    const { result } = await run({
      env: { FAKE_ACP_ECHO_ENV: "FAKE_ACP_SECRET_PROBE", FAKE_ACP_VISIBLE: "visible-value" },
    });
    assert.match(result.text, /echo:<unset>/);
  } finally {
    delete process.env.FAKE_ACP_SECRET_PROBE;
  }

  const second = await run({ env: { FAKE_ACP_ECHO_ENV: "FAKE_ACP_VISIBLE", FAKE_ACP_VISIBLE: "visible-value" } });
  assert.match(second.result.text, /echo:visible-value/);
});
