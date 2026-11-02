/**
 * Isolated route check for the museum deck when Loam Slides is not attached.
 * The model is scripted. No network, no installed Loam, no Ollama.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";

process.env.LOAM_RELAY_ATTACH_TIMEOUT_MS = "0";

const OPEN = { app: "slides", action: "open" };
const TITLE = "متحف الفن الإسلامي في قطر";
const BODY = "صمّم آي. إم. باي المتحف وافتُتح عام 2008";

describe("route fallback checklist", () => {
  it("R3b writes one Arabic RTL slide and a pptx when Slides is not attached", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-r3b-"));
    const configFile = path.join(workspace, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({
      model: "test-model",
      ollamaUrl: "http://127.0.0.1:9",
      workspace,
      memory: { enabled: false },
      screen: { enabled: false },
      selfImprove: { enabled: false },
      computerUse: { enabled: false },
      coding: { enabled: false, chain: [] },
      failover: { providers: [] },
      mcpServers: {},
    }));
    process.env.LOAM_CONFIG = configFile;
    try {
      const { loadConfig } = await import("../../config.js");
      const { runAgent } = await import("../../agent/loop.js");
      const { ToolRegistry } = await import("../registry.js");
      const { createCraftOfficeTool } = await import("../craftOffice.js");
      const { runNativeCraftFallback } = await import("../craftFallback.js");
      const { createLoamTools } = await import("../loam.js");
      const { createOfficeTools } = await import("../officeTools.js");
      const { planTool } = await import("../specAliases.js");

      const registry = new ToolRegistry();
      registry.registerAll([
        planTool(),
        createCraftOfficeTool({ fallback: (app, args, ctx) => runNativeCraftFallback(app, args, ctx) }),
        ...createLoamTools(),
        ...createOfficeTools(),
      ]);
      const tools = registry.forAllowlist(["plan", "office_craft", "loam_studio", "office_export"]);
      const cfg = loadConfig();
      cfg.workspace = workspace;
      cfg.model = "test-model";
      cfg.coding = { enabled: false, chain: [], logEdits: false };

      const used: string[] = [];
      let step = 0;
      const ollama = {
        async chat() {
          step += 1;
          const usage = { promptTokens: 1, completionTokens: 1, durationMs: 0 };
          if (step === 1) {
            return {
              content: "",
              model: "test-model",
              usage,
              toolCalls: [{ function: { name: "plan", arguments: { currentStep: 0, steps: [{ title: "Open a new slides file", status: "in_progress" }] } } }],
            };
          }
          if (step === 2 || step === 3) {
            used.push("office_craft");
            return { content: "", model: "test-model", usage, toolCalls: [{ function: { name: "office_craft", arguments: OPEN } }] };
          }
          if (step === 4) {
            used.push("office_craft:fallback");
            return {
              content: "",
              model: "test-model",
              usage,
              toolCalls: [{ function: { name: "office_craft", arguments: { ...OPEN, fallback: true, title: TITLE, instruction: BODY, path: "uploads/museum.pptx" } } }],
            };
          }
          return { content: "تم حفظ العرض.", model: "test-model", usage, toolCalls: [] };
        },
      };

      const planStatuses: string[] = [];
      const result = await runAgent({
        cfg,
        ollama: ollama as never,
        tools,
        emit: (event) => {
          if (event.type === "plan") for (const row of event.steps) if (row.status) planStatuses.push(row.status);
        },
        prompt: "اعمل برزنتيشن من صفحة 1 عن متحف الفن الاسلامي في قطر",
        taskId: "task_r3b",
        suppressFinal: true,
        maxSteps: 6,
        systemOverride: "test",
      });

      assert.deepEqual(planStatuses, ["doing"]);
      const toolText = result.messages.filter((message) => message.role === "tool").map((message) => message.content).join("\n");
      assert.match(toolText, /retry":false|retry": false/);
      assert.match(toolText, /Blocked: office_craft already failed/);
      assert.equal(used.filter((name) => name === "office_craft").length, 2);

      const pptxPath = path.join(workspace, "uploads", "museum.pptx");
      assert.equal(fs.existsSync(pptxPath), true);
      const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
      const slide = await zip.file("ppt/slides/slide1.xml")?.async("string");
      assert.ok(slide);
      assert.match(slide, /rtl="1"/);
      assert.match(slide, /باي/);
      assert.match(slide, /2008/);
      const studio = JSON.parse(fs.readFileSync(path.join(workspace, ".loam", "studio.json"), "utf8")) as { content: { slides: unknown[] } };
      assert.equal(studio.content.slides.length, 1);
      const names = fs.readdirSync(workspace);
      assert.equal(names.some((name) => name.endsWith(".html")), false);
      assert.equal(toolText.includes("web_scaffold"), false);
    } finally {
      delete process.env.LOAM_CONFIG;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
