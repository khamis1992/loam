import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createDeckTools } from "../slides/tools.js";
import type { Tool, ToolContext } from "../../tools/registry.js";
import type { AgentEvent } from "../../agent/events.js";

function context(workspace: string, events: AgentEvent[] = []): ToolContext {
  return { cfg: { model: "test" } as never, workspace, taskId: "task_formats", packId: "loam-slides", emit: (event) => events.push(event) };
}

function toolsByName(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

const slides = [
  { id: "slide-1", title: "متحف الفن الإسلامي", body: "معلم ثقافي في الدوحة.", background: "#F7F3EA", accent: "#187665" },
  { id: "slide-2", title: "آي. إم. بي و2008", body: "صمم I. M. Pei المبنى وافتتح عام 2008.", background: "#F7F3EA", accent: "#187665" },
];

describe("HTML and image slide formats", () => {
  it("exports and presents a real RTL HTML deck", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-html-deck-"));
    try {
      const tools = toolsByName(createDeckTools());
      const ctx = context(workspace);
      assert.equal((await tools.get("deck_init")!.run({ title: "متحف الفن الإسلامي في قطر", slides, format: "html" }, ctx)).ok, true);
      for (const slide of slides) {
        assert.equal((await tools.get("deck_author")!.run({ id: slide.id, slide }, ctx)).ok, true);
        assert.equal((await tools.get("deck_review")!.run({ id: slide.id }, ctx)).ok, true);
      }
      const exported = await tools.get("deck_export")!.run({ format: "html" }, ctx);
      assert.equal(exported.ok, true, exported.content);
      const file = JSON.parse(exported.content).path as string;
      const html = fs.readFileSync(path.join(workspace, file), "utf8");
      assert.match(html, /dir="rtl"/);
      assert.match(html, /متحف الفن الإسلامي/);
      assert.match(html, /I\. M\. Pei/);
      const presented = await tools.get("deck_present")!.run({}, ctx);
      assert.equal(presented.ok, true, presented.content);
      assert.match(presented.content, /\.html/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("requires a provider for image slides and generates real PNGs when configured", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-image-deck-"));
    try {
      const withoutProvider = toolsByName(createDeckTools());
      const missing = await withoutProvider.get("deck_init")!.run({ title: "متحف الفن الإسلامي", slides, format: "image" }, context(workspace));
      assert.equal(missing.ok, false);
      assert.match(missing.content, /provider_not_configured/);

      const tools = toolsByName(createDeckTools({
        imageGenerator: async () => ({ bytes: Buffer.alloc(256, 1), format: "png", width: 1024, height: 576 }),
      }));
      const ctx = context(workspace);
      assert.equal((await tools.get("deck_init")!.run({ title: "متحف الفن الإسلامي", slides, format: "image" }, ctx)).ok, true);
      for (const slide of slides) {
        assert.equal((await tools.get("deck_author")!.run({ id: slide.id, slide }, ctx)).ok, true);
        assert.equal((await tools.get("deck_review")!.run({ id: slide.id }, ctx)).ok, true);
      }
      const exported = await tools.get("deck_export")!.run({ format: "image" }, ctx);
      assert.equal(exported.ok, true, exported.content);
      const presented = await tools.get("deck_present")!.run({}, ctx);
      assert.equal(presented.ok, true, presented.content);
      assert.match(presented.content, /\.png/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
