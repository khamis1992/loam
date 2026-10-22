/**
 * V8 unit tests: the Loam UI Kit design registry and ui_examples_search tool.
 *
 * Covers the acceptance criterion (the query "pricing" returns the pricing
 * block in the top 3), Arabic/RTL retrieval, manifest validation, the loader,
 * the tool surface and its wiring into the always-on allowlist and prompt.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createUiExamplesTools,
  UI_EXAMPLES_TOOL_NAME,
} from "../uiExamples.js";
import {
  DESIGN_BLOCK_TYPES,
  cosineSimilarity,
  loadDesignRegistry,
  rerankWithEmbeddings,
  searchDesignBlocks,
  tokenize,
  validateManifest,
  type DesignBlockHit,
  type DesignEmbedder,
} from "../../design/registry.js";
import { DESIGN_REGISTRY_DIR } from "../../config.js";
import { mergeAlwaysOnTools } from "../../server/runTools.js";
import type { ToolContext } from "../registry.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ui-examples-"));
  tmpDirs.push(dir);
  return dir;
}

function writeManifest(dir: string, id: string, raw: unknown): void {
  const blockDir = path.join(dir, "blocks", id);
  fs.mkdirSync(blockDir, { recursive: true });
  fs.writeFileSync(path.join(blockDir, "manifest.json"), JSON.stringify(raw));
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const validManifest = {
  id: "sample-block",
  name: "Sample block",
  description: "A sample block for tests.",
  type: "hero",
  tags: ["sample", "hero"],
  intents: ["sample intent"],
  dependencies: ["button"],
  tokens: ["primary"],
  file: "blocks/sample-block/example.tsx",
};

const ctx = { cfg: {}, workspace: "C:/tmp/task", emit: () => undefined } as unknown as ToolContext;

describe("design registry loader", () => {
  it("loads and sorts the starter registry from disk", () => {
    const blocks = loadDesignRegistry(DESIGN_REGISTRY_DIR);
    assert.ok(blocks.length >= 12, `expected >= 12 blocks, got ${blocks.length}`);
    for (const block of blocks) {
      assert.match(block.id, /^[a-z0-9][a-z0-9-]*$/);
      assert.ok(block.name.length > 0);
      assert.ok(block.description.length > 0);
      assert.ok(DESIGN_BLOCK_TYPES.includes(block.type as (typeof DESIGN_BLOCK_TYPES)[number]));
      assert.ok(Array.isArray(block.tags));
    }
  });

  it("returns an empty list for a missing directory", () => {
    assert.deepEqual(loadDesignRegistry(path.join(tmpDir(), "nope")), []);
  });

  it("skips invalid manifests and duplicate ids", () => {
    const dir = tmpDir();
    writeManifest(dir, "valid", validManifest);
    writeManifest(dir, "bad", { ...validManifest, id: "Bad Id" });
    writeManifest(dir, "dup", validManifest);
    const blocks = loadDesignRegistry(dir);
    assert.deepEqual(blocks.map((b) => b.id), ["sample-block"]);
  });
});

describe("validateManifest", () => {
  it("accepts a complete manifest and normalizes optional fields", () => {
    const manifest = validateManifest(validManifest);
    assert.ok(manifest);
    assert.equal(manifest.id, "sample-block");
    assert.equal(manifest.rtl, false);
    assert.deepEqual(manifest.accessibility, []);
  });

  it("rejects manifests with bad ids, types or array fields", () => {
    assert.equal(validateManifest(null), null);
    assert.equal(validateManifest({ ...validManifest, id: "Bad Id" }), null);
    assert.equal(validateManifest({ ...validManifest, type: "" }), null);
    assert.equal(validateManifest({ ...validManifest, tags: "hero" }), null);
    assert.equal(validateManifest({ ...validManifest, intents: [1] }), null);
  });
});

describe("BM25 search", () => {
  it("returns the pricing block in the top 3 for the query 'pricing' (acceptance)", () => {
    const hits = searchDesignBlocks("pricing", { k: 3, dir: DESIGN_REGISTRY_DIR });
    assert.ok(hits.length > 0, "expected at least one hit");
    const ids = hits.map((hit) => hit.id);
    assert.ok(
      ids.some((id) => id === "pricing-tiered" || id === "pricing-tiered-rtl"),
      `pricing block missing from top 3: ${ids.join(", ")}`,
    );
    assert.ok(hits.every((hit) => hit.type === "pricing"), "top hits should be pricing blocks");
  });

  it("returns the pricing block in the top 3 for the Arabic query 'تسعير'", () => {
    const ids = searchDesignBlocks("تسعير", { k: 3, dir: DESIGN_REGISTRY_DIR }).map((hit) => hit.id);
    assert.ok(ids.some((id) => id.startsWith("pricing")), `pricing block missing from Arabic results: ${ids.join(", ")}`);
  });

  it("ranks the dashboard shell first for 'dashboard'", () => {
    const hits = searchDesignBlocks("dashboard", { k: 3, dir: DESIGN_REGISTRY_DIR });
    assert.equal(hits[0]!.id, "dashboard-shell");
  });

  it("filters by block type", () => {
    const hits = searchDesignBlocks("hero", { k: 5, type: "hero", dir: DESIGN_REGISTRY_DIR });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((hit) => hit.type === "hero"));
  });

  it("returns nothing for an empty registry or query", () => {
    assert.deepEqual(searchDesignBlocks("pricing", { dir: tmpDir() }), []);
    assert.deepEqual(searchDesignBlocks("   ", { dir: DESIGN_REGISTRY_DIR }), []);
  });

  it("tokenizes Latin and Arabic words and drops stopwords", () => {
    assert.deepEqual(tokenize("The Pricing Plans!"), ["pricing", "plans"]);
    assert.deepEqual(tokenize("تسعير الخطط"), ["تسعير", "الخطط"]);
  });
});

describe("embedding rerank", () => {
  it("blends lexical and semantic scores and can reorder a shortlist", async () => {
    const hit = (id: string, name: string, score: number): DesignBlockHit => ({
      id,
      name,
      type: "hero",
      description: `${name} block`,
      tags: [name],
      intents: [name],
      dependencies: [],
      tokens: [],
      file: `blocks/${id}/example.tsx`,
      rtl: false,
      accessibility: [],
      score,
    });
    // alpha wins BM25 (higher score) but beta is semantically closer to the query.
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
  it("returns a JSON payload with the top-k pricing blocks", async () => {
    const tool = createUiExamplesTools()[0]!;
    const result = await tool.run({ query: "pricing", k: 3 }, ctx);
    assert.equal(result.ok, true);
    const payload = JSON.parse(result.content) as { count: number; registrySize: number; results: Array<{ id: string }> };
    assert.ok(payload.registrySize >= 12);
    assert.ok(payload.results.length >= 1 && payload.results.length <= 3);
    assert.ok(payload.results.some((r) => r.id.startsWith("pricing")));
  });

  it("rejects an empty query", async () => {
    const result = await createUiExamplesTools()[0]!.run({ query: "  " }, ctx);
    assert.equal(result.ok, false);
  });

  it("reports a missing registry instead of throwing", async () => {
    const result = await createUiExamplesTools({ dir: path.join(tmpDir(), "missing") })[0]!.run({ query: "pricing" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /design registry not found/);
  });

  it("honours the type filter and clamps k", async () => {
    const result = await createUiExamplesTools()[0]!.run({ query: "hero", k: 99, type: "hero" }, ctx);
    const payload = JSON.parse(result.content) as { results: Array<{ type: string }> };
    assert.ok(payload.results.length <= 10);
    assert.ok(payload.results.every((r) => r.type === "hero"));
  });

  it("appears in the always-on allowlist and injects its prompt directive", async () => {
    const merged = mergeAlwaysOnTools({ resolvedAllow: [], registeredTools: [UI_EXAMPLES_TOOL_NAME] });
    assert.ok(merged.includes(UI_EXAMPLES_TOOL_NAME));
    const { buildSystemPrompt } = await import("../../agent/prompt.js");
    const cfg = { workspace: "C:/tmp/task", policy: { networkEnabled: false } } as unknown as Parameters<typeof buildSystemPrompt>[0];
    const withTool = buildSystemPrompt(cfg, [], [UI_EXAMPLES_TOOL_NAME]);
    assert.match(withTool, /ui_examples_search/);
    assert.ok(!buildSystemPrompt(cfg, [], ["file_read"]).includes("ui_examples_search"));
  });
});
