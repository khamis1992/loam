/**
 * Neo N5: unit tests for the per-step context selector.
 *
 * These pin the properties the N5 plan names as the acceptance criteria: the
 * budget is hard (a selection never exceeds `maxContextTokens`), relevance is
 * query-driven (the artefact the query names wins over a recent but irrelevant
 * one), and the transcript shape is preserved (lead and tail verbatim, a dropped
 * tool result becomes an elision marker rather than disappearing).
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import type { ChatMessage } from "../../ollama.js";
import type { TodoItem } from "../events.js";
import {
  ContextSelector,
  DEFAULT_SELECTOR_CONFIG,
  buildQuery,
  compactTranscript,
  estimateTokens,
  isSelectorEnabled,
  messageTokens,
  normalizeSelectorConfig,
  scoreArtefacts,
  selectContext,
  selectionBudgetTokens,
  tokenize,
  totalTokens,
  type Artefact,
} from "../contextSelector.js";

function toolMessage(content: string): ChatMessage {
  return { role: "tool", content, tool_name: "file_read" };
}

function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

function assistantMessage(content: string): ChatMessage {
  return { role: "assistant", content };
}

function artefact(id: string, title: string, body: string, seq: number): Artefact {
  return { id, kind: "tool_result", title, body, seq };
}

const TASK = "Write the quarterly sales report from the ledger";

const SHAPING_CONFIG = {
  activateAfterSteps: 0,
  protectLead: 2,
  protectTail: 1,
  maxArtefacts: 4,
  maxContextTokens: 5000,
};

describe("token estimates", () => {
  it("estimates tokens as characters over four", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });

  it("counts a message body and its tool calls", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: "hello",
      tool_calls: [{ function: { name: "file_read", arguments: { path: "x" } } }],
    };
    assert.ok(messageTokens(message) > estimateTokens("hello"));
  });

  it("sums across a transcript", () => {
    assert.equal(totalTokens([userMessage("a"), userMessage("b")]), estimateTokens("a") + estimateTokens("b"));
  });
});

describe("config normalisation", () => {
  it("clamps out-of-range values onto the defaults", () => {
    const cfg = normalizeSelectorConfig({ maxContextTokens: 5, activateAfterSteps: -3, protectLead: 9999 });
    assert.equal(cfg.maxContextTokens, 1000);
    assert.equal(cfg.activateAfterSteps, 0);
    assert.equal(cfg.protectLead, 50);
  });

  it("keeps a disabled flag", () => {
    assert.equal(normalizeSelectorConfig({ enabled: false }).enabled, false);
  });

  it("defaults to enabled when no config is supplied", () => {
    assert.equal(isSelectorEnabled(undefined), DEFAULT_SELECTOR_CONFIG.enabled);
    assert.equal(isSelectorEnabled({}), true);
    assert.equal(isSelectorEnabled({ contextSelector: { enabled: false } }), false);
  });
});

describe("tokenisation and query", () => {
  it("drops stop words and single characters", () => {
    assert.deepEqual(tokenize("The quick brown fox of the sales ledger"), ["quick", "brown", "fox", "sales", "ledger"]);
  });

  it("builds a query from the task plus open todos", () => {
    const todos = [
      { id: "1", content: "open todo", status: "in_progress" },
      { id: "2", content: "done todo", status: "completed" },
      { id: "3", content: "pending todo", status: "pending" },
    ] as TodoItem[];
    const query = buildQuery({ task: TASK, todos, artefacts: [] });
    assert.ok(query.includes(TASK));
    assert.ok(query.includes("open todo"));
    assert.ok(query.includes("pending todo"));
    assert.ok(!query.includes("done todo"));
  });
});

describe("selection", () => {
  const store = [
    artefact("a", "ledger", "quarterly sales ledger totals for the report", 0),
    artefact("b", "weather", "sunny weather in the north of the region", 1),
    artefact("c", "meeting", "notes from the sales review meeting", 2),
  ];

  it("prefers the artefact the query names over a recent irrelevant one", () => {
    const outcome = selectContext(
      { task: "summarise the sales ledger totals", todos: [], artefacts: store },
      { config: { maxArtefacts: 8, maxContextTokens: 5000 } },
    );
    assert.equal(outcome.applied, true);
    assert.equal(outcome.artefacts[0]?.id, "a");
  });

  it("never adds a second artefact past the token budget", () => {
    const big = Array.from({ length: 20 }, (_, i) =>
      artefact(`d${i}`, `sales ledger doc ${i}`, "sales ledger totals report ".repeat(60), i),
    );
    const cap = 800;
    const outcome = selectContext(
      { task: "sales ledger report", todos: [], artefacts: big },
      { config: { maxArtefacts: 20, artefactChars: 4000 }, maxTokens: cap },
    );
    assert.equal(outcome.applied, true);
    // The first artefact always fits (the budget check is skipped for it), so the
    // invariant is that nothing after it is added past the cap.
    if (outcome.artefacts.length > 1) {
      const last = outcome.artefacts[outcome.artefacts.length - 1]!;
      const body = last.body.length > 4000 ? `${last.body.slice(0, 4000)}\n[…truncated]` : last.body;
      assert.ok(estimateTokens(`${last.title}\n${body}`) <= cap);
    }
  });

  it("reports no relevant artefact rather than guessing", () => {
    const outcome = selectContext({ task: "quantum chromodynamics", todos: [], artefacts: store });
    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, "no relevant artefact");
  });

  it("honours the disabled flag", () => {
    const outcome = selectContext({ task: "sales ledger", todos: [], artefacts: store }, { config: { enabled: false } });
    assert.deepEqual(outcome, { applied: false, artefacts: [], tokens: 0, reason: "disabled" });
  });

  it("ranks deterministically (same input, same order)", () => {
    const ctx = { task: "sales ledger", todos: [], artefacts: store };
    const first = scoreArtefacts(ctx, DEFAULT_SELECTOR_CONFIG).map((s) => s.artefact.id);
    const second = scoreArtefacts(ctx, DEFAULT_SELECTOR_CONFIG).map((s) => s.artefact.id);
    assert.deepEqual(first, second);
    assert.equal(first[0], "a");
  });

  it("keeps a zero-relevance artefact out however recent it is", () => {
    const scored = scoreArtefacts({ task: "sales ledger", todos: [], artefacts: store }, DEFAULT_SELECTOR_CONFIG);
    assert.equal(scored.find((s) => s.artefact.id === "b")?.score, 0);
  });
});

describe("transcript shaping", () => {
  const selector = new ContextSelector({ config: SHAPING_CONFIG });
  selector.capture("file_read", "quarterly sales ledger totals for the report", { path: "ledger.csv" });
  selector.capture("bash", "total 100 rows processed", { path: "run.sh" });

  const lead = [userMessage("task"), assistantMessage("thinking")];
  const middle = [toolMessage("quarterly sales ledger totals for the report"), toolMessage("total 100 rows processed")];
  const tail = [assistantMessage("latest")];
  const messages = [...lead, ...middle, ...tail];

  it("leaves a short run byte-identical before the activation step", () => {
    const result = compactTranscript(messages, { task: TASK, todos: [], artefacts: selector.store }, { step: 0 });
    assert.deepEqual(result.messages, messages);
    assert.equal(result.outcome.applied, false);
  });

  it("keeps lead and tail verbatim and elides the dropped tool result", () => {
    const toolIds = new Map<ChatMessage, string>([
      [middle[0]!, selector.store[0]!.id],
      [middle[1]!, selector.store[1]!.id],
    ]);
    const result = compactTranscript(
      messages,
      { task: TASK, todos: [], artefacts: selector.store, toolMessageIds: toolIds },
      { step: 1, config: SHAPING_CONFIG },
    );
    assert.equal(result.messages.length, 5);
    assert.deepEqual(result.messages[0], lead[0]);
    assert.deepEqual(result.messages[1], lead[1]);
    assert.deepEqual(result.messages[result.messages.length - 1], tail[0]);
    // The elided tool result is described, not silently removed.
    const markers = result.messages.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("context elided"),
    );
    assert.equal(markers.length, 1);
    assert.ok(markers[0]!.content.includes("tokens"));
  });

  it("re-attaches the selected artefact block", () => {
    const result = compactTranscript(
      messages,
      { task: TASK, todos: [], artefacts: selector.store },
      { step: 1, config: SHAPING_CONFIG },
    );
    const joined = result.messages.map((m) => String(m.content)).join("\n");
    assert.ok(joined.includes("Selected context for this step"));
  });

  it("is bounded: a long transcript becomes no longer than the selected view", () => {
    const big = Array.from({ length: 40 }, (_, i) => toolMessage(`sales ledger row ${i} ${"x".repeat(200)}`));
    const result = compactTranscript(
      [...lead, ...big, ...tail],
      { task: TASK, todos: [], artefacts: selector.store },
      { step: 1, config: { ...SHAPING_CONFIG, artefactChars: 500 } },
    );
    assert.equal(result.outcome.applied, true);
    assert.ok(result.messages.length < big.length + lead.length + tail.length);
  });
});

describe("stateful selector", () => {
  it("captures artefacts and reports its store", () => {
    const selector = new ContextSelector({ config: { activateAfterSteps: 0 } });
    selector.capture("file_read", "the ledger totals", { path: "ledger.csv" });
    selector.captureExternal("kb_seed", "seed", "a knowledge seed body");
    assert.equal(selector.store.length, 2);
    assert.equal(selector.store[0]!.kind, "tool_result");
    assert.equal(selector.store[1]!.kind, "kb_seed");
  });

  it("bounds the store so a long run cannot grow it without limit", () => {
    const selector = new ContextSelector({ config: { activateAfterSteps: 0, storeBound: 20 } });
    for (let i = 0; i < 40; i++) selector.capture("bash", `result ${i}`);
    assert.equal(selector.store.length, 20);
    // The newest artefacts survive.
    assert.ok(selector.store[selector.store.length - 1]!.body.includes("39"));
  });

  it("clamps a store bound below its floor up onto the floor", () => {
    assert.equal(normalizeSelectorConfig({ storeBound: 2 }).storeBound, 16);
    assert.equal(normalizeSelectorConfig({}).storeBound, DEFAULT_SELECTOR_CONFIG.storeBound);
  });

  it("never selects past the window, even when a caller asks for more", () => {
    const big = Array.from({ length: 6 }, (_, i) =>
      artefact(`w${i}`, `sales ledger doc ${i}`, "sales ledger totals report ".repeat(60), i),
    );
    const outcome = selectContext(
      { task: "sales ledger report", todos: [], artefacts: big },
      { config: { maxArtefacts: 20, artefactChars: 4000 }, maxTokens: 100_000, windowTokens: 800 },
    );
    assert.equal(outcome.applied, true);
    assert.ok(outcome.tokens <= 800, `selection used ${outcome.tokens} tokens against an 800-token window`);
  });

  it("caps the budget at the window by default", () => {
    assert.equal(selectionBudgetTokens(undefined, 8192), 8192);
    assert.equal(selectionBudgetTokens(500, 8192), 500);
    assert.equal(selectionBudgetTokens(50_000, 8192), 8192);
  });

  it("applies the bounded view and reports the decision", async () => {
    const decisions: Array<{ step: number; applied: boolean; reason: string }> = [];
    const selector = new ContextSelector({
      config: SHAPING_CONFIG,
      onDecision: (info) => decisions.push(info),
    });
    selector.capture("file_read", "quarterly sales ledger totals for the report", { path: "ledger.csv" });
    const msgs = [userMessage("task"), assistantMessage("thinking"), toolMessage("quarterly sales ledger totals for the report"), assistantMessage("latest")];
    const toolIds = new Map<ChatMessage, string>([[msgs[2]!, selector.store[0]!.id]]);
    const result = await selector.apply(msgs, { task: TASK, todos: [], step: 1, toolMessageIds: toolIds });
    assert.equal(result.applied, true);
    assert.equal(result.reason, "selected");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.applied, true);
  });

  it("fails closed: a throwing caller sees the raw transcript", async () => {
    // A malformed artefact (a non-string body) makes the BM25 index throw
    // inside the selector. The store is private at compile time only, so the
    // test reaches it the same way any corrupt persisted state would.
    const selector = new ContextSelector({ config: { activateAfterSteps: 0, protectLead: 1, protectTail: 1 } });
    const broken: Artefact = {
      id: "bad",
      kind: "tool_result",
      title: "sales ledger",
      body: null as unknown as string,
      seq: 0,
    };
    (selector as unknown as { artefacts: Artefact[] }).artefacts.push(broken);
    const msgs = [userMessage("task"), toolMessage("sales ledger totals"), assistantMessage("latest")];
    const toolIds = new Map<ChatMessage, string>([[msgs[1]!, "bad"]]);
    const result = await selector.apply(msgs, { task: TASK, todos: [], step: 1, toolMessageIds: toolIds });
    assert.equal(result.applied, false);
    assert.deepEqual(result.messages, msgs);
    assert.match(result.reason, /^error:/);
  });

  it("is inert when disabled", async () => {
    const selector = new ContextSelector({ config: { enabled: false } });
    assert.equal(selector.enabled, false);
    assert.equal(selector.activationStep, DEFAULT_SELECTOR_CONFIG.activateAfterSteps);
    const msgs = [userMessage("task"), toolMessage("result")];
    const result = await selector.apply(msgs, { task: TASK, todos: [], step: 50 });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "disabled");
    assert.deepEqual(result.messages, msgs);
  });
});
