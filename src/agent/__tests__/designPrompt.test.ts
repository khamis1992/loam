/**
 * V2 unit tests: the design-rules prompt section and its UI-intent gate.
 *
 * The section must exist, be full-length, and be injected only for UI intents:
 * a UI task includes it, a non-UI task does not. This is the G1/G12 acceptance
 * test.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { DESIGN_RULES_PROMPT, isUiIntent } from "../designPrompt.js";
import { buildSystemPrompt } from "../prompt.js";
import type { Config } from "../../config.js";

const cfg = {
  workspace: "C:/tmp/task",
  policy: { networkEnabled: false },
} as unknown as Config;

const UI_PROMPTS = [
  "Build me a responsive landing page for a coffee subscription",
  "Design a dashboard to track team tasks",
  "Create a React component for the pricing table",
  "Make a mobile-first admin panel for the store",
  "Design an Arabic RTL interface for the app",
  "صمّم لي صفحة هبوط متجاوبة لمتجر قهوة",
  "أنشئ لوحة تحكم لمتابعة مبيعات المتجر",
];

const NON_UI_PROMPTS = [
  "Summarize the attached report and list the key findings",
  "Fix the failing unit test in src/math.test.ts",
  "Analyze the CSV and compute the average order value",
  "Write a cover letter for a product manager role",
  "اشرح لي مفهوم قواعد البيانات بلغة بسيطة",
  "راجع الصياغة في مسودة الرسالة المرفقة",
];

describe("design-rules section", () => {
  it("is a full, non-trivial section", () => {
    assert.ok(DESIGN_RULES_PROMPT.length > 2000, "design section must not be shortened");
    assert.match(DESIGN_RULES_PROMPT, /## Design Rules/);
  });

  it("covers every required design discipline", () => {
    for (const marker of [
      /Colour discipline/i,
      /Typography/i,
      /Arabic and RTL/i,
      /logical properties/i,
      /Mobile-first layout/i,
      /Real imagery/i,
      /Icons/i,
      /Accessibility/i,
      /Real copy/i,
      /design brief/i,
    ]) {
      assert.match(DESIGN_RULES_PROMPT, marker, `missing discipline: ${marker}`);
    }
  });
});

describe("isUiIntent", () => {
  it("fires on UI intents in English and Arabic", () => {
    for (const prompt of UI_PROMPTS) {
      assert.equal(isUiIntent(prompt), true, `expected UI intent: ${prompt}`);
    }
  });

  it("stays out of ordinary non-UI requests", () => {
    for (const prompt of NON_UI_PROMPTS) {
      assert.equal(isUiIntent(prompt), false, `expected non-UI intent: ${prompt}`);
    }
  });

  it("handles empty input", () => {
    assert.equal(isUiIntent(""), false);
    assert.equal(isUiIntent(undefined), false);
    assert.equal(isUiIntent("   "), false);
  });
});

describe("design-rules injection", () => {
  it("includes the section for a UI intent", () => {
    const prompt = buildSystemPrompt(cfg, [], ["file_read", "shell_run"], [], undefined, undefined, "Design a landing page for my shop");
    assert.match(prompt, /## Design Rules/);
    assert.match(prompt, /Colour discipline/);
    assert.match(prompt, /Mobile-first layout/);
  });

  it("excludes the section for a non-UI intent", () => {
    const prompt = buildSystemPrompt(cfg, [], ["file_read", "shell_run"], [], undefined, undefined, "Fix the failing unit test");
    assert.ok(!prompt.includes("## Design Rules"));
    assert.ok(!prompt.includes("Colour discipline"));
  });

  it("injects the Arabic UI intent too", () => {
    const prompt = buildSystemPrompt(cfg, [], [], [], undefined, undefined, "صمّم لي صفحة هبوط متجاوبة");
    assert.match(prompt, /## Design Rules/);
    assert.match(prompt, /Arabic and RTL/);
  });
});
