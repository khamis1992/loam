import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";
import { importMatterDocument } from "../evidence/service.js";
import { analyzeDocuments } from "../analysis/documentAnalysis.js";
import { validateAnchor } from "../evidence/anchors.js";
import { loadFixtureCorpus } from "./helpers.js";
import type { LegalModelPort } from "../model/types.js";
import { chromium } from "playwright";

export async function multiPagePdf(count: number): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const sections = Array.from({ length: count }, (_, index) => `<section style="page-break-after:always"><h2>Page ${index + 1}</h2><p>Contract amount 1000${index + 1 === count ? " date 2091/12/01" : ""}</p></section>`).join("");
    await page.setContent(`<html><body>${sections}</body></html>`);
    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}

test("a real 120-page PDF preserves page anchors and analyzes every source chunk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-120-pages-"));
  const store = new MattersStore(path.join(dir, "matters.db"), new StaticKeyProvider(crypto.randomBytes(32)));
  const corpus = loadFixtureCorpus();
  try {
    const matter = store.createMatter({ title: "ملف 120 صفحة", kind: "research", asOf: "2092-01-01" }, "user");
    const file = path.join(dir, "large.pdf");
    fs.writeFileSync(file, await multiPagePdf(120));
    const analysis = await importMatterDocument(store, matter.id, file);
    assert.equal(analysis.document.pages.length, 120);
    assert.equal(analysis.facts.at(-1)?.anchors[0]?.page, 120, JSON.stringify({ facts: analysis.facts.length, timeline: analysis.timeline.length, lastText: analysis.document.pages.at(-1)?.text }));
    assert.equal(analysis.timeline.at(-1)?.anchors[0]?.page, 120);
    assert.ok(analysis.facts.every((fact) => validateAnchor(fact.anchors[0]!, analysis.document)));
    let sourceChunks = 0;
    const coveredPages = new Set<number>();
    const port: LegalModelPort = async (req) => {
      const input = JSON.parse(req.messages.at(-2)?.content ?? "{}") as { chunk?: { pages: number[] } };
      if (input.chunk) {
        sourceChunks++;
        for (const page of input.chunk.pages) coveredPages.add(page);
      }
      return { content: JSON.stringify({ summary: "ملخص موثق", obligations: [], risks: [], missingInformation: [], questions: [] }), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    };
    const report = await analyzeDocuments(store, corpus, { port, config: { localModel: config.localModel, approvedLocalModels: config.approvedLocalModels, ollamaUrl: config.ollamaUrl } }, matter.id);
    assert.ok(sourceChunks >= 1 && sourceChunks < 120);
    assert.equal(coveredPages.size, 120);
    assert.ok(report.summary.length > 0);
    assert.equal(report.documents[0]?.pages.at(-1)?.page, 120);
  } finally {
    store.close();
    corpus.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const config = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };
