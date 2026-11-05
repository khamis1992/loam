import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { designCraftCardSlide } from "../craftSlideCards.js";
import type { CraftOfficeRelayLike } from "../craftOffice.js";

describe("Craft card layout", () => {
  it("builds four editable RTL editorial panels with a licensed picture", async () => {
    const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
    const texts: string[] = [];
    let nextId = 10;
    const relay: CraftOfficeRelayLike = {
      async enqueue(_taskId, _target, _method, params = {}) {
        const command = String(params.command);
        calls.push({ command, params });
        if (command === "insert.textBox") {
          texts.push(String((params.params as Record<string, unknown>).text));
          return { id: nextId++ };
        }
        if (command === "shape.insert") return { id: nextId++ };
        if (command === "slide.inspect") return { shapes: texts.map((text, index) => ({ id: index, text })) };
        return { ok: true };
      },
    };
    const sections = ["الموقع والعاصمة مدينة الكويت.", "اللغة العربية والعملة الدينار الكويتي.", "أبراج الكويت والديوانية ثقافة أصيلة."];
    await designCraftCardSlide(relay, "task_cards", {
      title: "دولة الكويت",
      sections,
      background: "#F7F3EA",
      arabic: true,
      designSource: "model",
      designSummary: "Editorial Kuwait profile",
      icons: Object.fromEntries(["facts", "landmarks", "language", "location"].map((id) => [id, { data: "aWNvbg==", name: `${id} icon`, attribution: "Loam original", source: "local://presentation-icons" }])),
      image: {
        data: "aW1hZ2U=",
        name: "Kuwait Towers",
        attribution: "Photo: Gladiator2030 / CC BY-SA 4.0",
        source: "https://commons.wikimedia.org/wiki/File:Kuwait_Towers2025.jpg",
      },
    });

    assert.equal(calls[0]?.command, "slide.layout");
    assert.ok(calls.some((call) => call.command === "insert.picture" && (call.params.params as Record<string, unknown>).data === "aW1hZ2U="));
    assert.ok(calls.some((call) => call.command === "format.fontDialog" && (call.params.params as Record<string, unknown>).size === 30));
    assert.ok(calls.some((call) => call.command === "insert.picture" && JSON.stringify((call.params.params as Record<string, unknown>).rect) === JSON.stringify([240, 125, 232, 153])));
    assert.equal(calls.filter((call) => call.command === "insert.picture" && (call.params.params as Record<string, unknown>).data === "aWNvbg==").length, 4);
    assert.ok(calls.some((call) => call.command === "slide.notes" && String((call.params.params as Record<string, unknown>).text).includes("Editorial Kuwait profile")));
    assert.ok(calls.some((call) => call.command === "format.rtl" && (call.params.params as Record<string, unknown>).on === true));
    assert.ok(calls.some((call) => call.command === "slide.notes" && String((call.params.params as Record<string, unknown>).text).includes("CC BY-SA 4.0")));
    assert.ok(texts.includes("دولة الكويت"));
    for (const section of sections) assert.ok(texts.includes(section));
    assert.equal(calls.at(-1)?.command, "slide.inspect");
  });

  it("fails instead of formatting an unknown inserted shape", async () => {
    const relay: CraftOfficeRelayLike = { async enqueue() { return { ok: true }; } };
    await assert.rejects(() => designCraftCardSlide(relay, "task_cards", {
      title: "دولة الكويت",
      sections: ["الموقع", "اللغة", "الثقافة"],
      background: "#F7F3EA",
      arabic: true,
    }), /did not return a shape id/);
  });
});
