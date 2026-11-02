import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createFrontierBridgeTools } from "../frontierBridge.js";

const HIDDEN = ["presentation_build", "super_swarm", "lovable_studio", "studio_blender", "legal_compliance_studio"];

describe("frontier tool gate", () => {
  it("hides Frontier tools when the core is absent and keeps the local ones", () => {
    const names = createFrontierBridgeTools(undefined, {}, null).map((tool) => tool.name);
    for (const name of HIDDEN) assert.equal(names.includes(name), false, name);
    assert.ok(names.includes("office_craft"));
    assert.ok(names.includes("rag_query"));
    assert.ok(names.includes("rag_index"));
  });

  it("registers Frontier tools when a core directory is present", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-frontier-core-"));
    fs.writeFileSync(path.join(dir, "modes.mjs"), "export {};\n");
    try {
      const names = createFrontierBridgeTools(undefined, {}, dir).map((tool) => tool.name);
      for (const name of HIDDEN) assert.equal(names.includes(name), true, name);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
