import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Loam's data dir env is MANUS_LOCAL_DATA_DIR (config.ts dataDir()); the api-anything
// HOME_DIR derives from it at import time, so the fixture sites land in a tmp tree.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-aa-tier-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, "api-anything", "sites"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "api-anything", "sites", "fixture.json"),
  JSON.stringify({ name: "fixture", baseUrl: "https://fixture.example", operations: [{ name: "search", readOnly: true, params: [{ name: "q" }] }, { name: "post", readOnly: false }] }),
);

const { classifyToolCall, isUntrustedTool, registerProtectedPath } = await import("../riskTier.js");
const { installTierResolver } = await import("../../tools/apiAnything/policy.js");
const { opIndex } = await import("../../tools/apiAnything/opIndex.js");
const { HOME_DIR } = await import("../../tools/apiAnything/constants.js");
installTierResolver();
opIndex.refresh();
registerProtectedPath(HOME_DIR);
const P = "mcp__api-anything__";
const call = (op: string) => ({ site: "fixture", op, args: {} });

test("direct names", () => {
  assert.equal(classifyToolCall(`${P}list_sites`, {}), "read");
  assert.equal(classifyToolCall(`${P}list_operations`, { site: "fixture" }), "read");
  assert.equal(classifyToolCall(`${P}call_operation`, call("search")), "network-external");
  assert.equal(classifyToolCall(`${P}call_operation`, call("post")), "destructive");
  assert.equal(classifyToolCall(`${P}call_operation`, call("missing")), "destructive");
  assert.equal(classifyToolCall(`${P}login`, { site: "fixture" }), "secret");
  assert.equal(classifyToolCall("api_capture", { url: "https://fixture.example/" }), "network-external");
  assert.equal(classifyToolCall("api_capture", { url: "https://fixture.example/", write: true }), "destructive");
  assert.equal(classifyToolCall("api_inspect", { capture: "c1" }), "read");
  assert.equal(classifyToolCall("api_export", { site: "fixture", out: "x.json" }), "write-workspace");
  assert.equal(classifyToolCall("api_logout", { site: "fixture" }), "destructive");
});

test("inner tool of integration_call decides the tier", () => {
  const via = (name: string, args: Record<string, unknown>) => classifyToolCall("integration_call", { name, arguments: args });
  assert.equal(via(`${P}call_operation`, call("post")), "destructive");
  assert.equal(via(`${P}call_operation`, call("search")), "network-external");
  assert.equal(via(`${P}list_sites`, {}), "read");
  assert.equal(via(`${P}login`, { site: "fixture" }), "secret");
  assert.equal(via("mcp__memory-skills__search", {}), "network-external");
});

test("untrusted labelling", () => {
  assert.equal(isUntrustedTool(`${P}list_sites`), true);
  assert.equal(isUntrustedTool("api_ops"), true);
  assert.equal(isUntrustedTool("file_read"), false);
});

test("protected paths", () => {
  assert.equal(classifyToolCall("file_write", { path: path.join(HOME_DIR, "sessions", "x.json") }, tmp), "destructive");
  assert.equal(classifyToolCall("shell_run", { command: `type "${path.join(HOME_DIR, "sessions", "x.json")}"` }, tmp), "destructive");
  assert.equal(classifyToolCall("file_write", { path: "notes.md" }, tmp), "write-workspace");
});
