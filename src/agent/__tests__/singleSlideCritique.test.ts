import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import JSZip from "jszip";
import type { Config } from "../../config.js";
import type { AgentEvent } from "../events.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { runSingleSlideFastPath } from "../singleSlide.js";

let dataDir = "";
let close: () => void = () => undefined;
let createTask: (title: string, prompt: string) => { id: string };
const workspaces: string[] = [];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-slide-critique-data-"));
  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  const sqlite = await import("../../server/sqliteStore.js");
  close = sqlite.closeDb;
  createTask = (await import("../../server/db.js")).createTask;
});

after(() => {
  close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  for (const workspace of workspaces) fs.rmSync(workspace, { recursive: true, force: true });
  delete process.env.MANUS_LOCAL_DATA_DIR;
});

async function scenario(kind: "revise" | "unavailable") {
  const task = createTask("Kuwait critique", "Kuwait critique");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-slide-critique-ws-"));
  workspaces.push(workspace);
  const cfg = { model: "test-model", fallbackModel: "", workspace, vision: { model: "vision-test" }, agent: { requestTimeoutMs: 1000, maxSteps: 3, temperature: 0.1 } } as Config;
  const calls: Array<Record<string, unknown>> = [];
  const tools = {
    async exec(name: string, args: Record<string, unknown>) {
      calls.push(args);
      if (name === "design_brief") {
        return { ok: true, content: JSON.stringify({ source: "fallback", model: "design-test", warnings: [], usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 }, brief: { mood: "Calm", summary: "Editorial Kuwait profile", palette: [{ role: "background", hex: "#F7F7F2", usage: "slide" }, { role: "foreground", hex: "#17231C", usage: "text" }, { role: "primary", hex: "#007A33", usage: "accent" }], fonts: [{ role: "sans", family: "Segoe UI", fallback: "sans-serif" }], layout: "Four panels", layoutPrinciples: ["Clear Arabic"], imageNeeds: [], accessibility: ["AA"], rtl: true, tokens: {} } }) };
      }
      if (args.action !== "export") return { ok: true, content: "{}" };
      const zip = new JSZip();
      zip.file("ppt/slides/slide1.xml", "<p:sld><a:t>دولة الكويت</a:t><a:t>العاصمة مدينة الكويت.</a:t><a:t>اللغة العربية والعملة الدينار الكويتي.</a:t><a:t>أبراج الكويت معلم ثقافي بارز.</a:t></p:sld>");
      const relative = "uploads/دولة الكويت.pptx";
      const absolute = path.join(workspace, ".loam-tasks", task.id, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, await zip.generateAsync({ type: "nodebuffer" }));
      return { ok: true, content: JSON.stringify({ path: relative }) };
    },
  } as unknown as ToolRegistry;
  const ollama = {
    async chat() {
      return { model: "test-model", content: JSON.stringify({ title: "دولة الكويت", body: "العاصمة مدينة الكويت. اللغة العربية والعملة الدينار الكويتي. أبراج الكويت معلم ثقافي بارز." }), toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, durationMs: 30 } };
    },
  } as never;
  const events: AgentEvent[] = [];
  let previews = 0;
  let critiques = 0;
  const result = await runSingleSlideFastPath({
    cfg,
    ollama,
    tools,
    emit: (event) => events.push(event),
    prompt: "أنشئ عرضًا من شريحة واحدة عن الكويت بعنوان «دولة الكويت» وبألوان علم الكويت",
    taskId: task.id,
    renderPreview: async () => {
      previews += 1;
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    },
    critique: async (input, options) => {
      critiques += 1;
      assert.equal(options.maxAttempts, 1);
      assert.ok(input.screenshots[0]?.endsWith("slide-1.png"));
      if (kind === "unavailable") throw new Error("vision model unavailable");
      return {
        ok: true,
        verdict: "revise",
        score: 65,
        dimensions: [],
        issues: ["Body text is clipped"],
        fixes: ["Reduce crowding and prevent overflow"],
        notes: ["Body text is clipped"],
        attempts: 1,
        model: "vision-test",
        source: "model",
        usage: { promptTokens: 4, completionTokens: 3, durationMs: 7 },
        response: "{}",
      };
    },
  });
  return { calls, events, previews, critiques, result };
}

describe("single-slide visual critique", () => {
  it("applies exactly one bounded repair and rerenders the final PPTX", async () => {
    const { calls, events, previews, critiques, result } = await scenario("revise");
    assert.equal(critiques, 1);
    assert.equal(previews, 2);
    assert.deepEqual(calls.filter((call) => call.app === "slides").map((call) => call.action), ["open", "edit", "export", "edit", "export"]);
    assert.equal(calls.filter((call) => call.action === "edit").at(-1)?.density, "compact");
    assert.ok(events.some((event) => event.type === "tool_result" && event.name === "design_repair" && event.ok));
    assert.equal(result.usage.promptTokens, 14);
    assert.equal(result.verified, true);
  });

  it("keeps the verified deck when the vision model is unavailable", async () => {
    const { calls, events, previews, critiques, result } = await scenario("unavailable");
    assert.equal(critiques, 1);
    assert.equal(previews, 1);
    assert.deepEqual(calls.filter((call) => call.app === "slides").map((call) => call.action), ["open", "edit", "export"]);
    assert.ok(events.some((event) => event.type === "tool_result" && event.name === "design_critique" && !event.ok && event.summary.includes("vision model unavailable")));
    assert.equal(result.verified, true);
  });
});
