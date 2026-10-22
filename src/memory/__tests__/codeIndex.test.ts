/**
 * Tests for the incremental code index (D6).
 *
 * Guarantees under test, on a fixture repo written to a temp dir:
 *  - `chunkSource` splits a file into line-aligned, overlapping chunks
 *  - `.gitignore` rules and `node_modules`/`dist` are honoured
 *  - "where are permissions checked" returns the permission file in the top 5
 *  - a second `index()` re-embeds nothing; only the changed file is re-indexed
 *  - a deleted file is pruned from the index
 *  - with embeddings disabled the index scores with BM25 and still answers
 *
 * The fixture holds more than five files on purpose: "in the top 5" is only a
 * real assertion when the index contains more candidates than the result cap.
 *
 * No network: the embedder is a deterministic local bag-of-words hash, so the
 * vector path is exercised without calling a real embedding backend.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { CodeIndex, IgnoreMatcher, chunkSource, hashContent, tokenize } from "../codeIndex.js";

/** Deterministic local embedder: cosine similarity approximates token overlap. */
function hashingEmbedder(dim = 256) {
  const calls: string[][] = [];
  return {
    embeddedTexts(): string[] {
      return calls.flat();
    },
    async embed(texts: string[]): Promise<number[][]> {
      calls.push([...texts]);
      return texts.map((text) => {
        const vec = new Array<number>(dim).fill(0);
        for (const token of tokenize(text)) {
          let h = 2166136261;
          for (let i = 0; i < token.length; i++) {
            h ^= token.charCodeAt(i);
            h = Math.imul(h, 16777619);
          }
          vec[Math.abs(h) % dim] = (vec[Math.abs(h) % dim] ?? 0) + 1;
        }
        let sum = 0;
        for (const v of vec) sum += v * v;
        const norm = Math.sqrt(sum) || 1;
        return vec.map((v) => v / norm);
      });
    },
  };
}

/** An embedder that always fails, to prove the BM25 fallback is automatic. */
const brokenEmbedder = {
  async embed(): Promise<number[][]> {
    throw new Error("no embedding backend");
  },
};

const PERMISSIONS_FILE = `import { type Role } from "./roles.js";

/** Every mutating request is checked here before it reaches a handler. */
export function canWrite(role: Role): boolean {
  if (role === "viewer") return false;
  return role === "editor" || role === "owner";
}

/** Read access is granted to everyone with a seat. */
export function canRead(role: Role): boolean {
  return role !== "none";
}

export function assertPermissions(role: Role, action: "read" | "write"): void {
  const allowed = action === "read" ? canRead(role) : canWrite(role);
  if (!allowed) throw new Error(\`permission denied for \${action}\`);
}
`;

const ROUTER_FILE = `import { assertPermissions } from "./permissions.js";

export function route(pathname: string, role: Role): string {
  if (pathname.startsWith("/api")) {
    assertPermissions(role, "read");
    return "api-handler";
  }
  return "static";
}
`;

const README_FILE = `# Fixture project

A tiny project used to exercise the incremental code index.
`;

const GENERATED_FILE = `// generated - do not edit
export const VERSION = "1.0.0";
`;

/** Decoys keep the index larger than k, so "in the top 5" has to be earned.
 *  None of them mention permissions, checks or the query's other terms. */
const DECOYS: Record<string, string> = {
  "src/storage/disk.ts": `export function readBlock(offset: number): Uint8Array {
  return new Uint8Array(offset);
}
`,
  "src/format/dates.ts": `export function toIso(input: Date): string {
  return input.toISOString();
}
`,
  "src/http/client.ts": `export async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  return response.json();
}
`,
  "src/queue/worker.ts": `export function drain(items: string[]): number {
  let done = 0;
  for (const item of items) done += item.length > 0 ? 1 : 0;
  return done;
}
`,
  "src/text/slug.ts": `export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
`,
  "src/math/vector.ts": `export function magnitude(values: number[]): number {
  return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
}
`,
  "src/log/logger.ts": `export function logLine(level: string, message: string): string {
  return \`\${level}: \${message}\`;
}
`,
  "src/config/load.ts": `export function loadOptions(file: string): Record<string, string> {
  return JSON.parse(file) as Record<string, string>;
}
`,
};

