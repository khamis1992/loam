/**
 * Focused frontier-R2 tests: deep_research routes its cited report into the
 * live Studio canvas (document / spreadsheet / presentation) through the same
 * studio store the office tools use. The research loop itself runs against a
 * mocked globalThis.fetch; routing is exercised against a real temp workspace.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";

import type { ToolContext } from "../../tools/registry.js";
import { createDeepResearchTools, deliverResearchToStudio, reportToStudioInput, type ReportData, type StudioInput } from "../../tools/deepResearch.js";
import { readStudio, saveStudio } from "../../studio/store.js";

const realFetch = globalThis.fetch;

type FetchCall = { url: string; body: string };
type FakeResponder = { match: (url: string) => boolean; body: string };

let calls: FetchCall[] = [];
let responders: FakeResponder[] = [];

function fakeResponse(body: string, status = 200) {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status < 400,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

const SEARCH_HOST = "html.duckduckgo.com";
const TOPIC = "vertical farming economics";

function seedResultsHtml(urls: string[]): string {
  const links = urls
    .map((url) => {
      const title = url.split("/").pop() || url;
      return `<a class="result__a" href="/html/?uddg=${encodeURIComponent(url)}">${title}</a>`;
    })
    .join("\n");
  return `<html><body>${links}<p>no-results placeholder</p></body></html>`;
}

globalThis.fetch = (async (input: RequestInfo | URL | string): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const responder = responders.find((r) => r.match(url));
  const body = responder?.body ?? "<html><body></body></html>";
  calls.push({ url, body });
  return fakeResponse(body);
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

function fakeCtx(workspace: string, networkEnabled = true): ToolContext {
  return {
    cfg: { policy: { networkEnabled } } as unknown as ToolContext["cfg"],
    workspace,
    emit: () => {},
  };
}

function resetFixtures() {
  calls = [];
  responders = [
    {
      match: (url) => url.includes(SEARCH_HOST) && url.includes("examples"),
      body: seedResultsHtml(["https://farms.test/cases"]),
    },
    {
      match: (url) => url.includes(SEARCH_HOST),
      body: seedResultsHtml(["https://farms.test/seed", "https://farms.test/risk"]),
    },
    {
      match: (url) => url.startsWith("https://farms.test/seed"),
      body: `<html><body>
        <p>Vertical farming economics start with an introduction: what is a stacked farm and why investors study it.</p>
        <p>This explanation shows how stacked farms work inside old warehouses using cheap LED lighting.</p>
      </body></html>`,
    },
    {
      match: (url) => url.startsWith("https://farms.test/risk"),
      body: `<html><body><p>The main limitations of vertical farming economics include high power costs and thin margins.</p></body></html>`,
    },
    {
      match: (url) => url.startsWith("https://farms.test/cases"),
      body: `<html><body><p>For example, case studies show city farms cutting lettuce delivery costs by a third every season.</p></body></html>`,
    },
  ];
}

const workspaces: string[] = [];
function newWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-studio-"));
  workspaces.push(dir);
  return dir;
}
after(() => {
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
});

const SAMPLE: ReportData = {
  topic: "Wind turbines",
  sources: [
    { n: 1, title: "Turbine primer", url: "https://wind.test/primer" },
    { n: 2, title: "Noise concerns", url: "https://wind.test/noise" },
  ],
  summary: [{ text: "Turbines convert moving air into electricity.", n: 1 }],
  sections: [
    {
      id: "overview",
      heading: "Overview",
      items: [{ text: "Turbines convert moving air into electricity.", n: 1 }],
    },
    {
      id: "limits",
      heading: "Limitations and Risks",
      items: [{ text: "Noise complaints are the leading risk for wind farms.", n: 2 }],
    },
  ],
  gaps: [{ id: "how", heading: "How It Works" }],
  iterations: 2,
};

describe("deep_research studio routing (frontier R2)", () => {
  describe("builders", () => {
    it("document variant has cited bullets, gaps and a sources table", () => {
      const input = reportToStudioInput(SAMPLE, "document");
      assert.equal(input.kind, "document");
      assert.equal(input.title, "Deep Research: Wind turbines");
      const blocks = (input.content as { blocks: Array<Record<string, unknown>> }).blocks;
      assert.equal(blocks[0]!.type, "paragraph");
      assert.ok(String(blocks[0]!.text).includes("Built from 2 source(s) over 2 search iteration(s)."));
      const headings = blocks.filter((b) => b.type === "heading").map((b) => b.text);
      assert.ok(headings.includes("Summary"));
      assert.ok(headings.includes("Overview"));
      assert.ok(headings.includes("Limitations and Risks"));
      assert.ok(headings.includes("Sources"));
      const bullets = blocks.filter((b) => b.type === "bullet").map((b) => String(b.text));
      assert.ok(bullets.some((t) => t.includes(" [1]")));
      assert.ok(bullets.some((t) => t.includes(" [2]")));
      assert.ok(bullets.some((t) => t.includes('No usable source verified the "How It Works" aspect')));
      const table = blocks.find((b) => b.type === "table") as { columns: string[]; rows: string[][] };
      assert.deepEqual(table.columns, ["#", "Source", "URL"]);
      assert.equal(table.rows.length, 2);
      assert.equal(table.rows[1]![2], "https://wind.test/noise");
    });

    it("spreadsheet variant is exactly one sheet so it can append onto a live sheet", () => {
      const input = reportToStudioInput(SAMPLE, "spreadsheet");
      const sheets = (input.content as { sheets: Array<{ name: string; cells: string[][] }> }).sheets;
      assert.equal(sheets.length, 1);
      assert.ok(sheets[0]!.cells.some((row) => row[0]?.includes("Deep Research: Wind turbines")));
      const flat = sheets[0]!.cells.flat();
      assert.ok(flat.some((c) => c.includes(" [2]")));
      assert.ok(flat.some((c) => c.includes("https://wind.test/primer")));
      const sourceHeader = sheets[0]!.cells.findIndex((row) => row[0] === "#" && row[1] === "Source" && row[2] === "URL");
      assert.ok(sourceHeader >= 0);
    });

    it("presentation variant has unique slide ids, hex colors and gap/sources slides", () => {
      const input = reportToStudioInput(SAMPLE, "presentation");
      const slides = (input.content as { slides: Array<Record<string, unknown>> }).slides;
      const ids = slides.map((s) => s.id);
      assert.equal(new Set(ids).size, slides.length);
      assert.ok(slides.some((s) => s.title === "Gaps"));
      assert.ok(slides.some((s) => s.title === "Sources"));
      for (const slide of slides) {
        assert.match(String(slide.background), /^#[\da-f]{6}$/i);
        assert.match(String(slide.accent), /^#[\da-f]{6}$/i);
      }
      const sources = slides.find((s) => s.title === "Sources")!;
      assert.ok(String(sources.body).includes("1. Turbine primer — https://wind.test/primer"));
    });
  });

  describe("deliverResearchToStudio routing", () => {
    it("creates on an empty canvas, then appends onto the same kind", () => {
      const workspace = newWorkspace();
      assert.equal(readStudio(workspace), null);
      const first = deliverResearchToStudio(reportToStudioInput(SAMPLE, "document"), workspace);
      assert.equal(first.ok, true);
      assert.equal(first.created, true);
      assert.equal(first.revision, 1);
      const afterCreate = readStudio(workspace)!;
      assert.equal(afterCreate.kind, "document");
      if (afterCreate.kind !== "document") throw new Error("expected a document artifact");
      const blockCount = afterCreate.content.blocks.length;
      const second = deliverResearchToStudio(reportToStudioInput(SAMPLE, "document"), workspace);
      assert.equal(second.ok, true);
      assert.equal(second.appended, true);
      assert.equal(second.revision, 2);
      const afterAppend = readStudio(workspace)!;
      assert.equal(afterAppend.kind, "document");
      if (afterAppend.kind !== "document") throw new Error("expected a document artifact");
      assert.equal(afterAppend.content.blocks.length, blockCount * 2);
    });

    it("refuses to clobber a different kind and leaves it untouched", () => {
      const workspace = newWorkspace();
      saveStudio(
        workspace,
        { kind: "spreadsheet", title: "User sheet", content: { sheets: [{ name: "Budget", cells: [["kept"]] }] } },
        0,
      );
      const before = readStudio(workspace)!;
      const delivery = deliverResearchToStudio(reportToStudioInput(SAMPLE, "document"), workspace);
      assert.equal(delivery.ok, false);
      assert.ok(delivery.reason!.includes("currently holds a spreadsheet"));
      const after = readStudio(workspace)!;
      assert.equal(after.kind, "spreadsheet");
      if (after.kind !== "spreadsheet") throw new Error("expected a spreadsheet artifact");
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.content.sheets[0]!.cells, [["kept"]]);
    });

    it("round-trips every variant through validateStudio/saveStudio", () => {
      for (const kind of ["document", "spreadsheet", "presentation"] as const) {
        const workspace = newWorkspace();
        const input = reportToStudioInput(SAMPLE, kind);
        saveStudio(workspace, input, 0);
        const artifact = readStudio(workspace)!;
        assert.equal(artifact.kind, kind);
        assert.equal(artifact.title, "Deep Research: Wind turbines");
      }
    });
  });

  describe("deep_research tool end to end", () => {
    it("delivers the full cited report into a document and reports it", async () => {
      resetFixtures();
      const workspace = newWorkspace();
      const tool = createDeepResearchTools().find((t) => t.name === "deep_research")!;
      const res = await tool.run({ topic: TOPIC, depth: 2, deliver: "document" }, fakeCtx(workspace));
      assert.equal(res.ok, true);
      assert.ok(res.content.includes(`# Deep Research: ${TOPIC}`), "report markdown must still be returned");
      assert.ok(res.content.includes("Studio delivery: saved as a document (revision 1, created on the empty canvas"));
      const artifact = readStudio(workspace)!;
      assert.equal(artifact.kind, "document");
      assert.equal(artifact.title, `Deep Research: ${TOPIC}`);
      if (artifact.kind !== "document") throw new Error("expected a document artifact");
      const table = artifact.content.blocks.find((b) => b.type === "table");
      assert.ok(table, "sources table must be present");
      assert.ok(artifact.content.blocks.some((b) => b.type === "bullet" && b.text.includes(" [3]")));
    });

    it("appends onto an existing matching canvas instead of duplicating a create", async () => {
      resetFixtures();
      const workspace = newWorkspace();
      const tool = createDeepResearchTools().find((t) => t.name === "deep_research")!;
      await tool.run({ topic: TOPIC, depth: 1, deliver: "spreadsheet" }, fakeCtx(workspace));
      const res = await tool.run({ topic: TOPIC, depth: 1, deliver: "spreadsheet" }, fakeCtx(workspace));
      assert.equal(res.ok, true);
      assert.ok(res.content.includes("appended onto the existing canvas"), res.content.slice(-400));
      const artifact = readStudio(workspace)!;
      assert.equal(artifact.kind, "spreadsheet");
      if (artifact.kind !== "spreadsheet") throw new Error("expected a spreadsheet artifact");
      const cells = artifact.content.sheets[0]!.cells;
      const topicRows = cells.filter((row) => row[0] === "Topic").length;
      assert.equal(topicRows, 2, "the second delivery must add its own Topic row");
    });

    it("skips delivery on a different kind without losing the report", async () => {
      resetFixtures();
      const workspace = newWorkspace();
      saveStudio(workspace, reportToStudioInput(SAMPLE, "presentation"), 0);
      const tool = createDeepResearchTools().find((t) => t.name === "deep_research")!;
      const res = await tool.run({ topic: TOPIC, depth: 1, deliver: "document" }, fakeCtx(workspace));
      assert.equal(res.ok, true);
      assert.ok(res.content.includes("Studio delivery skipped: The live studio currently holds a presentation"));
      assert.ok(res.content.includes(`# Deep Research: ${TOPIC}`));
      const artifact = readStudio(workspace)!;
      assert.equal(artifact.kind, "presentation");
      assert.equal(artifact.revision, 1, "the existing deck must remain untouched");
    });

    it("rejects an invalid deliver value without touching the network", async () => {
      resetFixtures();
      const tool = createDeepResearchTools().find((t) => t.name === "deep_research")!;
      const res = await tool.run({ topic: TOPIC, deliver: "postcard" }, fakeCtx(newWorkspace()));
      assert.equal(res.ok, false);
      assert.ok(res.content.includes("deliver must be"));
      assert.equal(calls.length, 0, "invalid deliver must not trigger any fetch");
    });
  });
});
