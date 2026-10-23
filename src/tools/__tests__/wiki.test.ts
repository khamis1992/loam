/**
 * D8 repo wiki + ask_codebase tests.
 *
 * Runs against a fixture repository with a mocked model client (no network).
 * Guarantees under test:
 *  - generateWiki produces overview + architecture + one page per major dir
 *  - every generated page has at least one VALID source link (path:line)
 *  - .loam/wiki.json pages are respected (title + parent)
 *  - the wiki is stored under data/wikis/<project>
 *  - ask_codebase answers with a citation to an existing file
 *
 * MANUS_LOCAL_DATA_DIR is set before the wiki module (which reads DATA_DIR at
 * import time) is dynamically imported.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let workspace = "";
let wikiMod: typeof import("../wiki.js");

interface FakeModel {
  chat(opts: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }>;
}

function fixtureModel(answer: string): FakeModel {
  return {
    async chat(opts) {
      const prompt = opts.messages.map((m) => m.content).join("\n");
      if (/Question:/.test(prompt)) return { content: answer };
      return { content: `Fake wiki prose for the page described below.\n\n${prompt.split("\n")[0] ?? ""}` };
    },
  };
}

describe("repo wiki generator + ask_codebase", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wiki-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    workspace = path.join(tmpDir, "fixture-repo");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "lib"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".loam"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "fixture-repo", version: "1.0.0", private: true }, null, 2),
    );
    fs.writeFileSync(
      path.join(workspace, "src", "index.ts"),
      ['import { helper } from "./util.js";', "", "export function main(): void {", '  console.log(helper());', "}", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(workspace, "src", "util.ts"),
      ["export function helper(): number {", "  return 42;", "}", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(workspace, "lib", "engine.ts"),
      ['import { helper } from "../src/util.js";', "", "export class Engine {", "  run(): number {", "    return helper();", "  }", "}", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(workspace, "lib", "parser.ts"),
      ["export function parse(input: string): string[] {", "  return input.split(/\\s+/);", "}", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(workspace, ".loam", "wiki.json"),
      JSON.stringify(
        {
          project: "fixture-wiki",
          repo_notes: ["Fixture repo for wiki tests."],
          pages: [{ title: "Parsing Pipeline", purpose: "How text is parsed into engine input", parent: "Architecture" }],
        },
        null,
        2,
      ),
    );
    wikiMod = (await import("../wiki.js")) as typeof import("../wiki.js");
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("generates overview + architecture + one page per major directory + config pages", async () => {
    const index = await wikiMod.generateWiki({
      workspace,
      model: "fake-model",
      client: fixtureModel("The entry point is src/index.ts:1."),
    });
    const titles = index.pages.map((p) => p.title);
    assert.ok(titles.includes("Overview"), `missing Overview in ${titles.join(", ")}`);
    assert.ok(titles.includes("Architecture"), `missing Architecture in ${titles.join(", ")}`);
    assert.ok(titles.includes("src"), `missing src page in ${titles.join(", ")}`);
    assert.ok(titles.includes("lib"), `missing lib page in ${titles.join(", ")}`);
    // wiki.json pages are respected
    const custom = index.pages.find((p) => p.title === "Parsing Pipeline");
    assert.ok(custom, "config page 'Parsing Pipeline' was not generated");
    assert.equal(custom.parent, "Architecture");
    assert.equal(custom.purpose, "How text is parsed into engine input");
  });

  it("gives every generated page at least one valid source link", async () => {
    const index = await wikiMod.generateWiki({ workspace, model: "fake-model", client: fixtureModel("src/index.ts:1") });
    assert.ok(index.pages.length >= 5);
    for (const page of index.pages) {
      const links = [...page.content.matchAll(/`([^`]+):(\d+)`/g)].map((m) => ({ path: m[1]!, line: Number(m[2]!) }));
      assert.ok(links.length >= 1, `page "${page.title}" has no source links`);
      const valid = links.filter((l) => wikiMod.isValidSourceLink(workspace, l));
      assert.ok(valid.length >= 1, `page "${page.title}" has no VALID source link (checked ${JSON.stringify(links)})`);
    }
  });

  it("stores the wiki under data/wikis/<project> with an index and page files", async () => {
    const index = await wikiMod.generateWiki({ workspace, model: "fake-model", client: fixtureModel("src/index.ts:1") });
    const root = path.join(tmpDir, "wikis", "fixture-wiki");
    assert.ok(fs.existsSync(path.join(root, "index.json")), "index.json missing");
    const stored = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")) as { pages: Array<{ slug: string }> };
    assert.equal(stored.pages.length, index.pages.length);
    for (const page of index.pages) {
      assert.ok(fs.existsSync(path.join(root, `${page.slug}.md`)), `page file ${page.slug}.md missing`);
    }
    assert.deepEqual(wikiMod.listWikiProjects(), ["fixture-wiki"]);
  });

  it("ask_codebase answers with a citation to an existing file", async () => {
    await wikiMod.generateWiki({ workspace, model: "fake-model", client: fixtureModel("src/index.ts:1") });
    const result = await wikiMod.askCodebase({
      workspace,
      question: "Where is the entry point?",
      model: "fake-model",
      client: fixtureModel("The entry point is src/index.ts:1."),
    });
    assert.equal(result.ok, true);
    assert.ok(result.citations.length >= 1, "no citations returned");
    const cite = result.citations[0]!;
    const [rel, line] = cite.split(":");
    assert.ok(fs.existsSync(path.join(workspace, rel!)), `citation ${cite} does not point at an existing file`);
    const lines = fs.readFileSync(path.join(workspace, rel!), "utf8").split(/\r?\n/).length;
    assert.ok(Number(line) <= lines, `citation ${cite} points past end of file`);
    assert.ok(result.content.includes(cite));
  });

  it("ask_codebase falls back to search hits when the model cites nothing", async () => {
    await wikiMod.generateWiki({ workspace, model: "fake-model", client: fixtureModel("src/index.ts:1") });
    const result = await wikiMod.askCodebase({
      workspace,
      question: "helper",
      model: "fake-model",
      client: fixtureModel("The helper function is defined in the util module."),
    });
    assert.equal(result.ok, true);
    assert.ok(result.citations.length >= 1, "expected a search-hit citation fallback");
    const [rel] = result.citations[0]!.split(":");
    assert.ok(fs.existsSync(path.join(workspace, rel!)), `fallback citation ${result.citations[0]} is not a real file`);
  });

  it("extractCitations only keeps links that resolve", () => {
    const cites = wikiMod.extractCitations("see src/index.ts:1 and nope/missing.ts:3", workspace);
    assert.deepEqual(cites, ["src/index.ts:1"]);
  });

  it("localGrep finds matching lines", () => {
    const hits = wikiMod.localGrep(workspace, "helper");
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => fs.existsSync(path.join(workspace, h.path))));
  });
});
