import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFixtureCorpus } from "./helpers.js";
import { researchDefense } from "../defense/strategy.js";
import type { CaseTheory } from "../defense/types.js";
import type { LegalModelPort } from "../model/types.js";

const config = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };

test("research is reused only for identical evidence and corpus snapshots with bounded concurrency", async () => {
  const corpus = loadFixtureCorpus();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const port: LegalModelPort = async (req) => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { content: JSON.stringify({ claims: [{ id: "claim-penalty", text: "تخفيض التعويض", support: "supported", authorityAvids: ["QL-3bacb8d64e"], evidenceFactIds: ["fact-1"], exceptions: [], reason: "النص والدليل" }] }), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  };
  const theory: CaseTheory = {
    summary: "اختبار",
    pleas: [
      { id: "penalty", type: "substantive", title: "المبالغة في التعويض", factIds: ["fact-1"], researchQueries: ["المادة 3 من القانون المدني الاختباري"], priority: 1 },
      { id: "notice", type: "procedural", title: "الإعذار", factIds: ["fact-1"], researchQueries: ["المادة 3 مكرراً من القانون المدني الاختباري"], priority: 2 },
    ],
    primaryRequests: [], alternativeRequests: [], weaknesses: [], unresolvedQuestions: [],
  };
  try {
    const facts = [{ id: "fact-1", matterId: "m", text: "الضرر 1000 ريال", kind: "documented" as const, status: "unreviewed" as const, anchors: [], createdAt: "2092-01-01" }];
    const first = await researchDefense(corpus, { port, config }, theory, "2092-01-01", [], facts);
    assert.equal(calls, 2);
    assert.ok(maxActive <= 2);
    const second = await researchDefense(corpus, { port, config }, theory, "2092-01-01", [], facts, first);
    assert.equal(calls, 2);
    assert.deepEqual(second, first);
    await researchDefense(corpus, { port, config }, theory, "2092-01-01", [], [{ ...facts[0]!, text: "الضرر 2000 ريال" }], second);
    assert.equal(calls, 4);
    const version = corpus.db.prepare("SELECT avid, text_sha256 FROM article_versions LIMIT 1").get() as { avid: string; text_sha256: string };
    corpus.db.prepare("UPDATE article_versions SET text_sha256=? WHERE avid=?").run("0".repeat(64), version.avid);
    await researchDefense(corpus, { port, config }, theory, "2092-01-01", [], facts, second);
    assert.equal(calls, 6);
  } finally {
    corpus.close();
  }
});
