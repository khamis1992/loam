/**
 * Integration test for the effective agent-run tool list (MF1 follow-up fix).
 *
 * Mirrors the composition in src/index.ts executeTask exactly:
 *   gateway resolution (mode ∪ work-mode − revokes − denials ∩ registry)
 *   → always-on core-tools merge (src/server/runTools.ts)
 *   → registry.forAllowlist → the tool set the model receives.
 *
 * Root cause this guards against: tools registered in the live registry but
 * absent from the mode catalog AND every companion service group never enter
 * the gateway allowlist, so the model never sees them.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { Tool, ToolRegistry } from "../../tools/registry.js";
import type { CompanionResolution, CompanionResolveInput, WorkModeDef } from "../companionGateway.js";
import type { LoamMode } from "../../modes/catalog.js";

let tmpDir = "";
let closeDb: () => void;
let registry: ToolRegistry;
let resolveCompanionCapabilities: (input: CompanionResolveInput) => CompanionResolution;
let COMPANION_DYNAMIC_TOOL_NAMES: string[];
let WORK_MODES: WorkModeDef[];
let LOAM_MODES: LoamMode[];
let mergeAlwaysOnTools: (input: {
  resolvedAllow: readonly string[];
  registeredTools: readonly string[];
  disabledTools?: string[];
}) => string[];
let ALWAYS_ON_TOOLS: readonly string[];
let createScratchpadTools: () => Tool[];

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

interface RunAgentOverrides {
  allowedServices?: string[];
  disabledTools?: string[];
}

/** Compose the run tool list exactly like index.ts executeTask does. */
function buildRunToolSet(mode = "build", workMode = "loam", agent: RunAgentOverrides = {}): { gatewayAllow: string[]; tools: ToolRegistry } {
  const capabilities = resolveCompanionCapabilities({
    mode,
    workMode,
    allowedServices: agent.allowedServices,
    disabledTools: agent.disabledTools,
    registeredTools: [...registry.names(), ...COMPANION_DYNAMIC_TOOL_NAMES],
  });
  const runAllow = mergeAlwaysOnTools({
    resolvedAllow: capabilities.allow,
    registeredTools: registry.names(),
    disabledTools: agent.disabledTools,
  });
  return { gatewayAllow: capabilities.allow, tools: registry.forAllowlist(runAllow) };
}

describe("agent run tool list (gateway + always-on core tools)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-runtools-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const registryMod = await import("../../tools/registry.js");
    const scratchpadToolsMod = await import("../../tools/scratchpadTools.js");
    const gatewayMod = await import("../companionGateway.js");
    const catalogMod = await import("../../modes/catalog.js");
    const runToolsMod = await import("../runTools.js");
    ({ resolveCompanionCapabilities, COMPANION_DYNAMIC_TOOL_NAMES, WORK_MODES } = gatewayMod);
    ({ LOAM_MODES } = catalogMod);
    ({ mergeAlwaysOnTools, ALWAYS_ON_TOOLS } = runToolsMod);
    createScratchpadTools = scratchpadToolsMod.createScratchpadTools;
    const { ToolRegistry: Registry } = registryMod;
    registry = new Registry();
    // Register a few real build-mode staples plus the real scratchpad tools,
    // like buildRuntime + index.ts do at startup.
    for (const name of ["file_read", "file_write", "shell_run", "web_fetch", "loam_mobile"]) registry.register(dummy(name));
    registry.registerAll(createScratchpadTools());
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("documents the root cause: the gateway allowlist alone drops registered scratchpad tools", () => {
    const { gatewayAllow } = buildRunToolSet();
    for (const name of ALWAYS_ON_TOOLS) {
      assert.ok(registry.names().includes(name), `${name} is registered`);
      assert.ok(!gatewayAllow.includes(name), `${name} must not leak into the raw gateway allowlist; it is not a mode-catalog or service tool`);
    }
  });

  it("a build-mode agent task exposes scratchpad_add to the model", () => {
    const { tools } = buildRunToolSet();
    for (const name of ["scratchpad_add", "scratchpad_list", "scratchpad_complete"]) {
      assert.ok(tools.names().includes(name), `effective tool list must include ${name}`);
    }
    const modelToolNames = tools.toOllama().map((t) => t.function.name);
    assert.ok(modelToolNames.includes("scratchpad_add"), "the model's function list must include scratchpad_add");
    // The merge must not disturb the gateway's vetted build-mode tools.
    for (const name of ["file_read", "file_write", "shell_run"]) {
      assert.ok(tools.names().includes(name), `build-mode tool ${name} must survive the merge`);
    }
  });

  it("scratchpad_add is available in every Loam mode and work mode", () => {
    for (const mode of LOAM_MODES) {
      assert.ok(buildRunToolSet(mode.id).tools.names().includes("scratchpad_add"), `mode ${mode.id} must expose scratchpad_add`);
    }
    for (const workMode of WORK_MODES) {
      assert.ok(buildRunToolSet("build", workMode.id).tools.names().includes("scratchpad_add"), `work mode ${workMode.id} must expose scratchpad_add`);
    }
  });

  it("per-agent disabledTools still removes a scratchpad tool", () => {
    const { tools } = buildRunToolSet("build", "loam", { disabledTools: ["scratchpad_complete"] });
    assert.ok(!tools.names().includes("scratchpad_complete"), "agent tool denial must win over the always-on grant");
    assert.ok(tools.names().includes("scratchpad_add"), "non-denied scratchpad tools must remain");
  });

  it("always-on names missing from the registry are never exposed", () => {
    const runAllow = mergeAlwaysOnTools({
      resolvedAllow: ["file_read"],
      registeredTools: ["file_read"],
      disabledTools: undefined,
    });
    for (const name of ALWAYS_ON_TOOLS) {
      assert.ok(!runAllow.includes(name), `${name} must stay hidden when unregistered`);
    }
    assert.ok(runAllow.includes("file_read"));
  });
});