/** Files the index must contain: three core files plus the eight decoys. */
const EXPECTED_FILES = ["README.md", "src/config/load.ts", "src/format/dates.ts", "src/http/client.ts", "src/log/logger.ts", "src/math/vector.ts", "src/permissions.ts", "src/queue/worker.ts", "src/router.ts", "src/storage/disk.ts", "src/text/slug.ts"];
const FILE_COUNT = EXPECTED_FILES.length;

const QUERY = "where are permissions checked";
/** 1-based line of the permission check in PERMISSIONS_FILE. */
const ASSERT_PERMISSIONS_LINE = PERMISSIONS_FILE.split("\n").findIndex((line) => line.startsWith("export function assertPermissions")) + 1;

let root = "";

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildFixture(): void {
  write("src/permissions.ts", PERMISSIONS_FILE);
  write("src/router.ts", ROUTER_FILE);
  write("README.md", README_FILE);
  for (const [rel, content] of Object.entries(DECOYS)) write(rel, content);
  write(".gitignore", "*.gen.ts\nignored/\n");
  write("src/api.gen.ts", GENERATED_FILE);
  write("ignored/secret.ts", "export const secret = 1;\n");
  write("node_modules/dep/index.ts", "export const dep = 1;\n");
  write("dist/bundle.js", "console.log('built');\n");
}

/** Assert the acceptance criterion: the permission file is a top-5 hit whose
 *  line range covers the permission check itself. */
function assertPermissionFileFound(hits: Array<{ file: string; startLine: number; endLine: number; snippet: string }>): void {
  const found = hits.filter((h) => h.file === "src/permissions.ts");
  assert.ok(found.length > 0, `expected src/permissions.ts in the top 5, got ${hits.map((h) => h.file).join(", ") || "(nothing)"}`);
  assert.ok(
    found.some((h) => h.startLine <= ASSERT_PERMISSIONS_LINE && h.endLine >= ASSERT_PERMISSIONS_LINE),
    `expected a hit covering src/permissions.ts:${ASSERT_PERMISSIONS_LINE}`,
  );
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-codeindex-"));
  buildFixture();
});

after(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows can leave read-only files behind */
  }
});

describe("chunkSource", () => {
  it("keeps line-aligned chunks with overlap and full coverage", () => {
    const content = Array.from({ length: 60 }, (_, i) => `const value${i} = ${i};`).join("\n");
    const chunks = chunkSource(content, 200);
    assert.ok(chunks.length > 1, "expected the file to split into several chunks");
    assert.equal(chunks[0]!.startLine, 1, "the first chunk starts at line 1");
    for (const chunk of chunks) {
      assert.ok(chunk.endLine >= chunk.startLine, "endLine must not precede startLine");
      assert.ok(chunk.text.length <= 200 + 40, "chunk text should respect the size cap");
    }
    const lines = new Set<number>();
    for (const chunk of chunks) {
      for (let line = chunk.startLine; line <= chunk.endLine; line++) lines.add(line);
    }
    assert.equal(lines.size, 60, "every line must land in at least one chunk");
  });

  it("returns a single chunk for a small file", () => {
    const chunks = chunkSource("a\nb\nc", 4000);
    assert.equal(chunks.length, 1);
    assert.deepEqual({ startLine: chunks[0]!.startLine, endLine: chunks[0]!.endLine }, { startLine: 1, endLine: 3 });
  });

  it("stops at maxChunks so one huge file cannot explode the index", () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkSource(content, 60, 3);
    assert.equal(chunks.length, 3, "the chunk count is capped");
    assert.ok(chunks[chunks.length - 1]!.endLine < 500, "the tail is deliberately left out of the index");
  });
});

