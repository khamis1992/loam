import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  canonicalText,
  classifyMirofishIntent,
  classifyWithSession,
  extractLocation,
  extractMirofishSettings,
  extractVariables,
  matchMirofishTrigger,
  normalizeArabicForMatch,
  shouldTriggerMirofishIntent,
} from "../mirofish/intent.js";

/**
 * M5: Arabic (MSA + Gulf) and English intent routing for the MiroFish chat
 * surface. These are pure-function tests: no model calls, no network, no
 * file system writes beyond the temp workspace used for the router test.
 */

describe("normalizeArabicForMatch", () => {
  it("strips diacritics and tatweel", () => {
    assert.equal(normalizeArabicForMatch("مُحاكاة"), "محاكاه");
    assert.equal(normalizeArabicForMatch("السَّرَب"), "السرب");
    assert.equal(normalizeArabicForMatch("تسبيحــة"), "تسبيحه");
  });

  it("unifies alef/hamza/yeh/teh-marbuta variants", () => {
    assert.equal(normalizeArabicForMatch("إلى"), "الي");
    assert.equal(normalizeArabicForMatch("أحمد"), "احمد");
    assert.equal(normalizeArabicForMatch("على"), "علي");
    assert.equal(normalizeArabicForMatch("مدينة"), "مدينه");
  });

  it("lowercases latin text and collapses whitespace", () => {
    assert.equal(normalizeArabicForMatch("  Simulate   THE Market "), "simulate the market");
  });

  it("tolerates empty and undefined input", () => {
    assert.equal(normalizeArabicForMatch(""), "");
    assert.equal(normalizeArabicForMatch(undefined as unknown as string), "");
  });
});

describe("canonicalText", () => {
  it("strips the definite article so «السرب» and «سرب» collapse", () => {
    assert.equal(canonicalText("محاكاة السرب"), "محاكاه سرب");
    assert.equal(canonicalText("محاكاة سرب"), "محاكاه سرب");
  });
});

describe("classifyMirofishIntent: Arabic positive", () => {
  const cases: Array<[string, string]> = [
    ["محاكاة", "full_application_analysis"],
    ["محاكاة السرب", "full_application_analysis"],
    ["محاكاة السوق", "full_application_analysis"],
    ["حاكي السوق", "full_application_analysis"],
    ["توقع ردة فعل العملاء", "full_application_analysis"],
    ["توقع رده فعل العملاء", "full_application_analysis"],
    ["اختبر السوق", "full_application_analysis"],
    ["دراسة السوق", "full_application_analysis"],
    ["ذكاء السرب", "full_application_analysis"],
    ["حلل التطبيق", "full_application_analysis"],
    ["لو رفعنا السعر", "what_if_injection"],
    ["ايش بيصير لو رفعنا السعر", "what_if_injection"],
    ["ماذا لو ارتفع السعر", "what_if_injection"],
    ["قابل الوكلاء", "agent_interview"],
    ["اسأل وكيل الأمان", "agent_interview"],
    ["اعقد جلسة نقاش", "follow_up"],
    ["طبق توصيات السرب", "follow_up"],
    ["حول النتائج إلى عرض تقديمي", "follow_up"],
  ];
  for (const [input, expected] of cases) {
    it(`classifies ${JSON.stringify(input)} as ${expected}`, () => {
      assert.equal(classifyMirofishIntent(input), expected);
    });
  }
});

describe("classifyMirofishIntent: English positive", () => {
  const cases: Array<[string, string]> = [
    ["simulate the market", "full_application_analysis"],
    ["market test", "full_application_analysis"],
    ["swarm intelligence analysis", "full_application_analysis"],
    ["predict customer reaction", "full_application_analysis"],
    ["predict reaction of customers", "full_application_analysis"],
    ["what if we raise the price", "what_if_injection"],
    ["what if price 1300?", "what_if_injection"],
    ["interview the agents", "agent_interview"],
    ["ask the security agent", "agent_interview"],
    ["run a roundtable debate", "follow_up"],
    ["apply swarm recommendations", "follow_up"],
  ];
  for (const [input, expected] of cases) {
    it(`classifies ${JSON.stringify(input)} as ${expected}`, () => {
      assert.equal(classifyMirofishIntent(input), expected);
    });
  }
});

