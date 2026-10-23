/**
 * V12 tool-layer tests: design_image_generate and design_page_images.
 *
 * The tools are the model-facing surface of the asset pipeline. These tests
 * cover input validation, the generated `<img>` tags, the audit/rewrite repair
 * path, writing the repaired page to disk, and the always-on + prompt wiring
 * that makes the tools reachable in a real run.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import type { Config } from "../../config.js";
import type { Emit } from "../../agent/events.js";
import type { ToolContext } from "../registry.js";
import { createDesignAssetsTools, DESIGN_ASSETS_TOOL_NAMES } from "../designAssets.js";

let tmpDir = "";

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-design-asset-tools-"));
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function ctx(workspace = tmpDir): ToolContext {
  return { cfg: {} as Config, workspace, emit: (() => undefined) as Emit };
}

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

function generateTool() {
  return createDesignAssetsTools().find((t) => t.name === "design_image_generate")!;
}

function pageImagesTool() {
  return createDesignAssetsTools().find((t) => t.name === "design_page_images")!;
}

describe("tool registration", () => {
  it("exposes both asset tools", () => {
    assert.deepEqual(DESIGN_ASSETS_TOOL_NAMES, ["design_image_generate", "design_page_images"]);
    const names = createDesignAssetsTools().map((t) => t.name);
    assert.deepEqual(names, DESIGN_ASSETS_TOOL_NAMES);
  });

  it("is merged into the effective run allowlist as an always-on tool", async () => {
    const { mergeAlwaysOnTools, ALWAYS_ON_TOOLS } = await import("../../server/runTools.js");
    for (const name of DESIGN_ASSETS_TOOL_NAMES) {
      assert.ok(ALWAYS_ON_TOOLS.includes(name), `${name} must be always-on`);
      const merged = mergeAlwaysOnTools({ resolvedAllow: [], registeredTools: [name] });
      assert.ok(merged.includes(name), `${name} must reach the model after the always-on merge`);
    }
  });

  it("injects the image directive into the system prompt when present", async () => {
    const { buildSystemPrompt } = await import("../../agent/prompt.js");
    const cfg = { workspace: tmpDir, policy: { networkEnabled: false } } as unknown as Parameters<typeof buildSystemPrompt>[0];
    const withTools = buildSystemPrompt(cfg, [], ["file_read", ...DESIGN_ASSETS_TOOL_NAMES]);
    assert.match(withTools, /never link a placeholder service/);
    const without = buildSystemPrompt(cfg, [], ["file_read"]);
    assert.ok(!without.includes("never link a placeholder service"));
  });
});

describe("design_image_generate", () => {
  it("generates an asset from the prompt/alt shorthand and returns an img tag", async () => {
    const res = await generateTool().run({ prompt: "Hero banner", alt: "Hero banner" }, ctx());
    assert.ok(res.ok, res.content);
    const payload = parse(res.content) as { assets: Array<Record<string, unknown>>; imgTags: string[]; files: string[] };
    assert.equal(payload.assets.length, 1);
    assert.match(String(payload.assets[0]!.src), /^\/assets\/ui\/ui_[a-z0-9_-]+\.(png|svg)$/);
    assert.equal(payload.files.length, 1);
    assert.match(payload.imgTags[0]!, /alt="Hero banner"/);
    assert.match(payload.imgTags[0]!, /src="\/assets\/ui\//);
    assert.ok(fs.existsSync(String(payload.assets[0]!.file)));
  });

  it("accepts a requests array and preserves order", async () => {
    const res = await generateTool().run(
      { requests: [{ prompt: "First", alt: "First" }, { prompt: "Second", alt: "Second" }] },
      ctx(),
    );
    assert.ok(res.ok, res.content);
    const payload = parse(res.content) as { assets: Array<{ alt: string }> };
    assert.deepEqual(payload.assets.map((a) => a.alt), ["First", "Second"]);
  });

  it("requires alt text so no image ships without an accessible description", async () => {
    const res = await generateTool().run({ prompt: "Hero" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /alt is required/);
  });

  it("rejects a request missing alt inside the array", async () => {
    const res = await generateTool().run({ requests: [{ prompt: "Hero" }] }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /alt is required/);
  });

  it("uses an injected generator without contacting an external model", async () => {
    const tool = createDesignAssetsTools({
      generator: async () => ({ bytes: Buffer.from("injected"), format: "svg", width: 32, height: 32 }),
    }).find((t) => t.name === "design_image_generate")!;
    const res = await tool.run({ prompt: "Injected", alt: "Injected" }, ctx());
    assert.ok(res.ok, res.content);
    const payload = parse(res.content) as { assets: Array<{ file: string; generator: string }> };
    assert.equal(payload.assets[0]!.generator, "injected");
    assert.equal(fs.readFileSync(payload.assets[0]!.file), "injected");
  });
});

describe("design_page_images", () => {
  it("audits a page and reports placeholders and missing alt", async () => {
    const res = await pageImagesTool().run(
      { action: "audit", html: '<img src="https://placehold.co/1"><img src="/a.png" alt="A">' },
      ctx(),
    );
    assert.ok(res.ok, res.content);
    const payload = parse(res.content) as { audit: { images: number; placeholders: string[]; missingAlt: string[]; ok: boolean }; summary: string };
    assert.equal(payload.audit.images, 2);
    assert.deepEqual(payload.audit.placeholders, ["https://placehold.co/1"]);
    assert.deepEqual(payload.audit.missingAlt, ["https://placehold.co/1"]);
    assert.equal(payload.audit.ok, false);
    assert.match(payload.summary, /needs-work/);
  });

  it("defaults to audit when no action is given", async () => {
    const res = await pageImagesTool().run({ html: '<img src="/a.png" alt="A">' }, ctx());
    assert.ok(res.ok, res.content);
    const payload = parse(res.content) as { action: string; audit: { ok: boolean } };
    assert.equal(payload.action, "audit");
    assert.equal(payload.audit.ok, true);
  });

  it("rewrites a page so it has no placeholders and no missing alt", async () => {
    const res = await pageImagesTool().run(
      {
        action: "rewrite",
        html: '<img src="https://placehold.co/800x400">',
        requests: [{ prompt: "Hero banner", alt: "Hero banner" }],
      },
      ctx(),
    );
    assert.ok(res.ok, res.content);
    const payload = parse(res.content) as {
      html: string;
      replaced: number;
      altFilled: number;
      finalAudit: { placeholders: string[]; missingAlt: string[]; ok: boolean };
    };
    assert.equal(payload.replaced, 1);
    assert.equal(payload.altFilled, 1);
    assert.equal(payload.finalAudit.placeholders.length, 0);
    assert.equal(payload.finalAudit.missingAlt.length, 0);
    assert.equal(payload.finalAudit.ok, true);
    assert.ok(!payload.html.includes("placehold.co"));
    assert.match(payload.html, /alt="Hero banner"/);
  });

  it("writes the repaired HTML to a task-relative outPath", async () => {
    const res = await pageImagesTool().run(
      {
        action: "rewrite",
        html: '<img src="https://picsum.photos/200">',
        requests: [{ prompt: "Photo", alt: "Photo" }],
        outPath: "dist/page.html",
      },
      ctx(),
    );
    assert.ok(res.ok, res.content);
    const payload = parse(res.content) as { writtenPath: string };
    assert.equal(payload.writtenPath, "dist/page.html");
    const written = fs.readFileSync(path.join(tmpDir, "dist", "page.html"), "utf8");
    assert.equal(written, (parse(res.content) as { html: string }).html);
  });

  it("rejects an unknown action and a missing html", async () => {
    const badAction = await pageImagesTool().run({ action: "nope", html: "<img src='/a.png' alt='A'>" }, ctx());
    assert.equal(badAction.ok, false);
    assert.match(badAction.content, /audit or rewrite/);

    const noHtml = await pageImagesTool().run({ action: "audit", html: "  " }, ctx());
    assert.equal(noHtml.ok, false);
    assert.match(noHtml.content, /html is required/);
  });

  it("fails loudly when a rewrite has fewer requests than placeholders", async () => {
    const res = await pageImagesTool().run(
      { action: "rewrite", html: '<img src="https://placehold.co/1"><img src="https://placehold.co/2">', requests: [{ prompt: "One", alt: "One" }] },
      ctx(),
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /placeholder image\(s\) but only 1 asset request/);
  });
});
