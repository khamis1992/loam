import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createCreativeTools } from "../creative.js";
import type { ToolContext } from "../registry.js";

describe("metal base scene", () => {
  it("saves a metal cylinder under the product", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scene-"));
    const tool = createCreativeTools()[0]!;
    const res = await tool.run({ action: "replace", preset: "metal-base" }, { workspace, taskId: "task_1", emit() {} } as unknown as ToolContext);
    assert.equal(res.ok, true, res.content);
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, ".loam", "creative.json"), "utf8")) as {
      nodes: Array<{ id: string; type: string; material: { metalness: number } }>;
    };
    const base = saved.nodes.find((node) => node.id === "base");
    assert.equal(base?.type, "cylinder");
    assert.equal(base?.material.metalness, 1);
  });
});