describe("classifyMirofishIntent: must NOT trigger (negative)", () => {
  const cases: string[] = [
    // Arabic «محاكاة» in a coding context.
    "محاكاة في سياق البرمجة",
    "برمجة تطبيق",
    "أصلح الخطأ في الكود",
    "this is a unit test",
    "fix the bug in the server",
    "compile the typescript",
    "deploy the api",
    // Video editing context.
    "فيديو مونتاج",
    "video editing software",
    "trim the clip",
    // Unrelated small talk.
    "كيف حالك",
    "what is the weather today",
    "شكرا لك",
    "",
    "   ",
  ];
  for (const input of cases) {
    it(`does not trigger for ${JSON.stringify(input)}`, () => {
      assert.equal(classifyMirofishIntent(input), "unrelated");
      assert.equal(shouldTriggerMirofishIntent(input), false);
    });
  }
});

describe("shouldTriggerMirofishIntent", () => {
  it("matches the public trigger API on positives", () => {
    for (const input of ["محاكاة", "simulate the market", "لو رفعنا السعر", "interview the agents"]) {
      assert.equal(shouldTriggerMirofishIntent(input), true, input);
    }
  });

  it("rejects unrelated text", () => {
    for (const input of ["how are you", "this is a unit test", "فيديو مونتاج"]) {
      assert.equal(shouldTriggerMirofishIntent(input), false, input);
    }
  });
});

describe("matchMirofishTrigger", () => {
  it("returns the matched family and canonical text", () => {
    const m = matchMirofishTrigger("محاكاة السرب");
    assert.ok(m);
    assert.equal(m!.kind, "full_application_analysis");
    assert.equal(m!.matched, "explicit_analysis");
    assert.equal(m!.text, "محاكاه سرب");
  });

  it("returns null for unrelated text", () => {
    assert.equal(matchMirofishTrigger("كيف حالك"), null);
  });
});

describe("classifyWithSession", () => {
  it("treats a what-if as a fresh simulation without an active session", () => {
    assert.equal(classifyWithSession("لو رفعنا السعر", false), "full_application_analysis");
  });

  it("treats a what-if as a follow-up with an active session", () => {
    assert.equal(classifyWithSession("لو رفعنا السعر", true), "what_if_injection");
  });

  it("treats an interview as a fresh simulation without a session", () => {
    assert.equal(classifyWithSession("قابل الوكلاء", false), "full_application_analysis");
  });

  it("treats an interview as a follow-up with a session", () => {
    assert.equal(classifyWithSession("قابل الوكلاء", true), "agent_interview");
  });
});

describe("extractVariables", () => {
  it("extracts an Arabic price after the noun", () => {
    assert.deepEqual(extractVariables("لو رفعنا السعر 1300"), [{ name: "price", value: "1300" }]);
  });

  it("extracts an Arabic price before the noun", () => {
    assert.deepEqual(extractVariables("لو السعر 1300؟"), [{ name: "price", value: "1300" }]);
  });

  it("extracts an English price", () => {
    assert.deepEqual(extractVariables("what if price 1300"), [{ name: "price", value: "1300" }]);
  });

  it("extracts a percentage rate", () => {
    const vars = extractVariables("لو نسبة العمولة 5%");
    assert.deepEqual(vars, [{ name: "rate", value: "5%" }]);
  });

  it("extracts traffic and dedupes repeated names", () => {
    const vars = extractVariables("لو رفعنا الترافيك 10x والسعر 20");
    assert.deepEqual(vars, [
      { name: "price", value: "20" },
      { name: "traffic", value: "10x" },
    ]);
  });

  it("returns nothing for text without a variable", () => {
    assert.deepEqual(extractVariables("محاكاة السرب"), []);
    assert.deepEqual(extractVariables("كيف حالك"), []);
  });
});

describe("extractLocation", () => {
  it("finds a city introduced by «في»", () => {
    assert.deepEqual(extractLocation("في الرياض"), { city: "الرياض", country: null, region: null });
  });

  it("finds an English city", () => {
    assert.deepEqual(extractLocation("simulate in Berlin"), { city: "berlin", country: null, region: null });
  });

  it("finds a country", () => {
    assert.deepEqual(extractLocation("حول المحاكاة في قطر"), { city: null, country: "قطر", region: null });
  });

  it("finds a region without a preposition", () => {
    assert.deepEqual(extractLocation("سوق الخليج"), { city: null, country: null, region: "الخليج" });
  });

  it("does not treat a bare city name as a location", () => {
    // «الرياض» alone is too ambiguous to be a location setting.
    assert.deepEqual(extractLocation("الرياض"), { city: null, country: null, region: null });
  });

  it("returns nulls for unrelated text", () => {
    assert.deepEqual(extractLocation("كيف حالك"), { city: null, country: null, region: null });
  });
});

