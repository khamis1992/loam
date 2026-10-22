/**
 * Gateway allowlist exposure test for scaffold_backend (W2).
 *
 * Mirrors the src/index.ts run composition: companion gateway resolution ->
 * always-on merge (src/server/runTools.ts) -> registry.forAllowlist.
 * Guards against the known failure mode: a tool registered at boot but
 * absent from the mode catalog / service groups never reaches the model.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
let createBackendScaffoldTools: () => Tool[];

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

describe("scaffold_backend gateway exposure", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scaffold-gw-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const registryMod = await import("../../tools/registry.js");
    const scaffoldToolsMod = await import("../../tools/backendScaffold.js");
    const gatewayMod = await import("../companionGateway.js");
    ({ mergeAlwaysOnTools, ALWAYS_ON_TOOLS } = await import("../runTools.js"));
    createBackendScaffoldTools = scaffoldToolsMod.createBackendScaffoldTools;
    const { ToolRegistry: Registry } = registryMod;
    registry = new Registry();
    for (const name of ["file_read", "file_write", "shell_run"]) registry.register(dummy(name));
    registry.registerAll(createBackendScaffoldTools());
    // Composition identical to index.ts executeTask: mode ∪ work-mode grants.
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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("scaffold_backend is registered and wired into ALWAYS_ON_TOOLS", () => {
    assert.ok(registry.names().includes("scaffold_backend"));
    assert.ok(ALWAYS_ON_TOOLS.includes("scaffold_backend"));
  });

  it("scaffold_backend is not a raw gateway tool (it is granted via the always-on merge)", () => {
    assert.ok(!capabilitiesAllow.includes("scaffold_backend"));
  });

  it("a build-mode agent run exposes scaffold_backend to the model", () => {
    const tools = buildRunToolSet();
    assert.ok(tools.names().includes("scaffold_backend"), "effective run tool list must include scaffold_backend");
    const modelToolNames = tools.toOllama().map((t) => t.function.name);
    assert.ok(modelToolNames.includes("scaffold_backend"), "the model's function list must include scaffold_backend");
  });

  it("per-agent disabledTools still removes scaffold_backend", () => {
    const tools = buildRunToolSet("build", ["scaffold_backend"]);
    assert.ok(!tools.names().includes("scaffold_backend"), "agent tool denial must win over the always-on grant");
  });
});
