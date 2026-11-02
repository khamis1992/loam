import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getLoamMode } from "../../modes/catalog.js";
import { outputTypeTools } from "../router.js";
import { createFrontierBridgeTools } from "../../tools/frontierBridge.js";

const local = new Set(createFrontierBridgeTools(undefined, {}, null).map((tool) => tool.name));

const routes: Array<{ id: string; mode: string; tools: string[]; output?: "text" | "slides" | "video" | "website" }> = [
  { id: "R1", mode: "write", tools: ["office_craft"], output: "text" },
  { id: "R2", mode: "data", tools: ["office_craft"], output: "text" },
  { id: "R3", mode: "write", tools: ["office_craft", "loam_studio", "office_export"], output: "slides" },
  { id: "R4", mode: "media", tools: ["office_craft"] },
  { id: "R5", mode: "media", tools: ["office_craft"] },
  { id: "R6", mode: "write", tools: ["loam_document"], output: "text" },
  { id: "R7", mode: "data", tools: ["loam_dataset"] },
  { id: "R8", mode: "write", tools: ["loam_studio", "office_export"], output: "slides" },
  { id: "R9", mode: "build", tools: ["web_scaffold"], output: "website" },
  { id: "R10", mode: "media", tools: ["video_studio"], output: "video" },
  { id: "R11", mode: "media", tools: ["loam_creative"] },
  { id: "R12", mode: "media", tools: ["loam_canvas"] },
  { id: "R13", mode: "media", tools: ["creative_subtitles"] },
  { id: "R14", mode: "build", tools: ["web_scaffold"], output: "website" },
  { id: "R15", mode: "research", tools: ["web_search", "browser_open"] },
  { id: "R16", mode: "security", tools: ["pentest_check", "security_assess"] },
  { id: "R17", mode: "legal", tools: ["legal_search", "legal_article"] },
  { id: "R18", mode: "devflow", tools: ["github_list_issues", "swarm_run"] },
];

describe("service route table", () => {
  it("puts each route's tools on the mode allowlist and the output pipeline", () => {
    assert.equal(routes.length, 18);
    const registered = new Set([...local, "loam_studio", "office_export", "loam_document", "loam_dataset", "web_scaffold", "video_studio", "loam_creative", "loam_canvas", "creative_subtitles", "web_search", "browser_open", "pentest_check", "security_assess", "legal_search", "legal_article", "github_list_issues", "swarm_run"]);
    for (const route of routes) {
      const allow = new Set(getLoamMode(route.mode).tools);
      for (const tool of route.tools) {
        assert.equal(registered.has(tool), true, `${route.id} ${tool} registered`);
        assert.equal(allow.has(tool), true, `${route.id} ${tool} in ${route.mode}`);
      }
      if (route.output) {
        const pipeline = outputTypeTools(route.output, [...registered]);
        assert.equal(pipeline.includes(route.tools[0]!), true, `${route.id} pipeline ${route.tools[0]}`);
      }
    }
    const slides = outputTypeTools("slides", ["office_craft", "loam_studio", "office_export"]);
    assert.deepEqual(slides.slice(0, 3), ["office_craft", "loam_studio", "office_export"]);
    assert.equal(local.has("presentation_build"), false);
  });
});
