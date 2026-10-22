/**
 * Gateway allowlist exposure test for web_scaffold (V3).
 *
 * Mirrors the src/index.ts run composition: companion gateway resolution ->
 * always-on merge (src/server/runTools.ts) -> registry.forAllowlist. Guards
 * against the known failure mode where a tool registered at boot but absent
 * from the mode catalog / service groups never reaches the model.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import type { Tool, ToolRegistry } from "../../tools/registry.js";

let tmpDir = "";
let closeDb: () => void;
let registry: ToolRegistry;
let mergeAlwaysOnTools: (input: {
  resolvedAllow: readonly string[];
  registeredTools: readonly string[];
  disabledTools?: string[];
}) => string[];
let ALWAYS_ON_TOOLS: readonly string[];
let capabilitiesAllow: string[];
let createWebScaffoldTools: () => Tool[];

function dummy(name: string): Tool {
  return {
    name,
    description: "test tool",
    parameters: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "" };
    },
  };
}

function buildRunToolSet(mode = "build", disabledTools?: string[]): ToolRegistry {
  const runAllow = mergeAlwaysOnTools({
    resolvedAllow: capabilitiesAllow,
    registeredTools: registry.names(),
    disabledTools,
  });
  return registry.forAllowlist(runAllow);
}

describe("web_scaffold gateway exposure", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-web-scaffold-gw-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const registryMod = await import("../../tools/registry.js");
    const scaffoldToolsMod = await import("../../tools/webScaffold.js");
    const gatewayMod = await import("../companionGateway.js");
    ({ mergeAlwaysOnTools, ALWAYS_ON_TOOLS } = await import("../runTools.js"));
    createWebScaffoldTools = scaffoldToolsMod.createWebScaffoldTools;
    const { ToolRegistry: Registry } = registryMod;
    registry = new Registry();
    for (const name of ["file_read", "file_write", "shell_run"]) registry.register(dummy(name));
    registry.registerAll(createWebScaffoldTools());
    const capabilities = gatewayMod.resolveCompanionCapabilities({
      mode: "build",
      workMode: "loam",
      registeredTools: [...registry.names(), ...gatewayMod.COMPANION_DYNAMIC_TOOL_NAMES],
    });
    capabilitiesAllow = capabilities.allow;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("web_scaffold is registered and wired into ALWAYS_ON_TOOLS", () => {
    assert.ok(registry.names().includes("web_scaffold"));
    assert.ok(ALWAYS_ON_TOOLS.includes("web_scaffold"));
  });

  it("web_scaffold is not a raw gateway tool (it is granted via the always-on merge)", () => {
    assert.ok(!capabilitiesAllow.includes("web_scaffold"));
  });

  it("a build-mode agent run exposes web_scaffold to the model", () => {
    const tools = buildRunToolSet();
    assert.ok(tools.names().includes("web_scaffold"), "effective run tool list must include web_scaffold");
    const modelToolNames = tools.toOllama().map((t) => t.function.name);
    assert.ok(modelToolNames.includes("web_scaffold"), "the model's function list must include web_scaffold");
  });

  it("per-agent disabledTools still removes web_scaffold", () => {
    const tools = buildRunToolSet("build", ["web_scaffold"]);
    assert.ok(!tools.names().includes("web_scaffold"), "agent tool denial must win over the always-on grant");
  });
});
