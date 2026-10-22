/**
 * Tests for the `semantic_search` agent tool (D6).
 *
 * Guarantees under test:
 *  - the tool returns `file:line-line` ranges plus a snippet for the top hits
 *  - `k` is clamped to 1..20 and defaults to 5
 *  - a blank query fails loudly instead of returning an empty success
 *  - an index directory outside the workspace is refused
 *  - the tool is wired into the modes that advertise code intelligence, and the
 *    companion gateway service catalog covers it
 *
 * No network: the embedder is a deterministic local bag-of-words hash.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../../config.js";
import { tokenize } from "../../memory/codeIndex.js";
import { LOAM_MODES } from "../../modes/catalog.js";
import { COMPANION_SERVICES, uncoveredModeTools } from "../../server/companionGateway.js";
import { buildRuntime } from "../../setup/runtime.js";
import type { Tool, ToolContext } from "../registry.js";
import { ToolRegistry } from "../registry.js";
import { createSemanticSearchTools, resetSemanticSearchCache, resolveIndexDir } from "../semanticSearch.js";

const PERMISSIONS_FILE = `export function canWrite(role: string): boolean {
  if (role === "viewer") return false;
  return role === "editor" || role === "owner";
}

export function assertPermissions(role: string, action: string): void {
  const allowed = action === "read" ? true : canWrite(role);
  if (!allowed) throw new Error("permission denied");
}
`;

const OTHER_FILES: Record<string, string> = {
  "src/format/dates.ts": "export function toIso(input: Date): string {\n  return input.toISOString();\n}\n",
  "src/math/vector.ts": "export function magnitude(values: number[]): number {\n  return Math.sqrt(values.length);\n}\n",
  "src/text/slug.ts": 'export function slugify(input: string): string {\n  return input.replace(/[^a-z0-9]+/g, "-");\n}\n',
};

/** Deterministic local embedder; never touches the network. */
const embedder = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vec = new Array<number>(256).fill(0);
      for (const token of tokenize(text)) {
        let h = 2166136261;
        for (let i = 0; i < token.length; i++) {
          h ^= token.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        vec[Math.abs(h) % 256] = (vec[Math.abs(h) % 256] ?? 0) + 1;
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  },
};

let root = "";
let tool: Tool;

function ctx(workspace: string): ToolContext {
  return { workspace, emit: () => {}, cfg: {} } as unknown as ToolContext;
}

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-semantic-tool-"));
  write("src/permissions.ts", PERMISSIONS_FILE);
  for (const [rel, content] of Object.entries(OTHER_FILES)) write(rel, content);
  tool = createSemanticSearchTools({ indexDir: path.join(root, ".loam"), embedder, model: "fake-embed" })[0]!;
});

after(() => {
  resetSemanticSearchCache();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows can leave read-only files behind */
  }
});

describe("semantic_search wiring", () => {
  it("exposes one tool with the documented schema", () => {
    const tools = createSemanticSearchTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "semantic_search");
    assert.deepEqual(Object.keys(tools[0]!.parameters.properties as object).sort(), ["k", "query"]);
    assert.deepEqual(tools[0]!.parameters.required, ["query"]);
    assert.ok(tools[0]!.description.length > 40, "the description must explain when to reach for it");
  });

  it("is offered by the code-intelligence modes and covered by the gateway", () => {
    const withTool = LOAM_MODES.filter((m) => m.tools.includes("semantic_search")).map((m) => m.id);
    assert.ok(withTool.includes("ask"), `expected ask to offer semantic_search, got ${withTool.join(", ")}`);
    assert.ok(withTool.includes("build"), `expected build to offer semantic_search, got ${withTool.join(", ")}`);
    assert.ok(
      !uncoveredModeTools().includes("semantic_search"),
      "every mode tool must belong to a companion service",
    );
    const code = COMPANION_SERVICES.find((s) => s.id === "code");
    assert.ok(code?.tools.includes("semantic_search"), "the code service must list semantic_search");
  });

  it("survives the registry's mode filter where it is advertised", () => {
    const registry = new ToolRegistry();
    registry.registerAll(createSemanticSearchTools({ indexDir: path.join(root, ".loam-filter") }));
    assert.ok(registry.get("semantic_search"), "the tool must register");
    assert.ok(registry.forMode("ask").get("semantic_search"), "ask mode must expose it");
    assert.ok(registry.forMode("build").get("semantic_search"), "build mode must expose it");
    assert.ok(!registry.forMode("research").get("semantic_search"), "modes that do not list it must not expose it");
  });

  it("defaults the index directory to <workspace>/.loam", () => {
    assert.equal(resolveIndexDir(root, {}), path.join(path.resolve(root), ".loam"));
    assert.equal(resolveIndexDir(root, { indexDir: path.join(root, "custom") }), path.resolve(root, "custom"));
  });
});

