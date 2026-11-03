import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  initializeParams,
  sessionNewParams,
  extractModels,
  modelSwitchRequest,
  handleServerRequest,
  pickOption,
  permissionRisk,
  toolCallNode,
  type ServerRequestContext,
} from "../acpClient.js";

const settings = { advertiseFs: true, advertiseTerminal: false, passMcpServers: true, clientVersion: "0.6.0" };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-ws-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "acp-out-"));
fs.writeFileSync(path.join(root, "a.txt"), "l1\nl2\nl3\nl4\n");
fs.writeFileSync(path.join(root, ".env"), "TOKEN=x");
fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
fs.symlinkSync(outside, path.join(root, "escape"));

const ctx = (over: Partial<ServerRequestContext> = {}): ServerRequestContext => ({
  settings,
  fs: { roots: [root], maxReadBytes: 2_000_000, maxWriteBytes: 5_000_000 },
  broker: async () => "cancelled",
  cancelled: () => false,
  ...over,
});

test("initialize and session/new carry real capabilities and granted MCP servers", () => {
  assert.deepEqual(initializeParams(settings).clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: false });
  const mcp = [{ name: "fs", command: "/bin/mcp", args: ["--stdio"], env: [] }];
  assert.deepEqual(sessionNewParams("/w", mcp, settings).mcpServers, mcp);
  assert.deepEqual(sessionNewParams("/w", mcp, { ...settings, passMcpServers: false }).mcpServers, []);
});

test("model discovery reads configOptions (grouped) or the legacy models block", () => {
  const viaCfg = extractModels({
    sessionId: "s1",
    configOptions: [
      { id: "mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }] },
      { id: "model", category: "model", type: "select", currentValue: "m1", options: [{ name: "Recommended", options: [{ value: "m1", name: "M1" }, { value: "m2", name: "M2" }] }] },
    ],
  });
  assert.equal(viaCfg.via, "config_option");
  assert.deepEqual(viaCfg.available.map((m) => m.id), ["m1", "m2"]);
  assert.deepEqual(modelSwitchRequest("s1", viaCfg, "m2"), { method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: "m2" } });
  assert.equal(modelSwitchRequest("s1", viaCfg, "m1"), undefined, "already current");
  assert.equal(modelSwitchRequest("s1", viaCfg, "m9"), undefined, "unknown model");
  const legacy = extractModels({ models: { currentModelId: "a", availableModels: [{ modelId: "a" }, { modelId: "b", name: "B" }] } });
  assert.equal(legacy.via, "legacy_models");
  assert.deepEqual(modelSwitchRequest("s1", legacy, "b"), { method: "session/set_model", params: { sessionId: "s1", modelId: "b" } });
  assert.equal(extractModels({}).via, "none");
});

test("fs/read_text_file is scoped to the workspace, honours line/limit, refuses secrets and symlink escapes", async () => {
  const ok = await handleServerRequest("fs/read_text_file", { sessionId: "s", path: path.join(root, "a.txt"), line: 2, limit: 2 }, ctx());
  assert.deepEqual(ok, { result: { content: "l2\nl3" } });
  const rel = await handleServerRequest("fs/read_text_file", { sessionId: "s", path: "a.txt" }, ctx());
  assert.equal("error" in rel && rel.error.code, -32602);
  const out = await handleServerRequest("fs/read_text_file", { sessionId: "s", path: path.join(outside, "secret.txt") }, ctx());
  assert.equal("error" in out && out.error.code, -32001);
  const esc = await handleServerRequest("fs/read_text_file", { sessionId: "s", path: path.join(root, "escape", "secret.txt") }, ctx());
  assert.equal("error" in esc && esc.error.code, -32001);
  const env = await handleServerRequest("fs/read_text_file", { sessionId: "s", path: path.join(root, ".env") }, ctx());
  assert.equal("error" in env && env.error.code, -32001);
});

test("fs/write_text_file creates files inside the workspace and reports them", async () => {
  const written: string[] = [];
  const target = path.join(root, "new", "b.txt");
  const r = await handleServerRequest("fs/write_text_file", { sessionId: "s", path: target, content: "hi" }, ctx({ onWrite: (p) => written.push(p) }));
  assert.deepEqual(r, { result: {} });
  assert.equal(fs.readFileSync(target, "utf8"), "hi");
  assert.equal(written.length, 1);
  const off = await handleServerRequest("fs/write_text_file", { sessionId: "s", path: target, content: "x" }, ctx({ settings: { ...settings, advertiseFs: false } }));
  assert.equal("error" in off && off.error.code, -32601);
});