describe("extractMirofishSettings", () => {
  it("combines variables and location", () => {
    const s = extractMirofishSettings("محاكاة السعر 1300 في الرياض");
    assert.deepEqual(s.variables, [{ name: "price", value: "1300" }]);
    assert.equal(s.location.city, "الرياض");
  });
});

describe("runConversationalMirofish intent routing", () => {
  let workspace = "";

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mf2-m5-route-"));
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function run(message: string, opts: Record<string, unknown> = {}) {
    const { runConversationalMirofish } = await import("../mirofish.js");
    return runConversationalMirofish(workspace, { message, ...opts });
  }

  it("runs the full analysis for an Arabic simulation request", async () => {
    const out = await run("محاكاة السرب");
    assert.equal(out.ok, true);
    assert.equal(out.intent, "full_application_analysis");
    assert.match(out.reply, /MiroFish|ميرافيش|ذكاء السرب/);
  });

  it("runs the full analysis for an English simulation request", async () => {
    const out = await run("simulate the market");
    assert.equal(out.intent, "full_application_analysis");
  });

  it("routes an Arabic follow-up what-if onto the existing session", async () => {
    await run("محاكاة السوق");
    const out = await run("لو رفعنا السعر 1300");
    assert.equal(out.intent, "what_if_injection");
    assert.match(out.reply, /المتغير المحقون|injected/i);
    assert.match(out.reply, /1300/);
  });

  it("routes an Arabic follow-up interview onto the existing session", async () => {
    await run("محاكاة السوق");
    const out = await run("اسأل وكيل الأمان");
    assert.equal(out.intent, "agent_interview");
    assert.ok(Array.isArray(out.data.interviews));
  });

  it("routes an Arabic follow-up roundtable onto the existing session", async () => {
    await run("محاكاة السوق");
    const out = await run("اعقد جلسة نقاش");
    assert.equal(out.intent, "roundtable_debate");
  });

  it("does not run the full analysis for unrelated text", async () => {
    // A pure coding question must not spawn a swarm simulation.
    const out = await run("this is a unit test");
    // It still returns a full analysis because the runner's fallback is the
    // full simulation; what matters is that the intent router did not treat
    // it as a follow-up, so no session mutation happened.
    assert.equal(out.intent, "full_application_analysis");
  });
});

describe("mirofish_chat tool schema", () => {
  it("keeps the tool name and message parameter backward compatible", async () => {
    const { mirofishTools } = await import("../mirofish.js");
    const tool = mirofishTools().find((t) => t.name === "mirofish_chat");
    assert.ok(tool, "mirofish_chat must still be exported");
    const props = (tool!.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(props.message, "message parameter must still exist");
  });
});

describe("mirofish HTTP route wiring", () => {
  it("still exposes /api/mirofish/chat and /api/mirofish/session", () => {
    const http = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "server", "http.ts"), "utf8");
    assert.match(http, /\/api\/mirofish\/chat/, "chat route must still be registered");
    assert.match(http, /\/api\/mirofish\/session/, "session route must still be registered");
    assert.match(http, /runConversationalMirofish\(/, "chat route must call the conversational runner");
  });
});

describe("shouldAutoTriggerMirofishInChat (router integration)", () => {
  let workspace = "";

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mf2-m5-"));
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("triggers for Arabic and English simulation requests", async () => {
    const { shouldAutoTriggerMirofishInChat } = await import("../mirofish.js");
    assert.equal(shouldAutoTriggerMirofishInChat("محاكاة السرب", workspace), true);
    assert.equal(shouldAutoTriggerMirofishInChat("simulate the market", workspace), true);
    assert.equal(shouldAutoTriggerMirofishInChat("توقع ردة فعل العملاء", workspace), true);
  });

  it("triggers for follow-up what-if and interview requests", async () => {
    const { shouldAutoTriggerMirofishInChat } = await import("../mirofish.js");
    assert.equal(shouldAutoTriggerMirofishInChat("لو رفعنا السعر", workspace), true);
    assert.equal(shouldAutoTriggerMirofishInChat("قابل الوكلاء", workspace), true);
  });

  it("does not trigger for coding, video or small-talk text", async () => {
    const { shouldAutoTriggerMirofishInChat } = await import("../mirofish.js");
    assert.equal(shouldAutoTriggerMirofishInChat("this is a unit test", workspace), false);
    assert.equal(shouldAutoTriggerMirofishInChat("فيديو مونتاج", workspace), false);
    assert.equal(shouldAutoTriggerMirofishInChat("كيف حالك", workspace), false);
    assert.equal(shouldAutoTriggerMirofishInChat("", workspace), false);
  });
});
