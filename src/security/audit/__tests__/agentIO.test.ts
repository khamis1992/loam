import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetMeter, parseStrictJsonObject, runAgentJson } from "../agentIO.js";
import type { AgentDeps, AgentRunFn } from "../agentIO.js";
import { ToolRegistry } from "../../../tools/registry.js";
import type { SchemaObject } from "../schema.js";

const SCHEMA: SchemaObject = { type: "object", required: ["ok"], properties: { ok: { type: "string" } } };

function deps(over: Partial<AgentDeps> & { reply?: string; models?: (string | undefined)[] } = {}): AgentDeps {
  const models = over.models ?? [];
  const run: AgentRunFn = async (o) => {
    models.push((o.cfg as { model?: string }).model);
    return { text: over.reply ?? '{"ok":"yes"}', steps: 2 };
  };
  return {
    cfg: { model: "base" } as never, ollama: {} as never, tools: new ToolRegistry(),
    budget: new BudgetMeter(over.budget ? over.budget.limit : 5), run, acquire: async () => () => undefined,
    ...over,
  };
}

test("parseStrictJsonObject accepts only a bare object", () => {
  assert.equal(parseStrictJsonObject('{"a":1}').ok, true);
  assert.equal(parseStrictJsonObject('```json\n{"a":1}\n```').ok, false);
  assert.equal(parseStrictJsonObject('here: {"a":1}').ok, false);
  assert.equal(parseStrictJsonObject('{"a":1} trailing').ok, false);
  assert.equal(parseStrictJsonObject("[1]").ok, false);
  assert.equal(parseStrictJsonObject("{oops}").ok, false);
});

test("runAgentJson returns the value and charges the budget", async () => {
  const d = deps();
  const r = await runAgentJson<{ ok: string }>(d, { role: "audit-research", prompt: "p", schema: SCHEMA });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.ok, "yes");
  assert.equal(d.budget.spent, 1);
});

test("prose around the JSON and schema misses are rejected, never repaired", async () => {
  const prose = await runAgentJson(deps({ reply: 'Sure! {"ok":"yes"}' }), { role: "audit-hunter", prompt: "p", schema: SCHEMA });
  assert.equal(prose.ok, false);
  const miss = await runAgentJson(deps({ reply: '{"nope":1}' }), { role: "audit-hunter", prompt: "p", schema: SCHEMA });
  assert.equal(miss.ok, false);
});

test("an exhausted budget launches nothing", async () => {
  const d = deps();
  d.budget = new BudgetMeter(1);
  assert.equal((await runAgentJson(d, { role: "audit-research", prompt: "p", schema: SCHEMA })).ok, true);
  const second = await runAgentJson(d, { role: "audit-research", prompt: "p", schema: SCHEMA });
  assert.deepEqual(second, { ok: false, reason: "budget_exhausted" });
  assert.equal(d.budget.spent, 1);
});

test("a failed run is still charged, and the slot is released", async () => {
  let released = 0;
  const d = deps({ acquire: async () => () => { released++; } });
  d.run = async () => { throw new Error("boom"); };
  const r = await runAgentJson(d, { role: "audit-research", prompt: "p", schema: SCHEMA });
  assert.equal(r.ok, false);
  assert.equal(d.budget.spent, 1);
  assert.equal(released, 1);
});

test("an aborted signal cancels before launch", async () => {
  const ac = new AbortController();
  ac.abort();
  const d = deps({ signal: ac.signal });
  const r = await runAgentJson(d, { role: "audit-research", prompt: "p", schema: SCHEMA });
  assert.deepEqual(r, { ok: false, reason: "cancelled" });
  assert.equal(d.budget.spent, 0);
});

test("only verifiers use the verifier model", async () => {
  const models: (string | undefined)[] = [];
  const d = deps({ models, verifierModel: "strong" });
  await runAgentJson(d, { role: "audit-verifier", prompt: "p", schema: SCHEMA });
  await runAgentJson(d, { role: "audit-hunter", prompt: "p", schema: SCHEMA });
  assert.deepEqual(models, ["strong", "base"]);
});

test("BudgetMeter with a null limit is unlimited", () => {
  const b = new BudgetMeter(null);
  for (let i = 0; i < 100; i++) b.charge();
  assert.equal(b.canLaunch(1000), true);
});
