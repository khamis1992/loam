import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parsePage, serializePage } from "../frontmatter.js";
import { assertValidId, pagePath, projectKey } from "../paths.js";
import { sanitizeText } from "../sanitize.js";
import { deletePage, listPages, readPage, reindex, writePage } from "../store.js";
import * as index from "../wikiIndex.js";

let root: string;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wiki-")); });
after(() => { index.closeIndex(); fs.rmSync(root, { recursive: true, force: true }); });

describe("paths", () => {
  it("project key is stable and distinguishes folders with the same name", () => {
    assert.equal(projectKey("C:\\a\\app"), projectKey("C:\\a\\app"));
    assert.notEqual(projectKey("C:\\a\\app"), projectKey("C:\\b\\app"));
    assert.match(projectKey("C:\\a\\My App"), /^my-app-[0-9a-f]{10}$/);
  });
  it("rejects ids and kinds that could escape the root", () => {
    assert.throws(() => assertValidId("../x"));
    assert.throws(() => assertValidId("a/b"));
    assert.throws(() => pagePath(root, "note", "..\\x"));
    assert.throws(() => pagePath(root, "evil" as never, "x"));
  });
});

describe("frontmatter", () => {
  it("round-trips titles with colons and newlines", () => {
    const page = {
      meta: { id: "a1", kind: "note" as const, title: "Fix: the \"thing\"\nnow", created: "c", updated: "u", tags: ["x", "y"] },
      body: "hello\nworld",
    };
    assert.deepEqual(parsePage(serializePage(page)), page);
  });
});

describe("sanitize", () => {
  it("strips credentials instead of persisting them", () => {
    const out = sanitizeText("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG here");
    assert.ok(!out.includes("sk-ant-api03"));
  });
});

describe("store", () => {
  it("writes, reads, lists and searches a page", () => {
    writePage(root, { kind: "note", id: "build-cmd", title: "Build command", body: "run npm run build then npm test", tags: ["Build"] });
    const page = readPage(root, "note", "build-cmd");
    assert.equal(page?.meta.title, "Build command");
    assert.deepEqual(page?.meta.tags, ["build"]);
    assert.equal(listPages(root, "note").length, 1);
    assert.equal(index.search(root, "npm test")[0]?.id, "build-cmd");
    assert.ok(fs.existsSync(path.join(root, "INDEX.md")));
  });
  it("never writes a secret to disk", () => {
    writePage(root, { kind: "note", id: "leaky", title: "Leaky", body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end" });
    const text = fs.readFileSync(pagePath(root, "note", "leaky"), "utf8");
    assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  });
  it("supersede keeps the old page but hides it from default search", () => {
    writePage(root, { kind: "note", id: "deploy-v1", title: "Deploy v1", body: "deploy with zebrafish" });
    writePage(root, { kind: "note", id: "deploy-v2", title: "Deploy v2", body: "deploy with kingfisher", supersedes: "deploy-v1" });
    assert.equal(readPage(root, "note", "deploy-v1")?.meta.supersededBy, "deploy-v2");
    assert.equal(index.search(root, "zebrafish").length, 0);
    assert.equal(index.search(root, "zebrafish", { includeSuperseded: true }).length, 1);
  });
  it("reindex rebuilds the search index from files", () => {
    index.reset(root);
    assert.equal(index.search(root, "kingfisher").length, 0);
    assert.ok(reindex(root) >= 3);
    assert.equal(index.search(root, "kingfisher")[0]?.id, "deploy-v2");
  });
  it("delete removes file and index row", () => {
    assert.equal(deletePage(root, "note", "leaky"), true);
    assert.equal(readPage(root, "note", "leaky"), undefined);
    assert.equal(deletePage(root, "note", "leaky"), false);
  });
});
