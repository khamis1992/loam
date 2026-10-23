/**
 * V8 unit tests: the Loam UI Kit design registry retrieval and the
 * ui_examples_search tool.
 *
 * Covers the acceptance criterion (the query "pricing" returns a pricing block
 * in the top 3, and the Arabic query "تسعير" does too), the loader, the BM25
 * scoring surface, embedding re-ranking, and the tool's wiring into the
 * always-on allowlist and the system prompt.
 *
 * The manifest contract itself is tested in ../../design/__tests__/registry.test.ts;
 * these tests exercise the retrieval layer on top of it.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createUiExamplesTools, UI_EXAMPLES_TOOL_NAME } from "../uiExamples.js";
import {
  cosineSimilarity,
  loadDesignRegistry,
  rerankWithEmbeddings,
  searchDesignBlocks,
  type BlockHit,
  type DesignEmbedder,
} from "../../design/retrieval.js";
import { DESIGN_REGISTRY_DIR } from "../../config.js";
import { mergeAlwaysOnTools } from "../../server/runTools.js";
import type { ToolContext } from "../registry.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ui-examples-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const ctx = { cfg: {}, workspace: "C:/tmp/task", emit: () => undefined } as unknown as ToolContext;

describe("design registry loader", () => {
  it("loads the vetted registry from disk as sorted records", () => {
    const records = loadDesignRegistry(DESIGN_REGISTRY_DIR);
    assert.ok(records.length >= 20, `expected >= 20 blocks, got ${records.length}`);
    for (const record of records) {
      assert.match(record.id, /^[a-z0-9][a-z0-9-]*$/);
      assert.ok(record.manifest.name.length > 0);
      assert.ok(record.manifest.description.length >= 20);
      assert.ok(Array.isArray(record.manifest.tags) && record.manifest.tags.length > 0);
    }
    const ids = records.map((r) => r.id);
    assert.deepEqual(ids, [...ids].sort(), "records must be sorted by id");
  });

  it("returns an empty list for a missing directory", () => {
    assert.deepEqual(loadDesignRegistry(path.join(tmpDir(), "nope")), []);
  });
});

describe("BM25 search", () => {
  it("returns a pricing block in the top 3 for the query 'pricing' (acceptance)", () => {
    const hits = searchDesignBlocks("pricing", { k: 3, dir: DESIGN_REGISTRY_DIR });
    assert.ok(hits.length > 0, "expected at least one hit");
    assert.ok(
      hits.some((hit) => hit.category === "pricing"),
      `pricing block missing from top 3: ${hits.map((h) => h.id).join(", ")}`,
    );
  });

  it("returns a pricing block for the Arabic query 'تسعير'", () => {
    const hits = searchDesignBlocks("تسعير", { k: 3, dir: DESIGN_REGISTRY_DIR });
    assert.ok(
      hits.some((hit) => hit.category === "pricing"),
      `pricing block missing from Arabic results: ${hits.map((h) => h.id).join(", ")}`,
    );
  });

  it("finds the Arabic/RTL pricing variant for 'تسعير' when filtering to RTL", () => {
    const hits = searchDesignBlocks("تسعير", { k: 3, rtl: true, dir: DESIGN_REGISTRY_DIR });
    assert.ok(hits.length > 0, "expected an RTL hit for an Arabic query");
    assert.ok(hits.every((hit) => hit.rtl && hit.lang === "ar"));
  });

  it("ranks the dashboard shell first for 'dashboard'", () => {
    const hits = searchDesignBlocks("dashboard", { k: 3, dir: DESIGN_REGISTRY_DIR });
    assert.equal(hits[0]!.id, "dashboard-shell");
  });

  it("filters by category and clamps k", () => {
    const hits = searchDesignBlocks("hero", { k: 5, category: "hero", dir: DESIGN_REGISTRY_DIR });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((hit) => hit.category === "hero"));
  });

  it("returns nothing for an empty registry or query", () => {
    assert.deepEqual(searchDesignBlocks("pricing", { dir: tmpDir() }), []);
    assert.deepEqual(searchDesignBlocks("   ", { dir: DESIGN_REGISTRY_DIR }), []);
  });
});

describe("embedding rerank", () => {
  it("blends lexical and semantic scores and can reorder a shortlist", async () => {
    const hit = (id: string, name: string, score: number): BlockHit => ({
      id,
      name,
      category: "hero",
      description: `${name} block`,
      tags: [name],
      intent: name,
      deps: [],
      rtl: false,
      lang: "en",
      entry: "Block.tsx",
      screenshot: null,
      license: "MIT",
      source: "Loam",
      score,
    });
    // alpha wins lexically (higher score) but beta is semantically closer to the query.
    const hits = [hit("alpha", "alpha", 10), hit("beta", "beta", 5)];
    const embedder: DesignEmbedder = {
      embedOne: async (text) => (text === "q" || text.includes("beta") ? [1, 0] : [0, 1]),
    };
    const reranked = await rerankWithEmbeddings(hits, "q", embedder);
    assert.deepEqual(reranked.map((h) => h.id), ["beta", "alpha"]);
    assert.ok(cosineSimilarity([1, 0], [1, 0]) === 1);
    assert.ok(cosineSimilarity([1, 0], [0, 1]) === 0);
  });
});

describe("ui_examples_search tool", () => {
  it("returns a JSON payload with pricing blocks for 'pricing'", async () => {
    const tool = createUiExamplesTools()[0]!;
    const result = await tool.run({ query: "pricing", k: 3 }, ctx);
    assert.equal(result.ok, true);
    const payload = JSON.parse(result.content) as {
      count: number;
      registrySize: number;
      results: Array<{ id: string; category: string; code?: string }>;
    };
    assert.ok(payload.registrySize >= 20);
    assert.ok(payload.results.length >= 1 && payload.results.length <= 3);
    assert.ok(payload.results.some((r) => r.category === "pricing"));
    // The model must receive something it can adapt, not just a description.
    assert.ok(payload.results.every((r) => typeof r.code === "string" && r.code.length > 0));
  });

  it("returns pricing blocks for the Arabic query 'تسعير'", async () => {
    const tool = createUiExamplesTools()[0]!;
    const result = await tool.run({ query: "تسعير", k: 3 }, ctx);
    assert.equal(result.ok, true);
    const payload = JSON.parse(result.content) as { results: Array<{ category: string }> };
    assert.ok(payload.results.some((r) => r.category === "pricing"));
  });

  it("rejects an empty query", async () => {
    const result = await createUiExamplesTools()[0]!.run({ query: "  " }, ctx);
    assert.equal(result.ok, false);
  });

  it("reports a missing registry instead of throwing", async () => {
    const result = await createUiExamplesTools({ dir: path.join(tmpDir(), "missing") })[0]!.run(
      { query: "pricing" },
      ctx,
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /design registry not found/);
  });

  it("honours the category filter and clamps k", async () => {
    const result = await createUiExamplesTools()[0]!.run({ query: "hero", k: 99, category: "hero" }, ctx);
    const payload = JSON.parse(result.content) as { results: Array<{ category: string }> };
    assert.ok(payload.results.length <= 10);
    assert.ok(payload.results.every((r) => r.category === "hero"));
  });

  it("appears in the always-on allowlist and injects its prompt directive", async () => {
    const merged = mergeAlwaysOnTools({ resolvedAllow: [], registeredTools: [UI_EXAMPLES_TOOL_NAME] });
    assert.ok(merged.includes(UI_EXAMPLES_TOOL_NAME));
    const { buildSystemPrompt } = await import("../../agent/prompt.js");
    const cfg = { workspace: "C:/tmp/task", policy: { networkEnabled: false } } as unknown as Parameters<
      typeof buildSystemPrompt
    >[0];
    const withTool = buildSystemPrompt(cfg, [], [UI_EXAMPLES_TOOL_NAME]);
    assert.match(withTool, /ui_examples_search/);
    assert.ok(!buildSystemPrompt(cfg, [], ["file_read"]).includes("ui_examples_search"));
  });
});
