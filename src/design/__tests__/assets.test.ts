/**
 * V12 core tests: UI asset generation for generated pages (Loam UI Kit).
 *
 * The acceptance contract is that a generated page ships real local images
 * with accessible alt text and never a placeholder URL. These tests cover the
 * placeholder detector, the HTML audit/rewrite helpers, the deterministic
 * local generator, and the end-to-end `resolvePageAssets` repair that turns a
 * placeholder page into a placeholder-free, alt-complete page.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import {
  DEFAULT_UI_ASSET_PALETTE,
  auditPageImages,
  buildImgTag,
  generateUiAssets,
  isPlaceholderUrl,
  parseImgTags,
  renderUiAssetSvg,
  resolvePageAssets,
  rewritePageImages,
  summarizePageAssets,
  uiAssetId,
  type UiAssetRequest,
} from "../assets.js";

let tmpDir = "";

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-design-assets-"));
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("isPlaceholderUrl", () => {
  it("detects the known stand-in hosts with any scheme and subdomain", () => {
    for (const url of [
      "https://placehold.co/600x400",
      "http://www.placehold.co/600x400",
      "https://cdn.placehold.co/a.png",
      "https://picsum.photos/200/300",
      "https://via.placeholder.com/150",
      "https://dummyimage.com/600x400/000/fff",
      "https://fakeimg.pl/300x200",
    ]) {
      assert.equal(isPlaceholderUrl(url), true, url);
    }
  });

  it("detects placeholder path fragments on a custom host", () => {
    assert.equal(isPlaceholderUrl("https://cdn.example.com/placeholder/hero.png"), true);
    assert.equal(isPlaceholderUrl("https://cdn.example.com/img.png?placeholder=1"), true);
  });

  it("accepts local, data and empty values", () => {
    for (const url of ["/assets/ui/hero.png", "assets/ui/hero.svg", "data:image/png;base64,AAAA", "", "   "]) {
      assert.equal(isPlaceholderUrl(url), false, JSON.stringify(url));
    }
  });
});

describe("parseImgTags + auditPageImages", () => {
  it("parses src and alt, including single-quoted and missing attributes", () => {
    const html = [
      '<img src="https://placehold.co/1" alt="Hero">',
      "<img src='/local/a.png'>",
      '<img alt="no src">',
    ].join("");
    const tags = parseImgTags(html);
    assert.equal(tags.length, 3);
    assert.equal(tags[0]!.src, "https://placehold.co/1");
    assert.equal(tags[0]!.alt, "Hero");
    assert.equal(tags[1]!.src, "/local/a.png");
    assert.equal(tags[1]!.alt, undefined);
    assert.equal(tags[2]!.src, "");
  });

  it("reports placeholders and missing alt, and ok only when both are clean", () => {
    const audit = auditPageImages(
      '<img src="https://placehold.co/1"><img src="/a.png" alt="A"><img src="/b.png">',
    );
    assert.equal(audit.images, 3);
    assert.deepEqual(audit.placeholders, ["https://placehold.co/1"]);
    assert.deepEqual(audit.missingAlt, ["https://placehold.co/1", "/b.png"]);
    assert.equal(audit.ok, false);

    const clean = auditPageImages('<img src="/a.png" alt="A"><img src="/b.png" alt="B">');
    assert.equal(clean.ok, true);
    assert.equal(clean.placeholders.length, 0);
    assert.equal(clean.missingAlt.length, 0);
  });

  it("treats whitespace-only alt as missing", () => {
    const audit = auditPageImages('<img src="/a.png" alt="   ">');
    assert.equal(audit.ok, false);
    assert.deepEqual(audit.missingAlt, ["/a.png"]);
  });
});

describe("rewritePageImages", () => {
  it("replaces src values and fills missing alt, preserving existing alt", () => {
    const result = rewritePageImages({
      html: '<img src="https://placehold.co/1"><img src="/keep.png" alt="Keep">',
      srcMap: new Map([["https://placehold.co/1", "/assets/ui/hero.png"]]),
      altBySrc: new Map([["https://placehold.co/1", "Hero image"]]),
    });
    assert.equal(result.replaced, 1);
    assert.equal(result.altFilled, 1);
    assert.match(result.html, /src="\/assets\/ui\/hero\.png"/);
    assert.match(result.html, /alt="Hero image"/);
    assert.match(result.html, /alt="Keep"/);
    assert.ok(!result.html.includes("placehold.co"));
  });

  it("applies a default alt to any image still missing alt", () => {
    const result = rewritePageImages({ html: "<img src='/a.png'>", defaultAlt: "Generated asset" });
    assert.equal(result.altFilled, 1);
    assert.match(result.html, /alt="Generated asset"/);
  });

  it("leaves the HTML untouched when no map matches", () => {
    const html = '<img src="/a.png" alt="A">';
    const result = rewritePageImages({ html, srcMap: new Map([["/nope", "/x"]]) });
    assert.equal(result.html, html);
    assert.equal(result.replaced, 0);
    assert.equal(result.altFilled, 0);
  });
});

describe("renderUiAssetSvg", () => {
  it("is deterministic for the same request and carries the alt as a title", () => {
    const request: UiAssetRequest = { prompt: "A calm dashboard hero", alt: "لوحة تحكم هادئة", width: 800, height: 600 };
    const a = renderUiAssetSvg(request);
    const b = renderUiAssetSvg(request);
    assert.equal(a, b);
    assert.match(a, /<title>لوحة تحكم هادئة<\/title>/);
    assert.match(a, /width="800" height="600"/);
    assert.match(a, /role="img"/);
    assert.match(a, new RegExp(DEFAULT_UI_ASSET_PALETTE.background.replace("#", "#")));
  });

  it("escapes XML in the alt text", () => {
    const svg = renderUiAssetSvg({ prompt: "x", alt: 'a & b <c>' });
    assert.match(svg, /a &amp; b &lt;c&gt;/);
    assert.ok(!svg.includes("a & b <c>"));
  });

  it("clamps dimensions into the supported range", () => {
    const svg = renderUiAssetSvg({ prompt: "x", alt: "x", width: 5, height: 99999 });
    assert.match(svg, /width="16" height="4096"/);
  });
});

describe("generateUiAssets", () => {
  it("writes real local files and returns public src + records in request order", async () => {
    const workspace = path.join(tmpDir, "gen-ok");
    fs.mkdirSync(workspace, { recursive: true });
    const result = await generateUiAssets({
      workspace,
      requests: [
        { prompt: "Hero banner", alt: "Hero banner", width: 640, height: 400 },
        { prompt: "Feature icon", alt: "Feature icon", width: 256, height: 256 },
      ],
    });
    assert.equal(result.assets.length, 2);
    assert.equal(result.files.length, 2);
    for (const asset of result.assets) {
      assert.match(asset.src, /^\/assets\/ui\/ui_[a-z0-9_-]+\.(png|svg)$/);
      assert.equal(asset.generator, "local-svg");
      assert.ok(fs.existsSync(asset.file), asset.file);
      assert.ok(fs.statSync(asset.file).size > 0);
      assert.ok(asset.alt.length > 0);
    }
    assert.notEqual(result.assets[0]!.src, result.assets[1]!.src);
  });

  it("honours a custom public base and output directory", async () => {
    const workspace = path.join(tmpDir, "gen-dirs");
    fs.mkdirSync(workspace, { recursive: true });
    const result = await generateUiAssets({
      workspace,
      requests: [{ prompt: "Logo", alt: "Logo" }],
      publicBase: "img/kit",
      outDir: "public/img/kit",
    });
    assert.match(result.assets[0]!.src, /^\/img\/kit\//);
    assert.ok(result.assets[0]!.file.includes(path.join("public", "img", "kit")));
  });

  it("uses an injected generator and marks the record as injected", async () => {
    const workspace = path.join(tmpDir, "gen-injected");
    fs.mkdirSync(workspace, { recursive: true });
    const result = await generateUiAssets({
      workspace,
      requests: [{ prompt: "Photo", alt: "Photo" }],
      generator: async () => ({ bytes: Buffer.from("fake-png"), format: "png", width: 10, height: 10 }),
    });
    assert.equal(result.assets[0]!.generator, "injected");
    assert.equal(fs.readFileSync(result.assets[0]!.file), "fake-png");
  });

  it("rejects empty requests and missing prompt/alt", async () => {
    await assert.rejects(() => generateUiAssets({ workspace: tmpDir, requests: [] }), /at least one/);
    await assert.rejects(
      () => generateUiAssets({ workspace: tmpDir, requests: [{ prompt: "  ", alt: "x" }] }),
      /prompt is required/,
    );
    await assert.rejects(
      () => generateUiAssets({ workspace: tmpDir, requests: [{ prompt: "x", alt: "" }] }),
      /alt is required/,
    );
  });

  it("derives stable ids from prompt, seed and index", () => {
    assert.equal(uiAssetId(0, "Hero", "s"), uiAssetId(0, "Hero", "s"));
    assert.notEqual(uiAssetId(0, "Hero", "s"), uiAssetId(1, "Hero", "s"));
    assert.match(uiAssetId(0, "Hero banner", "s"), /^ui_[a-z0-9]+_hero-banner$/);
  });
});

describe("resolvePageAssets (acceptance)", () => {
  it("replaces every placeholder with a local asset and fills alt text", async () => {
    const workspace = path.join(tmpDir, "resolve-ok");
    fs.mkdirSync(workspace, { recursive: true });
    const html = [
      '<img src="https://placehold.co/800x400" alt="">',
      '<img src="https://picsum.photos/400/300">',
      '<img src="/already/local.png" alt="Local">',
    ].join("");
    const result = await resolvePageAssets(html, {
      workspace,
      requests: [
        { prompt: "Hero banner", alt: "Hero banner" },
        { prompt: "Feature photo", alt: "Feature photo" },
      ],
    });
    assert.equal(result.replaced, 2);
    assert.equal(result.altFilled, 2);
    assert.equal(result.finalAudit.placeholders.length, 0, "no placeholder URLs may remain");
    assert.equal(result.finalAudit.missingAlt.length, 0, "every image must carry alt text");
    assert.equal(result.finalAudit.ok, true);
    assert.ok(!result.html.includes("placehold.co"));
    assert.ok(!result.html.includes("picsum.photos"));
    for (const asset of result.assets) {
      assert.ok(fs.existsSync(asset.file));
      assert.match(result.html, new RegExp(asset.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("supports Arabic alt text and keeps RTL pages accessible", async () => {
    const workspace = path.join(tmpDir, "resolve-rtl");
    fs.mkdirSync(workspace, { recursive: true });
    const html = '<img src="https://placehold.co/600x300">';
    const result = await resolvePageAssets(html, {
      workspace,
      requests: [{ prompt: "صورة الغلاف", alt: "صورة الغلاف الرئيسية للصفحة" }],
    });
    assert.equal(result.finalAudit.ok, true);
    assert.match(result.html, /alt="صورة الغلاف الرئيسية للصفحة"/);
  });

  it("fills alt for a non-placeholder image that is missing alt via defaultAlt", async () => {
    const workspace = path.join(tmpDir, "resolve-default-alt");
    fs.mkdirSync(workspace, { recursive: true });
    const html = '<img src="https://placehold.co/1"><img src="https://cdn.example.com/photo.jpg">';
    const result = await resolvePageAssets(html, {
      workspace,
      requests: [{ prompt: "Hero", alt: "Hero" }],
      defaultAlt: "Generated UI asset",
    });
    assert.equal(result.finalAudit.placeholders.length, 0);
    assert.equal(result.finalAudit.missingAlt.length, 0);
    assert.equal(result.finalAudit.ok, true);
    assert.match(result.html, /cdn\.example\.com\/photo\.jpg" alt="Generated UI asset"/);
  });

  it("throws when fewer requests than placeholders are supplied", async () => {
    const workspace = path.join(tmpDir, "resolve-short");
    fs.mkdirSync(workspace, { recursive: true });
    await assert.rejects(
      () =>
        resolvePageAssets('<img src="https://placehold.co/1"><img src="https://placehold.co/2">', {
          workspace,
          requests: [{ prompt: "Only one", alt: "Only one" }],
        }),
      /placeholder image\(s\) but only 1 asset request/,
    );
  });

  it("returns the HTML unchanged when there is nothing to repair", async () => {
    const workspace = path.join(tmpDir, "resolve-clean");
    fs.mkdirSync(workspace, { recursive: true });
    const html = '<img src="/a.png" alt="A">';
    const result = await resolvePageAssets(html, { workspace, requests: [] });
    assert.equal(result.html, html);
    assert.equal(result.replaced, 0);
    assert.equal(result.finalAudit.ok, true);
  });
});

describe("buildImgTag + summarizePageAssets", () => {
  it("builds a complete, accessible img tag", () => {
    const tag = buildImgTag({ src: "/assets/ui/a.png", alt: "A dashboard", width: 800, height: 600 }, { className: "hero" });
    assert.match(tag, /src="\/assets\/ui\/a\.png"/);
    assert.match(tag, /alt="A dashboard"/);
    assert.match(tag, /width="800" height="600"/);
    assert.match(tag, /loading="lazy"/);
    assert.match(tag, /class="hero"/);
  });

  it("summarizes the audit for the agent response", () => {
    assert.equal(summarizePageAssets(auditPageImages('<img src="/a.png" alt="A">')), "images=1 ok");
    assert.match(
      summarizePageAssets(auditPageImages('<img src="https://placehold.co/1">')),
      /images=1 placeholders=1 missingAlt=1 needs-work/,
    );
  });
});