describe("semantic_search boot wiring", () => {
  it("is registered by buildRuntime and answers from the real boot path", async () => {
    const dataDir = path.join(root, "boot-data");
    process.env.MANUS_LOCAL_DATA_DIR = dataDir;
    const cfg = loadConfig();
    cfg.workspace = root;
    cfg.memory.enabled = false; // exercise the BM25 fallback with no backend
    cfg.policy.networkEnabled = false;

    const runtime = await buildRuntime(cfg, { mcp: false });
    try {
      assert.ok(runtime.registry.names().includes("semantic_search"), "buildRuntime must register semantic_search");
      const tool = runtime.registry.forMode("build").get("semantic_search");
      assert.ok(tool, "build mode must expose semantic_search");
      const result = await tool!.run({ query: "where are permissions checked", k: 5 }, ctx(root));
      assert.equal(result.ok, true, result.content);
      assert.match(result.content, /src[\\/]permissions\.ts:\d+-\d+/, `expected the permission file, got:\n${result.content}`);
    } finally {
      await runtime.dispose();
      delete process.env.MANUS_LOCAL_DATA_DIR;
    }
  });
});

describe("semantic_search tool", () => {
  it("returns file:line ranges plus a source snippet for the permission file", async () => {
    const result = await tool.run({ query: "where are permissions checked" }, ctx(root));
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /src\/permissions\.ts:\d+-\d+/, `expected a file:line range, got:\n${result.content}`);
    assert.match(result.content, /export function/, "the snippet must quote the matched source");
    assert.ok(
      result.content.split("\n\n").some((block) => block.startsWith("src/permissions.ts:")),
      "the permission file must be one of the returned blocks",
    );
  });

  it("works with embeddings disabled (BM25 fallback)", async () => {
    const bm25Tool = createSemanticSearchTools({ indexDir: path.join(root, ".loam-bm25") })[0]!;
    const result = await bm25Tool.run({ query: "where are permissions checked" }, ctx(root));
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /src\/permissions\.ts:\d+-\d+/, result.content);
    assert.match(result.content, /bm25/, "the output must state which scorer produced the hits");
  });

  it("honours k and clamps it into 1..20", async () => {
    const one = await tool.run({ query: "permissions", k: 1 }, ctx(root));
    assert.equal(one.ok, true, one.content);
    assert.equal(one.content.split("\n\n").length, 1, "k=1 must return a single block");

    const many = await tool.run({ query: "export function", k: 999 }, ctx(root));
    assert.equal(many.ok, true, many.content);
    assert.ok(many.content.split("\n\n").length <= 20, "k is capped at 20");

    const zero = await tool.run({ query: "permissions", k: 0 }, ctx(root));
    assert.equal(zero.ok, true, zero.content);
    assert.ok(zero.content.split("\n\n").length >= 1, "k below 1 is raised to 1");
  });

  it("reports no matches honestly instead of inventing hits (BM25)", async () => {
    // Only BM25 can prove absence: it scores on shared terms, so a query with no
    // term in common with the corpus returns nothing. Dense retrieval always has
    // a non-zero similarity for every embedded chunk, so it is asserted on
    // ranking instead (see the code-index suite).
    const bm25Tool = createSemanticSearchTools({ indexDir: path.join(root, ".loam-nomatch") })[0]!;
    const result = await bm25Tool.run({ query: "zzzzznotpresentanywhere" }, ctx(root));
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /no matches/);
  });

  it("fails on a blank query", async () => {
    const result = await tool.run({ query: "   " }, ctx(root));
    assert.equal(result.ok, false);
    assert.match(result.content, /requires a query/);
  });

  it("refuses an index directory outside the workspace", async () => {
    const outside = createSemanticSearchTools({ indexDir: path.join(os.tmpdir(), "loam-outside-index") })[0]!;
    const result = await outside.run({ query: "permissions" }, ctx(root));
    assert.equal(result.ok, false);
    assert.match(result.content, /must stay inside the workspace/);
  });

  it("ignores its own index database when indexing the workspace", async () => {
    const result = await tool.run({ query: "permissions" }, ctx(root));
    assert.equal(result.ok, true, result.content);
    assert.ok(!result.content.includes(".loam"), `the index must not index itself:\n${result.content}`);
  });
});
