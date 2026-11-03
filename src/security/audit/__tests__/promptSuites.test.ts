import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evaluateSuite } from "../../native/lleval/index.js";
import { auditPromptSuites, callFromChat } from "../promptSuites.js";
import type { ChatLike } from "../promptSuites.js";

/** Answer each role prompt with a contract-valid JSON body. */
const answerFor = (prompt: string): string => {
  if (prompt.includes("reconnaissance agent")) return JSON.stringify({ facts: [], summary: "tiny repo" });
  if (prompt.includes("vulnerability hunter")) return JSON.stringify({ candidates: [], coverage: "covered", checks: [], unresolved: [] });
  if (prompt.includes("independent verifier")) return JSON.stringify({ evidence_vector: [], production_viable: true, reason: "checked" });
  if (prompt.includes("same underlying weakness")) return JSON.stringify({ verdicts: [] });
  return JSON.stringify({ gaps: [], merge: [] });
};

test("five role suites run the real prompts and pass on contract-valid answers", async () => {
  const suites = auditPromptSuites();
  assert.deepEqual(suites.map((s) => s.name), ["audit-recon", "audit-hunter", "audit-verifier", "audit-dedupe", "audit-critic"]);
  assert.ok(suites[0]!.prompts[0]!.includes("reconnaissance agent"));
  for (const s of suites) {
    const r = await evaluateSuite(s, async (p) => ({ output: answerFor(p), latencyMs: 5 }));
    assert.deepEqual([r.name, r.passed, r.total], [s.name, 1, 1]);
  }
});

test("a missing role key fails with the key name", async () => {
  const r = await evaluateSuite(auditPromptSuites()[0]!, async () => ({ output: JSON.stringify({ facts: [] }), latencyMs: 1 }));
  assert.equal(r.passed, 0);
  assert.ok(r.cases[0]!.reason.includes("summary"));
});

test("prose around the JSON fails the strict guard", async () => {
  const r = await evaluateSuite(auditPromptSuites()[0]!, async (p) => ({ output: `Sure!\n${answerFor(p)}`, latencyMs: 1 }));
  assert.equal(r.passed, 0);
});

test("rubric option appends a graded assertion", async () => {
  const suites = auditPromptSuites({ rubric: true });
  const withRubric = suites[0]!.tests[0]!.assert.some((a) => a.type === "llm-rubric");
  assert.equal(withRubric, true);
  const r = await evaluateSuite(
    suites[0]!,
    async (p) => ({ output: answerFor(p), latencyMs: 1 }),
    async () => JSON.stringify({ pass: true, score: 9, reason: "ok" }),
  );
  assert.equal(r.passed, 1);
});

test("callFromChat adapts an Ollama-style client", async () => {
  const client: ChatLike = { chat: async (o) => ({ content: `echo:${o.messages[0]!.content.slice(0, 4)}:${o.temperature}` }) };
  const call = callFromChat(client, "test-model", 1_000);
  const r = await call("hello world");
  assert.equal(r.output, "echo:hell:0");
  assert.ok(r.latencyMs >= 0);
});