describe("IgnoreMatcher", () => {
  it("applies globs, directory rules, negation and anchoring", () => {
    const matcher = new IgnoreMatcher(["*.gen.ts", "ignored/", "/root-only.txt", "!keep.gen.ts", "# comment", ""]);
    assert.ok(matcher.isIgnored("src/api.gen.ts", false), "*.gen.ts matches at any depth");
    assert.ok(matcher.isIgnored("api.gen.ts", false), "*.gen.ts matches at the root");
    assert.ok(matcher.isIgnored("ignored/secret.ts", false), "a directory rule covers its contents");
    assert.ok(matcher.isIgnored("root-only.txt", false), "an anchored rule matches at the root");
    assert.ok(!matcher.isIgnored("nested/root-only.txt", false), "an anchored rule does not match deeper");
    assert.ok(!matcher.isIgnored("keep.gen.ts", false), "a negation re-includes a file");
    assert.ok(!matcher.isIgnored("src/router.ts", false), "unrelated files are kept");
  });
});

describe("CodeIndex", () => {
  it("indexes the fixture, honours .gitignore and skips node_modules/dist", async () => {
    const index = new CodeIndex(root, { dbPath: path.join(root, "idx-a.db") });
    try {
      const result = await index.index();
      assert.equal(result.mode, "bm25", "no embedder means BM25");
      assert.equal(result.reindexed, FILE_COUNT, "every source file is indexed");
      assert.deepEqual(index.files(), EXPECTED_FILES);
      assert.ok(!index.files().some((f) => f.includes("node_modules")), "node_modules must be skipped");
      assert.ok(!index.files().some((f) => f.includes("dist")), "dist must be skipped");
      assert.ok(!index.files().includes("src/api.gen.ts"), "*.gen.ts is gitignored");
      assert.ok(!index.files().some((f) => f.startsWith("ignored/")), "ignored/ is gitignored");
      assert.equal(index.stats().chunks, FILE_COUNT, "each small file contributes one chunk");
    } finally {
      index.close();
    }
  });

  it("answers 'where are permissions checked' with the permission file in the top 5 (BM25)", async () => {
    const index = new CodeIndex(root, { dbPath: path.join(root, "idx-b.db") });
    try {
      await index.index();
      const hits = await index.search(QUERY, 5);
      assert.ok(hits.length > 0 && hits.length <= 5, "BM25 returns at most k matching chunks");
      assertPermissionFileFound(hits);
      assert.ok(hits.every((h) => h.via === "bm25"), "BM25 mode must report via=bm25");
      assert.ok(hits.every((h) => h.snippet.length > 0), "hits must carry a snippet");
      for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1]!.score >= hits[i]!.score, "hits are ordered by descending score");
    } finally {
      index.close();
    }
  });

  it("finds the permission file with an embedder too (vector path)", async () => {
    const index = new CodeIndex(root, { dbPath: path.join(root, "idx-c.db"), embedder: hashingEmbedder(), model: "fake-embed" });
    try {
      const result = await index.index();
      assert.equal(result.mode, "vector");
      const hits = await index.search(QUERY, 5);
      assert.ok(hits.length > 0 && hits.length <= 5, "the vector path returns at most k matching chunks");
      assertPermissionFileFound(hits);
      assert.ok(hits.every((h) => h.via === "vector"), "vector mode must report via=vector");
      assert.ok(hits.every((h) => Number.isFinite(h.score) && h.score > 0), "unrelated chunks are not returned");
      for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1]!.score >= hits[i]!.score, "hits are ordered by descending score");
    } finally {
      index.close();
    }
  });

  it("re-indexes nothing on an unchanged rescan, then only the changed file", async () => {
    const embedder = hashingEmbedder();
    const index = new CodeIndex(root, { dbPath: path.join(root, "idx-d.db"), embedder, model: "fake-embed" });
    try {
      const first = await index.index();
      assert.equal(first.reindexed, FILE_COUNT, "the first scan indexes every file");
      const afterFirst = embedder.embeddedTexts().length;

      const second = await index.index();
      assert.equal(second.reindexed, 0, "an unchanged rescan must re-index nothing");
      assert.equal(second.skipped, FILE_COUNT, "every file is reported as unchanged");
      assert.equal(embedder.embeddedTexts().length, afterFirst, "an unchanged rescan must not re-embed anything");

      write("src/router.ts", `${ROUTER_FILE}\nexport const changedMarker = true;\n`);
      const third = await index.index();
      assert.equal(third.reindexed, 1, "only the changed file is re-indexed");
      assert.equal(third.skipped, FILE_COUNT - 1, "the untouched files stay skipped");
      const newlyEmbedded = embedder.embeddedTexts().slice(afterFirst);
      assert.ok(newlyEmbedded.length > 0, "the changed file is re-embedded");
      assert.ok(
        newlyEmbedded.every((text) => text.includes("changedMarker")),
        "only the changed file's chunks are re-embedded",
      );
      write("src/router.ts", ROUTER_FILE);
    } finally {
      index.close();
    }
  });

  it("prunes a deleted file from the index", async () => {
    const index = new CodeIndex(root, { dbPath: path.join(root, "idx-e.db") });
    try {
      await index.index();
      assert.ok(index.files().includes("src/permissions.ts"), "the file starts indexed");
      const chunksBefore = index.stats().chunks;

      fs.rmSync(path.join(root, "src", "permissions.ts"));
      const result = await index.index();
      assert.ok(result.removed > 0, "pruning must report removed chunks");
      assert.equal(result.files, FILE_COUNT - 1, "the index shrinks by one file");
      assert.ok(!index.files().includes("src/permissions.ts"), "the deleted file is gone from the index");
      assert.ok(index.stats().chunks < chunksBefore, "its chunks were dropped");
      assert.ok(
        !(await index.search(QUERY, 5)).some((h) => h.file === "src/permissions.ts"),
        "the deleted file cannot be returned by search",
      );
    } finally {
      index.close();
    }
    write("src/permissions.ts", PERMISSIONS_FILE);
  });

  it("falls back to BM25 when the embedder fails", async () => {
    const index = new CodeIndex(root, { dbPath: path.join(root, "idx-f.db"), embedder: brokenEmbedder, model: "fake-embed" });
    try {
      const result = await index.index();
      assert.equal(result.mode, "bm25", "a failing embedder degrades the index to BM25");
      assert.equal(index.scoringMode, "bm25");
      const hits = await index.search(QUERY, 5);
      assert.ok(hits.length > 0 && hits.length <= 5, "search still works without an embedding backend");
      assertPermissionFileFound(hits);
      assert.ok(hits.every((h) => h.via === "bm25"));
    } finally {
      index.close();
    }
  });

  it("persists across reopen and prunes files that became ignored", async () => {
    const dbPath = path.join(root, "idx-g.db");
    const first = new CodeIndex(root, { dbPath });
    await first.index();
    assert.ok(first.files().includes("README.md"));
    first.close();

    write(".gitignore", "*.gen.ts\nignored/\nREADME.md\n");
    const second = new CodeIndex(root, { dbPath });
    try {
      const result = await second.index();
      assert.equal(result.skipped, FILE_COUNT - 1, "the surviving files are unchanged, so none is re-embedded");
      assert.ok(result.removed > 0, "the newly ignored file is pruned");
      assert.ok(!second.files().includes("README.md"), "a newly ignored file is pruned");
      assert.ok(second.files().includes("src/permissions.ts"), "the index survived the reopen");
    } finally {
      second.close();
      write(".gitignore", "*.gen.ts\nignored/\n");
    }
  });

  it("returns no hits for an empty or unmatched query", async () => {
    const index = new CodeIndex(root, { dbPath: path.join(root, "idx-h.db") });
    try {
      await index.index();
      assert.deepEqual(await index.search("   ", 5), [], "a blank query returns nothing");
      assert.deepEqual(await index.search("zzzzznotpresent", 5), [], "an unmatched query returns nothing");
    } finally {
      index.close();
    }
  });

  it("honours an abort signal", async () => {
    const index = new CodeIndex(root, { dbPath: path.join(root, "idx-i.db") });
    try {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(() => index.index({ signal: controller.signal }), /aborted/);
    } finally {
      index.close();
    }
  });

  it("hashes content stably", () => {
    assert.equal(hashContent("abc"), hashContent("abc"));
    assert.notEqual(hashContent("abc"), hashContent("abd"));
  });
});
