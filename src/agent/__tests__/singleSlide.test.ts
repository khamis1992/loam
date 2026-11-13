import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import JSZip from "jszip";
import type { Config } from "../../config.js";
import type { AgentEvent } from "../events.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { contentOf, runSingleSlideFastPath, shouldUseCraftFallback, singleSlideRequest } from "../singleSlide.js";

let dataDir = "";
let close: () => void = () => undefined;
after(() => {
  close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.MANUS_LOCAL_DATA_DIR;
});

describe("single-slide fast path", () => {
  it("detects only new one-slide presentation requests", () => {
    assert.equal(singleSlideRequest("أنشئ عرضًا تقديميًا من شريحة واحدة وPPTX عن الكويت", "write"), true);
    assert.equal(singleSlideRequest("أنشئ عرضًا تقديميًا من ثلاث شرائح", "write"), false);
    assert.equal(singleSlideRequest("أنشئ عرضًا تقديميًا من شريحة واحدة", "build"), false);
  });

  it("falls back only for bridge failures, not for content or validation failures", () => {
    assert.equal(shouldUseCraftFallback("The Loam Craft editor did not become ready in time"), true);
    assert.equal(shouldUseCraftFallback("PANEL_NOT_OPEN"), true);
    assert.equal(shouldUseCraftFallback("office_craft action \"edit\" needs real slide content"), false);
    assert.equal(shouldUseCraftFallback("cancelled by user"), false);
  });

  it("rejects narration and incomplete Kuwait content instead of exporting an empty-looking deck", () => {
    const prompt = "أنشئ عرضًا من شريحة واحدة عن الكويت وبألوان علم الكويت";
    assert.throws(() => contentOf({ title: "دولة الكويت", body: "طلبك لم يتضمن النص الأصلي المراد ترجمته؛ لذلك تعذّر إنشاء الشريحة بدون محتوى فعلي. أرسل العنوان والمتن." }, prompt), /task narration/);
    assert.throws(() => contentOf({ title: "دولة الكويت", body: "الكويت دولة جميلة." }, prompt), /missing the requested facts/);
    const valid = contentOf({ title: "دولة الكويت", body: "العاصمة مدينة الكويت. اللغة العربية والعملة الدينار الكويتي. أبراج الكويت معلم ثقافي بارز." }, prompt);
    assert.equal(valid.title, "دولة الكويت");
  });

  it("uses one model call and direct open-edit-export tools, then verifies the real pptx", async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-single-slide-data-"));
    process.env.MANUS_LOCAL_DATA_DIR = dataDir;
    const sqlite = await import("../../server/sqliteStore.js");
    close = sqlite.closeDb;
    const { createTask } = await import("../../server/db.js");
    const task = createTask("Kuwait", "Kuwait");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-single-slide-ws-"));
    const cfg = {
      model: "test-model",
      fallbackModel: "",
      workspace,
      agent: { requestTimeoutMs: 1000, maxSteps: 3, temperature: 0.1 },
    } as Config;
    const calls: Array<Record<string, unknown>> = [];
    const tools = {
      async exec(name: string, args: Record<string, unknown>) {
        calls.push({ name, ...args });
        if (name === "design_brief") {
          return { ok: true, content: JSON.stringify({ source: "model", model: "design-test", warnings: [], usage: { promptTokens: 5, completionTokens: 3, durationMs: 7 }, brief: { mood: "Calm", summary: "Editorial Kuwait profile", palette: [{ role: "background", hex: "#F7F7F2", usage: "slide" }, { role: "foreground", hex: "#17231C", usage: "text" }, { role: "primary", hex: "#007A33", usage: "accent" }], fonts: [{ role: "sans", family: "Segoe UI", fallback: "sans-serif" }], layout: "Four panels", layoutPrinciples: ["Clear Arabic"], imageNeeds: [], accessibility: ["AA"], rtl: true, tokens: {} } }) };
        }
        if (args.action === "export") {
          const zip = new JSZip();
          zip.file("ppt/presentation.xml", "<p:presentation/>");
          zip.file("ppt/slides/slide1.xml", "<p:sld><a:t>دولة الكويت</a:t><a:t>الموقع والعاصمة</a:t><a:t>العاصمة مدينة الكويت.</a:t><a:t>اللغة والعملة</a:t><a:t>اللغة العربية والعملة الدينار الكويتي.</a:t><a:t>المعالم والثقافة</a:t><a:t>أبراج الكويت معلم ثقافي بارز.</a:t></p:sld>");
          const relative = "uploads/دولة الكويت.pptx";
          const absolute = path.join(workspace, ".loam-tasks", task.id, relative);
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.writeFileSync(absolute, await zip.generateAsync({ type: "nodebuffer" }));
          return { ok: true, content: JSON.stringify({ path: relative }) };
        }
        return { ok: true, content: "{}" };
      },
    } as unknown as ToolRegistry;
    let modelCalls = 0;
    const ollama = {
      async chat() {
        modelCalls += 1;
        return {
          model: "test-model",
          content: JSON.stringify({ title: "دولة الكويت: قلب الخليج", body: "العاصمة مدينة الكويت. اللغة العربية والعملة الدينار الكويتي. أبراج الكويت معلم ثقافي بارز.", background: "#E8F5E9" }),
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 20, durationMs: 30 },
        };
      },
    } as never;
    const events: AgentEvent[] = [];
    let previewCalls = 0;
    const result = await runSingleSlideFastPath({
      cfg,
      ollama,
      tools,
      emit: (event) => events.push(event),
      prompt: "أنشئ عرضًا تقديميًا من شريحة واحدة عن الكويت بعنوان «دولة الكويت» وبألوان علم الكويت وملف PPTX",
      taskId: task.id,
      renderPreview: async (buffer, slideNumber) => {
        previewCalls += 1;
        assert.ok(buffer.length > 0);
        assert.equal(slideNumber, 1);
        return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      },
    });

    assert.equal(modelCalls, 1);
    assert.equal(previewCalls, 1);
    assert.deepEqual(calls.filter((call) => call.name === "office_craft").map((call) => call.action), ["open", "edit", "export"]);
    assert.ok(calls.some((call) => call.name === "design_brief" && call.maxAttempts === 1 && call.timeoutMs === 20_000 && call.numPredict === 900));
    assert.equal(result.usage.promptTokens, 15);
    assert.equal(result.usage.completionTokens, 23);
    assert.equal(result.usage.durationMs, 37);
    const edit = calls.find((call) => call.action === "edit");
    assert.equal(edit?.title, "دولة الكويت");
    assert.equal(calls.find((call) => call.action === "export")?.file, "دولة الكويت.pptx");
    assert.equal(edit?.layout, "editorial");
    assert.equal((edit?.sections as string[]).length, 3);
    assert.match(String((edit?.image as { path: string }).path), /assets[\\/]presentation-hero\.jpg$/);
    assert.equal(result.verified, true);
    assert.equal(result.steps, 5);
    assert.match(result.text, /دولة الكويت\.pptx/);
    assert.ok(fs.existsSync(path.join(workspace, ".loam-tasks", task.id, "previews/slide-1.png")));
    const plans = events.filter((event) => event.type === "plan");
    assert.equal(plans.length, 6);
    assert.ok(plans.every((plan) => plan.steps.filter((step) => step.status === "done").length <= 5));
    assert.deepEqual(plans.at(-1)?.steps.map((step) => step.status), ["done", "done", "done", "done", "done"]);
    assert.ok(events.some((event) => event.type === "verify" && event.reason.includes("PowerPoint")));
  });
});
