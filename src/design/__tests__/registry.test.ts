/**
 * V9 tests: the design-registry contract.
 *
 * Covers the manifest validator (schema, cross-block invariants, RTL/Arabic
 * quality), the esbuild build gate, and the retrieval ranking. Negative cases
 * use throwaway temp blocks so the real registry is never mutated.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  BLOCKS_DIR,
  MANIFEST_SCHEMA,
  buildBlock,
  buildRegistry,
  readManifest,
  searchBlocks,
  validateManifest,
  validateRegistry,
  type BlockManifest,
} from "../registry.js";

const ARABIC_RE = /[\u0600-\u06FF]/g;

function baseManifest(overrides: Partial<BlockManifest> = {}): BlockManifest {
  return {
    schema: MANIFEST_SCHEMA,
    id: "alpha",
    name: "Alpha",
    description: "A valid test block used by the registry unit tests.",
    category: "hero",
    license: "MIT",
    source: "shadcn/ui blocks",
    tags: ["hero", "test"],
    intent: "Exercise the registry validator in tests.",
    deps: ["react"],
    rtl: false,
    dir: "ltr",
    lang: "en",
    screenshot: "pending",
    entry: "Block.tsx",
    files: ["Block.tsx", "manifest.json"],
    ...overrides,
  };
}

const VALID_TSX = `export default function Block() {\n  return <section>hello</section>;\n}\n`;

const tempDirs: string[] = [];

function makeBlock(name: string, manifest: BlockManifest, entry = VALID_TSX): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loam-registry-${name}-`));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "Block.tsx"), entry);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("registry contract", () => {
  it("validates the real registry with no issues", () => {
    const { records, issues } = validateRegistry();
    assert.equal(issues.length, 0, issues.map((i) => `${i.block}.${i.field}: ${i.message}`).join("\n"));
    assert.ok(records.length >= 30, `expected at least 30 blocks, found ${records.length}`);
  });

  it("ships at least 8 RTL Arabic variants with real copy and direction", () => {
    const { records } = validateRegistry();
    const rtl = records.filter((r) => r.manifest.rtl);
    assert.ok(rtl.length >= 8, `expected at least 8 RTL blocks, found ${rtl.length}`);
    for (const record of rtl) {
      assert.equal(record.manifest.dir, "rtl");
      assert.equal(record.manifest.lang, "ar");
      assert.ok(record.manifest.base, "an RTL variant must name its LTR base");
      const source = fs.readFileSync(path.join(record.dirPath, record.manifest.entry), "utf8");
      const arabic = source.match(ARABIC_RE)?.length ?? 0;
      assert.ok(arabic >= 10, `${record.id} has only ${arabic} Arabic characters`);
      assert.match(source, /dir=["']rtl["']/, `${record.id} must set dir="rtl"`);
    }
  });

  it("builds every block", async () => {
    const result = await buildRegistry();
    assert.equal(result.ok, true, result.issues.map((i) => `${i.block}: ${i.message}`).join("\n"));
    assert.equal(result.built, validateRegistry().records.length);
  });

  it("retrieves a pricing block for a pricing query", () => {
    const hits = searchBlocks("pricing plans", 3);
    assert.ok(hits.length > 0, "pricing query must return hits");
    assert.equal(hits[0]!.manifest.category, "pricing");
  });
});

describe("manifest validation", () => {
  it("accepts a well-formed manifest", () => {
    const dir = makeBlock("valid", baseManifest());
    assert.deepEqual(validateManifest(baseManifest(), dir, "alpha"), []);
    assert.ok(readManifest(dir));
  });

  it("rejects an id that does not match its directory", () => {
    const dir = makeBlock("mismatch", baseManifest({ id: "beta" }));
    const issues = validateManifest(baseManifest({ id: "beta" }), dir, "alpha");
    assert.ok(issues.some((i) => i.field === "id"));
  });

  it("rejects a non-permissive license", () => {
    const dir = makeBlock("license", baseManifest());
    const manifest = baseManifest({ license: "GPL" as unknown as BlockManifest["license"] });
    const issues = validateManifest(manifest, dir, "alpha");
    assert.ok(issues.some((i) => i.field === "license"));
  });

  it("rejects an unknown category", () => {
    const dir = makeBlock("category", baseManifest());
    const manifest = baseManifest({ category: "carousel" as unknown as BlockManifest["category"] });
    const issues = validateManifest(manifest, dir, "alpha");
    assert.ok(issues.some((i) => i.field === "category"));
  });

  it("rejects a manifest whose entry file is missing", () => {
    const dir = makeBlock("missing-entry", baseManifest({ files: ["Block.tsx"] }));
    const manifest = baseManifest({ entry: "Nope.tsx", files: ["Nope.tsx"] });
    const issues = validateManifest(manifest, dir, "alpha");
    assert.ok(issues.some((i) => i.field === "entry"));
  });

  it("rejects an RTL block without Arabic copy or direction", () => {
    const dir = makeBlock(
      "rtl-bad",
      baseManifest({
        id: "rtl-bad",
        rtl: true,
        dir: "rtl",
        lang: "ar",
        base: "hero-centered",
      }),
    );
    const issues = validateManifest(
      baseManifest({ rtl: true, dir: "rtl", lang: "ar", base: "hero-centered" }),
      dir,
      "rtl-bad",
    );
    assert.ok(issues.some((i) => i.field === "entry"));
  });

  it("rejects an RTL variant whose base block does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-registry-base-"));
    tempDirs.push(root);
    const dir = path.join(root, "rtl-ghost");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify(
        baseManifest({ id: "rtl-ghost", rtl: true, dir: "rtl", lang: "ar", base: "does-not-exist" }),
      ),
    );
    fs.writeFileSync(
      path.join(dir, "Block.tsx"),
      `export default function B(){ return <section dir="rtl">مرحبًا بك في مساحة العمل هذه</section>; }\n`,
    );
    const { issues } = validateRegistry(root);
    assert.ok(issues.some((i) => i.field === "base" && /does-not-exist/.test(i.message)));
  });

  it("rejects duplicate ids across blocks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-registry-dup-"));
    tempDirs.push(root);
    for (const name of ["one", "two"]) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(baseManifest({ id: "dup" })));
      fs.writeFileSync(path.join(dir, "Block.tsx"), VALID_TSX);
    }
    const { issues } = validateRegistry(root);
    assert.ok(issues.some((i) => i.field === "id" && /duplicate/.test(i.message)));
  });
});

describe("block build", () => {
  it("builds a valid block", async () => {
    const dir = makeBlock("build-ok", baseManifest());
    const result = await buildBlock(dir);
    assert.equal(result.ok, true, result.message);
  });

  it("fails a block with a syntax error", async () => {
    const dir = makeBlock("build-bad", baseManifest(), `export default function () {\n`);
    const result = await buildBlock(dir);
    assert.equal(result.ok, false);
    assert.ok(result.message.length > 0);
  });
});

describe("retrieval ranking", () => {
  it("returns nothing for an empty query", () => {
    assert.deepEqual(searchBlocks("", 5), []);
  });

  it("is deterministic and excludes non-matching blocks", () => {
    const a = searchBlocks("empty state", 5);
    const b = searchBlocks("empty state", 5);
    assert.deepEqual(a.map((h) => h.id), b.map((h) => h.id));
    assert.ok(a.some((h) => h.manifest.category === "empty-state"));
  });
});

describe("real registry shape", () => {
  it("keeps every block inside design-registry/blocks", () => {
    assert.ok(BLOCKS_DIR.endsWith(path.join("design-registry", "blocks")));
  });
});
