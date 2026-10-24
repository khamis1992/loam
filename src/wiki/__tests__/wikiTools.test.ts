import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wikitools-"));
  process.env.MANUS_LOCAL_DATA_DIR = dir;
});
after(async () => {
  (await import("../handoff.js")).closeHandoffs();
  (await import("../wikiIndex.js")).closeIndex();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ctx = (enabled: boolean) => ({ cfg: { wiki: { enabled } }, workspace: path.join(dir, "ws"), emit: () => {} }) as never;

describe("wiki tools", () => {
  it("refuse when the wiki is disabled", async () => {
    const { createProjectWikiTools } = await import("../../tools/wikiTools.js");
    const tool = createProjectWikiTools().find((t) => t.name === "wiki_search")!;
    const r = await tool.run({ query: "x" }, ctx(false));
    assert.equal(r.ok, false);
  });
  it("write, search and read back as untrusted; handoff resolves once", async () => {
    const { createProjectWikiTools } = await import("../../tools/wikiTools.js");
    const t = (n: string) => createProjectWikiTools().find((x) => x.name === n)!;
    const c = ctx(true);
    assert.equal((await t("wiki_write").run({ title: "Build cmd", body: "run npm test" }, c)).ok, true);
    const found = await t("wiki_search").run({ query: "npm test" }, c);
    assert.match(found.content, /UNTRUSTED/);
    assert.match(found.content, /build-cmd/);
    assert.match((await t("wiki_read").run({ kind: "note", id: "build-cmd" }, c)).content, /run npm test/);
    const h = await t("handoff_create").run({ title: "Resume parser", body: "todo" }, c);
    const id = /h-[a-z0-9]+/.exec(h.content)![0];
    assert.equal((await t("handoff_resolve").run({ id, to: "accepted" }, c)).ok, true);
    assert.equal((await t("handoff_resolve").run({ id, to: "dismissed" }, c)).ok, false);
  });
});
