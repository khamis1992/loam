import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCraftOfficeTool } from "../craftOffice.js";
import { createFrontierBridgeTools } from "../frontierBridge.js";

describe("craft office hints", () => {
  it("never names office_studio and only points at registered tools", () => {
    const tool = createCraftOfficeTool({ fallback: async () => ({ ok: false, content: "no" }) });
    const names = new Set(createFrontierBridgeTools(undefined, {}, null).map((item) => item.name));
    names.add("loam_studio");
    names.add("office_export");
    names.add("office_import");
    names.add("office_edit");
    const blob = `${tool.description} ${JSON.stringify(tool.parameters)}`;
    assert.equal(blob.includes("office_studio"), false);
    const mentioned = blob.match(/`([a-z_]+)`/g) ?? [];
    for (const raw of mentioned) {
      const name = raw.slice(1, -1);
      if (name === "fallback" || name === "true" || name === "false") continue;
      assert.ok(names.has(name) || ["docs", "sheets", "slides", "photo", "design", "open", "retry"].includes(name), name);
    }
  });
});
