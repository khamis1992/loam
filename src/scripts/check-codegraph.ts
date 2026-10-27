import assert from "node:assert/strict";
import fs from "node:fs";
import { ToolRegistry } from "../tools/registry.js";
import { getLoamMode } from "../modes/catalog.js";
import { classifyToolCall, isUntrustedTool } from "../policy/riskTier.js";
import { SIDE_CHAT_READ_ONLY_TOOLS } from "../agent/sideChat.js";
import { findSubagentProfile } from "../tools/subagents.js";
import { CodeGraphService } from "../codegraph/service.js";
import { CODEGRAPH_TOOL_NAMES, createCodeGraphTools } from "../codegraph/tools.js";
import { GRAPHIFY_PIN } from "../codegraph/config.js";
import { sha256File } from "../codegraph/runtime.js";
import { rootAsset } from "../config.js";

const svc = new CodeGraphService({ enabled: false });
const registry = new ToolRegistry();
registry.registerAll(createCodeGraphTools(svc));
for (const name of CODEGRAPH_TOOL_NAMES) {
  assert.ok(registry.names().includes(name), `registered: ${name}`);
  assert.equal(classifyToolCall(name, {}, process.cwd()), name === "codegraph_index" ? "write-workspace" : "read", `risk tier: ${name}`);
  assert.ok(isUntrustedTool(name), `untrusted: ${name}`);
  for (const mode of ["ask", "build"]) assert.ok(getLoamMode(mode).tools.includes(name), `${mode} mode lists ${name}`);
}
for (const mode of ["research", "write", "data", "media", "security", "automate"]) {
  assert.ok(!getLoamMode(mode).tools.some((t) => t.startsWith("codegraph_")), `${mode} must not list codegraph tools`);
}
const explore = findSubagentProfile(process.cwd(), "explore");
assert.ok(explore?.allowTools?.includes("codegraph_affected") && !explore.allowTools.includes("codegraph_index"));
assert.ok(SIDE_CHAT_READ_ONLY_TOOLS.includes("codegraph_affected") && !SIDE_CHAT_READ_ONLY_TOOLS.includes("codegraph_index"));
const lock = rootAsset("resources", "codegraph", GRAPHIFY_PIN.lockFile);
assert.ok(fs.existsSync(lock), "bundled lock file present");
assert.equal(sha256File(lock), GRAPHIFY_PIN.lockFileSha256, "lock file hash matches the pin");
const uv = JSON.parse(fs.readFileSync(rootAsset("resources", "codegraph", "uv.json"), "utf8")) as { sha256: Record<string, string> };
assert.match(uv.sha256["win32-x64"] ?? "", /^[0-9a-f]{64}$/, "uv.exe hash pinned");
const exe = rootAsset("resources", "codegraph", "uv.exe");
if (fs.existsSync(exe)) assert.equal(sha256File(exe), uv.sha256["win32-x64"], "uv.exe matches uv.json");
await svc.dispose();
console.log("check:codegraph OK");
