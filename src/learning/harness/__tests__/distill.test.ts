/**
 * H4 tests for src/learning/harness/distill.ts (BUILD_SPEC 6.4 + the section 8 mock).
 * node:test; no model API is called — the client is a fake OllamaClient.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { parseDistill, distillCorrection, DISTILL_SYSTEM } from "../distill.js";
import type { OllamaClient, ChatOptions, ChatResult } from "../../../ollama.js";
import type { Config } from "../../../config.js";

/** BUILD_SPEC section 8 mock fixture (Arabic), used verbatim. */
const MOCK_REPLY =
  '{"cue":"عند كتابة محتوى عربي عن التطبيق","lesson":"اكتب الاسم «نتريو» بالعربي وليس Nutrio","evidence":"المستخدم صحّح كتابة الاسم","confidence":"high"}';

describe("parseDistill", () => {
  it("parses a bare JSON object", () => {
    const d = parseDistill(MOCK_REPLY);
    assert.ok(d);
    assert.equal(d.cue, "عند كتابة محتوى عربي عن التطبيق");
    assert.equal(d.lesson, "اكتب الاسم «نتريو» بالعربي وليس Nutrio");
    assert.equal(d.evidence, "المستخدم صحّح كتابة الاسم");
    assert.equal(d.confidence, "high");
  });

  it("handles fenced JSON (```json ... ```)", () => {
    const d = parseDistill("Here is the rule:\n```json\n" + MOCK_REPLY + "\n```\n");
    assert.ok(d);
    assert.equal(d.confidence, "high");
  });

  it("salvages JSON out of surrounding prose", () => {
    const d = parseDistill("Sure! " + MOCK_REPLY + " Hope that helps.");
    assert.ok(d);
    assert.equal(d.cue.length > 0, true);
  });

  it("returns null for an empty object {}", () => {
    assert.equal(parseDistill("{}"), null);
  });

  it("returns null when evidence is missing", () => {
    const d = parseDistill('{"cue":"when x","lesson":"do y","confidence":"high"}');
    assert.equal(d, null);
  });

  it("returns null when evidence is empty", () => {
    const d = parseDistill('{"cue":"when x","lesson":"do y","evidence":"","confidence":"high"}');
    assert.equal(d, null);
  });

  it("returns null when cue is whitespace only", () => {
    const d = parseDistill('{"cue":"   ","lesson":"do y","evidence":"because z"}');
    assert.equal(d, null);
  });

  it("returns null for text with no JSON at all", () => {
    assert.equal(parseDistill("no json here"), null);
    assert.equal(parseDistill(""), null);
  });

  it("returns null for malformed JSON", () => {
    assert.equal(parseDistill("{not json"), null);
  });

  it("returns null for an unclosed brace", () => {
    assert.equal(parseDistill('{"cue":"a","lesson":"b","evidence":"c"'), null);
  });

  it("defaults an unknown confidence to medium", () => {
    const d = parseDistill('{"cue":"a","lesson":"b","evidence":"c","confidence":"certain"}');
    assert.ok(d);
    assert.equal(d.confidence, "medium");
  });

  it("keeps a low confidence and rejects a missing confidence", () => {
    const low = parseDistill('{"cue":"a","lesson":"b","evidence":"c","confidence":"low"}');
    assert.ok(low);
    assert.equal(low.confidence, "low");
    assert.equal(parseDistill('{"cue":"a","lesson":"b","evidence":"c"}')?.confidence, "medium");
  });

  it("stringifies non-string fields (model may emit numbers)", () => {
    const d = parseDistill('{"cue":42,"lesson":"b","evidence":"c"}');
    assert.ok(d);
    assert.equal(d.cue, "42");
    assert.equal(d.lesson, "b");
    assert.equal(d.evidence, "c");
  });

  it("truncates over-long fields to the documented caps", () => {
    const d = parseDistill(
      JSON.stringify({ cue: "c".repeat(500), lesson: "l".repeat(900), evidence: "e".repeat(900), confidence: "low" }),
    );
    assert.ok(d);
    assert.equal(d.cue.length, 300);
    assert.equal(d.lesson.length, 500);
    assert.equal(d.evidence.length, 500);
  });
});

/** Minimal fake OllamaClient: records the options and returns a canned reply. */
function fakeClient(content: string, onChat?: (opts: ChatOptions) => void): OllamaClient {
  const client = {
    async chat(opts: ChatOptions): Promise<ChatResult> {
      onChat?.(opts);
      return {
        content,
        toolCalls: [],
        model: opts.model,
        doneReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return client as unknown as OllamaClient;
}

const cfg = { model: "longcat", selfImprove: { model: "critic-model" } } as unknown as Config;

describe("distillCorrection", () => {
  it("returns a complete DistillResult when the fake client returns the section 8 mock", async () => {
    let seen: ChatOptions | undefined;
    const ollama = fakeClient(MOCK_REPLY, (opts) => {
      seen = opts;
    });
    const d = await distillCorrection({
      cfg,
      ollama,
      taskPrompt: "اكتب منشور عن نتريو",
      priorAssistant: "Nutrio is a healthy meal app...",
      userText: "لا، قلت لك اكتب اسم نتريو بالعربي «نتريو» مو Nutrio",
    });
    assert.ok(d);
    assert.equal(d.cue, "عند كتابة محتوى عربي عن التطبيق");
    assert.equal(d.lesson, "اكتب الاسم «نتريو» بالعربي وليس Nutrio");
    assert.equal(d.evidence, "المستخدم صحّح كتابة الاسم");
    assert.equal(d.confidence, "high");

    // the exact critic.ts call shape: system + user messages, low temperature, long timeout
    assert.ok(seen);
    assert.equal(seen.messages.length, 2);
    assert.equal(seen.messages[0]!.role, "system");
    assert.equal(seen.messages[0]!.content, DISTILL_SYSTEM);
    assert.equal(seen.messages[1]!.role, "user");
    assert.match(seen.messages[1]!.content, /اكتب منشور عن نتريو/);
    assert.match(seen.messages[1]!.content, /لا، قلت لك اكتب اسم نتريو/);
    assert.equal(seen.temperature, 0.1);
    assert.equal(seen.timeoutMs, 180_000);
    assert.equal(seen.model, "critic-model");
  });

  it("falls back to the main model when selfImprove.model is empty", async () => {
    let model = "";
    const ollama = fakeClient(MOCK_REPLY, (opts) => {
      model = opts.model;
    });
    await distillCorrection({
      cfg: { model: "longcat", selfImprove: { model: "" } } as unknown as Config,
      ollama,
      taskPrompt: "t",
      priorAssistant: "a",
      userText: "u",
    });
    assert.equal(model, "longcat");
  });

  it("returns null when the client returns {}", async () => {
    const d = await distillCorrection({
      cfg,
      ollama: fakeClient("{}"),
      taskPrompt: "t",
      priorAssistant: "a",
      userText: "u",
    });
    assert.equal(d, null);
  });

  it("returns null when the client throws", async () => {
    const ollama = {
      async chat(): Promise<ChatResult> {
        throw new Error("no model");
      },
    } as unknown as OllamaClient;
    const d = await distillCorrection({
      cfg,
      ollama,
      taskPrompt: "t",
      priorAssistant: "a",
      userText: "u",
    });
    assert.equal(d, null);
  });
});
