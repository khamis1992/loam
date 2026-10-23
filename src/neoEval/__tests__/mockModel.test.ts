/**
 * Unit tests for the scripted model, the virtual clock and the knowledge store
 * (N20).
 *
 * The mock model is the seam that keeps the gate deterministic, so its replay
 * rules (turn guards, fault injection, per-round reset, verifier detection) are
 * pinned here. The knowledge store and citation extractor are the retrieval
 * contract the citation dimension measures.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NeoMockModel, estimateTokens } from "../mockModel.js";
import { MockClock, countOccurrences, firstDueAt } from "../mockClock.js";
import { KnowledgeStore, citationsAreKnown, extractCitations, queryTerms } from "../knowledge.js";
import type { ChatMessage } from "../../ollama.js";

const user = (content: string): ChatMessage => ({ role: "user", content });
const tool = (content: string): ChatMessage => ({ role: "tool", content });
const system = (content: string): ChatMessage => ({ role: "system", content });

const EXECUTOR_SYSTEM = "You are Loam, a local coding agent.";
const VERIFIER_SYSTEM = "You judge the COMPLETED task as a whole against the user's original request.";

async function oneTurn(
  model: NeoMockModel,
  messages: ChatMessage[] = [system(EXECUTOR_SYSTEM), user("do it")],
) {
  return model.chat({ model: "neo-mock", messages });
}

describe("NeoMockModel replay", () => {
  it("emits the next scripted turn with its tool calls", async () => {
    const model = new NeoMockModel({
      script: { steps: [{ text: "first", calls: [{ tool: "file_list", args: { path: "." } }] }, { text: "second" }] },
    });
    const first = await oneTurn(model);
    assert.equal(first.content, "first");
    assert.equal(first.toolCalls[0]!.function.name, "file_list");
    const second = await oneTurn(model);
    assert.equal(second.content, "second");
    assert.equal(second.toolCalls.length, 0);
  });

  it("falls back to empty text once the script is exhausted", async () => {
    const model = new NeoMockModel({ script: { steps: [{ text: "only" }] } });
    await oneTurn(model);
    const after = await oneTurn(model);
    assert.equal(after.content, "");
  });

  it("skips a turn whose when.afterCall guard has not fired yet", async () => {
    const model = new NeoMockModel({
      script: {
        steps: [
          { text: "too early", when: { afterCall: "file_read" } },
          { text: "just right" },
        ],
      },
    });
    const result = await oneTurn(model);
    assert.equal(result.content, "just right");
  });

  it("matches a turn once the guarded call has happened", async () => {
    const model = new NeoMockModel({
      script: {
        steps: [
          { text: "reading", calls: [{ tool: "file_read", args: { path: "a.md" } }] },
          { text: "after the read", when: { afterCall: "file_read" } },
        ],
      },
    });
    assert.equal((await oneTurn(model)).content, "reading");
    assert.equal((await oneTurn(model)).content, "after the read");
  });

  it("matches a turn after a call of the named tool has failed", async () => {
    const model = new NeoMockModel({
      script: {
        steps: [
          { text: "attempt", calls: [{ tool: "file_write", args: { path: "a.md" } }] },
          { text: "recovering", when: { afterFail: "file_write" } },
        ],
      },
      onCall: (name) => (name === "file_write" ? "injected failure" : undefined),
    });
    assert.equal((await oneTurn(model)).content, "attempt");
    assert.equal((await oneTurn(model)).content, "recovering");
  });

  it("matches on a minimum number of dispatched calls", async () => {
    const model = new NeoMockModel({
      script: {
        steps: [
          { text: "one", calls: [{ tool: "file_list", args: {} }] },
          { text: "two", calls: [{ tool: "file_list", args: {} }] },
          { text: "third", when: { minCalls: 2 } },
        ],
      },
    });
    await oneTurn(model);
    await oneTurn(model);
    assert.equal((await oneTurn(model)).content, "third");
  });

  it("injects a failure through onCall and records the outcome", async () => {
    const model = new NeoMockModel({
      script: { steps: [{ text: "writing", calls: [{ tool: "file_write", args: { path: "a.md" } }] }] },
      onCall: (name) => (name === "file_write" ? "disk full" : undefined),
    });
    await oneTurn(model);
    assert.deepEqual(
      model.toolCalls.map((c) => ({ name: c.name, ok: c.ok })),
      [{ name: "file_write", ok: false }],
    );
  });

  it("keeps the executor and verifier scripts independent", async () => {
    const model = new NeoMockModel({
      script: { steps: [{ text: "executor turn" }] },
      verifierScript: { steps: [{ text: "verifier verdict" }] },
    });
    assert.equal((await oneTurn(model)).content, "executor turn");
    const verdict = await model.chat({ model: "neo-mock", messages: [system(VERIFIER_SYSTEM), user("judge this")] });
    assert.equal(verdict.content, "verifier verdict");
    assert.equal(verdict.model, "neo-mock");
  });

  it("advances the executor cursor past a verifier turn", async () => {
    const model = new NeoMockModel({
      script: { steps: [{ text: "a" }, { text: "b" }] },
      verifierScript: { steps: [{ text: "v" }] },
    });
    await model.chat({ model: "neo-mock", messages: [system(VERIFIER_SYSTEM)] });
    assert.equal((await oneTurn(model)).content, "a");
    assert.equal((await oneTurn(model)).content, "b");
  });

  it("resets its cursors for a fresh round", async () => {
    const model = new NeoMockModel({
      script: { steps: [{ text: "round turn", calls: [{ tool: "file_list", args: {} }] }] },
    });
    assert.equal((await oneTurn(model)).content, "round turn");
    assert.equal(model.stepCount, 1);
    model.resetForRound();
    assert.equal(model.stepCount, 0);
    assert.equal(model.toolCalls.length, 0);
    assert.equal((await oneTurn(model)).content, "round turn");
  });

  it("grounds a verifier answer in the artifact it inspected", async () => {
    const model = new NeoMockModel({
      script: { steps: [{ text: "executor" }] },
      verifierScript: {
        steps: [
          { calls: [{ tool: "file_read", args: { path: "report.md" } }] },
          { text: '{"verdict":"pass"}', finalAnswerFromToolResult: "Report: {EXCERPT}", when: { afterCall: "file_read" } },
        ],
      },
    });
    await oneTurn(model);
    const read = await model.chat({
      model: "neo-mock",
      messages: [system(VERIFIER_SYSTEM), user("inspect"), tool("report.md (2 lines)\n1: the duty is 7 percent\n2: that is all")],
    });
    assert.equal(read.toolCalls[0]!.function.name, "file_read");
    const verdict = await model.chat({
      model: "neo-mock",
      messages: [
        system(VERIFIER_SYSTEM),
        user("inspect"),
        tool("report.md (2 lines)\n1: the duty is 7 percent\n2: that is all"),
        tool("report.md (2 lines)\n1: the duty is 7 percent\n2: that is all"),
      ],
    });
    const parsed = JSON.parse(verdict.content) as Record<string, unknown>;
    assert.equal(parsed["verdict"], "pass");
    assert.match(String(parsed["finalAnswer"]), /the duty is 7 percent/);
    assert.doesNotMatch(String(parsed["finalAnswer"]), /report\.md \(2 lines\)/);
    assert.doesNotMatch(String(parsed["finalAnswer"]), /^\d+: /);
  });

  it("leaves a non-JSON verdict untouched", async () => {
    const model = new NeoMockModel({
      script: { steps: [{ text: "executor" }] },
      verifierScript: {
        steps: [{ text: "verdict: revise", finalAnswerFromToolResult: "Report: {EXCERPT}" }],
      },
    });
    await oneTurn(model);
    const verdict = await model.chat({
      model: "neo-mock",
      messages: [system(VERIFIER_SYSTEM), tool("report.md (1 lines)\n1: body")],
    });
    assert.equal(verdict.content, "verdict: revise");
  });

  it("estimates tokens from the prompt and records them per executor step", async () => {
    const model = new NeoMockModel({ script: { steps: [{ text: "a" }, { text: "b" }] } });
    await model.chat({ model: "neo-mock", messages: [system(EXECUTOR_SYSTEM), user("hello world")] });
    await model.chat({ model: "neo-mock", messages: [system(EXECUTOR_SYSTEM), user("hello world")] });
    assert.equal(model.promptTokenSamples.length, 2);
    assert.ok(model.promptTokenSamples[0]! > 0);
    assert.equal(estimateTokens("abcd"), 1);
  });

  it("grows the prompt per step when the fixture asks for it", async () => {
    const model = new NeoMockModel({
      script: { steps: [{ text: "a" }, { text: "b" }] },
      growthPerStep: 400,
    });
    await model.chat({ model: "neo-mock", messages: [system(EXECUTOR_SYSTEM), user("x".repeat(400))] });
    await model.chat({ model: "neo-mock", messages: [system(EXECUTOR_SYSTEM), user("x".repeat(400))] });
    assert.ok(model.promptTokenSamples[1]! > model.promptTokenSamples[0]!);
  });
});

describe("MockClock", () => {
  it("starts at the given instant and only moves forward", () => {
    const clock = new MockClock("2026-01-05T09:00:00Z");
    assert.equal(clock.iso(), "2026-01-05T09:00:00.000Z");
    clock.advanceTo("2026-01-01T00:00:00Z");
    assert.equal(clock.iso(), "2026-01-05T09:00:00.000Z");
    clock.advance(60_000);
    assert.equal(clock.iso(), "2026-01-05T09:01:00.000Z");
  });

  it("rejects an invalid instant and a backwards step", () => {
    assert.throws(() => new MockClock("not a date"), /invalid start time/);
    const clock = new MockClock("2026-01-05T09:00:00Z");
    assert.throws(() => clock.advance(-1), /cannot move backwards/);
  });

  it("computes the first due instant for a schedule", () => {
    const timing = { cron: "0 9 * * 1", timezone: "UTC" };
    assert.equal(firstDueAt(timing, new Date("2026-01-05T09:00:00Z")), "2026-01-12T09:00:00.000Z");
  });

  it("counts occurrences up to a deadline", () => {
    const timing = { cron: "0 9 * * 1", timezone: "UTC" };
    assert.equal(countOccurrences(timing, "2026-01-05T09:00:00Z", "2026-02-02T09:00:00Z"), 4);
  });
});

describe("KnowledgeStore", () => {
  const seeds = [
    { id: "kb-1", title: "Tariff schedule", body: "A 7 percent duty on substrates.", tags: ["tariff"] },
    { id: "kb-2", title: "Harbour dues", body: "Dues of 1.8 percent of cargo value.", tags: ["dues"] },
  ];

  it("rejects an empty id and a duplicate id", () => {
    assert.throws(() => new KnowledgeStore([{ id: "  ", title: "t", body: "b" }]), /non-empty/);
    assert.throws(() => new KnowledgeStore([seeds[0]!, seeds[0]!]), /duplicate seed id/);
  });

  it("ranks hits by term overlap with a tag bonus", () => {
    const store = new KnowledgeStore(seeds);
    const result = store.search("tariff duty", 5);
    assert.equal(result.empty, false);
    assert.equal(result.hits[0]!.id, "kb-1");
    assert.ok(result.hits[0]!.matched.includes("tariff"));
  });

  it("returns an empty result for a query with no signal", () => {
    const store = new KnowledgeStore(seeds);
    assert.equal(store.search("the of and", 5).empty, true);
    assert.deepEqual(store.search("", 5).hits, []);
  });

  it("returns the single best hit", () => {
    const store = new KnowledgeStore(seeds);
    assert.equal(store.best("cargo dues")?.id, "kb-2");
  });
});

describe("citations", () => {
  it("extracts marked citations in order, deduplicated", () => {
    assert.deepEqual(extractCitations("see [seed:kb-1] and [seed:kb-2], then [seed:kb-1] again"), ["kb-1", "kb-2"]);
  });

  it("ignores bare ids that are not marked as citations", () => {
    assert.deepEqual(extractCitations("the document kb-1 says so"), []);
  });

  it("checks that every cited id exists in the store", () => {
    const store = new KnowledgeStore([{ id: "kb-1", title: "One", body: "body" }]);
    assert.equal(citationsAreKnown("cited [seed:kb-1]", store), true);
    assert.equal(citationsAreKnown("cited [seed:kb-1] and [seed:kb-9]", store), false);
    assert.equal(citationsAreKnown("no citation", store), false);
  });

  it("strips Arabic stop terms from a query", () => {
    const terms = queryTerms("ما هي الرسوم في الميناء");
    assert.ok(!terms.includes("ما"));
    assert.ok(!terms.includes("في"));
  });
});