test("permissions: fixed policy never picks *_always; broker decides otherwise; cancel wins", async () => {
  const options = [
    { optionId: "aa", name: "Always", kind: "allow_always" },
    { optionId: "ao", name: "Once", kind: "allow_once" },
    { optionId: "ro", name: "Reject", kind: "reject_once" },
  ];
  assert.equal(pickOption(options, "allow"), "ao");
  assert.equal(pickOption([{ optionId: "aa", name: "A", kind: "allow_always" }], "allow"), undefined);
  const req = { sessionId: "s", toolCall: { toolCallId: "t1", kind: "execute" }, options };
  assert.deepEqual(await handleServerRequest("session/request_permission", req, ctx({ fixedPolicy: "allow" })), { result: { outcome: { outcome: "selected", optionId: "ao" } } });
  let risk = "";
  const viaBroker = await handleServerRequest("session/request_permission", req, ctx({ broker: async (_r, k) => ((risk = k), { optionId: "ro" }) }));
  assert.equal(risk, "high");
  assert.deepEqual(viaBroker, { result: { outcome: { outcome: "selected", optionId: "ro" } } });
  const forged = await handleServerRequest("session/request_permission", req, ctx({ broker: async () => ({ optionId: "not-offered" }) }));
  assert.deepEqual(forged, { result: { outcome: { outcome: "cancelled" } } });
  const cancelled = await handleServerRequest("session/request_permission", req, ctx({ cancelled: () => true, fixedPolicy: "allow" }));
  assert.deepEqual(cancelled, { result: { outcome: { outcome: "cancelled" } } });
  assert.equal(permissionRisk(undefined), "unknown");
  assert.equal(permissionRisk("read"), "low");
});

test("terminal methods stay unsupported when not advertised; tool updates map to graph nodes", async () => {
  const r = await handleServerRequest("terminal/create", { sessionId: "s", command: "rm" }, ctx());
  assert.equal("error" in r && r.error.code, -32601);
  assert.deepEqual(toolCallNode({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Edit", kind: "edit", status: "pending", locations: [{ path: "/w/a.ts" }] }), {
    id: "c1",
    title: "Edit",
    kind: "edit",
    status: "pending",
    paths: ["/w/a.ts"],
  });
});

test("end to end over stdio with a fake ACP agent", async () => {
  const agent = `
    const rl = require("node:readline").createInterface({ input: process.stdin });
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
    let caps;
    rl.on("line", (l) => {
      const m = JSON.parse(l);
      if (m.method === "initialize") { caps = m.params.clientCapabilities; send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } }); }
      else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s1", models: { currentModelId: "a", availableModels: [{ modelId: "a" }, { modelId: "b" }] } } });
      else if (m.method === "session/set_model") send({ id: m.id, result: {} });
      else if (m.method === "session/prompt") {
        if (caps.fs.readTextFile) send({ id: 900, method: "fs/read_text_file", params: { sessionId: "s1", path: ${JSON.stringify(path.join(root, "a.txt"))}, limit: 1 } });
        globalThis.promptId = m.id;
      } else if (m.id === 900) { globalThis.read = m.result.content; send({ id: 901, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "t", kind: "edit" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] } }); }
      else if (m.id === 901) { send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "read=" + globalThis.read + " perm=" + m.result.outcome.optionId } } } }); send({ id: globalThis.promptId, result: { stopReason: "end_turn" } }); }
    });`;
  const child = spawn(process.execPath, ["-e", agent], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map<number, (v: unknown) => void>();
  let text = "";
  const write = (m: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(m as object) })}\n`);
  const request = (method: string, params: unknown) => new Promise<unknown>((res) => { const id = nextId++; pending.set(id, res); write({ id, method, params }); });
  rl.on("line", async (line) => {
    const m = JSON.parse(line) as { id?: number; method?: string; params?: { update?: { content?: { text?: string } } }; result?: unknown };
    if (m.method && m.id !== undefined) {
      const reply = await handleServerRequest(m.method, m.params, ctx({ broker: async () => ({ optionId: "ok" }) }));
      write({ id: m.id, ...reply });
    } else if (m.method === "session/update") text += m.params?.update?.content?.text ?? "";
    else if (m.id !== undefined) pending.get(m.id)?.(m.result);
  });
  await request("initialize", initializeParams(settings));
  const sess = await request("session/new", sessionNewParams(root, [], settings));
  const models = extractModels(sess);
  const sw = modelSwitchRequest("s1", models, "b");
  assert.ok(sw);
  await request(sw.method, sw.params);
  const done = (await request("session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "go" }] })) as { stopReason: string };
  child.kill();
  assert.equal(done.stopReason, "end_turn");
  assert.equal(text, "read=l1 perm=ok");
});
