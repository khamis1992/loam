/**
 * Neo N22 - docs build and link checker.
 *
 * The acceptance criterion for N22 is "Docs build, links valid". These tests
 * are that criterion: they build the real `docs/neo` guide, assert every local
 * link and anchor resolves, and assert the English and Arabic editions carry
 * the same structure. The pure functions are exercised against fixtures so a
 * specific failure is easy to name.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NEO_DOC_FILES,
  arabicFileOf,
  buildNeoDocs,
  checkNeoDocs,
  docFragmentLinks,
  docLinks,
  docRelated,
  docSections,
  docTitle,
  docsHtml,
  docsPageHtml,
  isExternalLink,
  linkPath,
  localeOf,
  localePairs,
  renderInline,
  type NeoDocPage,
} from "../neoDocs.js";
import { headingAnchor } from "../headingAnchors.js";

const DOC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "neo");

/** Read the real guide from disk. */
function readDisk(file: string): string | null {
  try {
    return fs.readFileSync(path.join(DOC_DIR, file), "utf8");
  } catch {
    return null;
  }
}

/** A guide with no page missing, built from the real files. */
function realGuide() {
  return buildNeoDocs(DOC_DIR, readDisk);
}

/** A tiny fixture guide, used to name a specific failure. */
function fixtureGuide(files: Record<string, string>) {
  return buildNeoDocs("/fixture", (file) => files[file] ?? null);
}

const INDEX = `# Guide

Related: [canvas](canvas.md) · [missions](missions.md)

See [canvas](canvas.md) and [missions](missions.md#budget-stops-are-clean-ends).
External: [site](https://example.com).
`;

const CANVAS = `# Canvas

Related: [index](README.md) · [missions](missions.md)

## Nodes

Some text with a [broken](nope.md) link and a [bad anchor](README.md#nope).
`;

const MISSIONS = `# Missions

Related: [index](README.md)

## Budget stops are clean ends

Body.
`;

test("the real guide has no missing page", () => {
  const guide = realGuide();
  assert.deepEqual(guide.missing, [], "every NEO_DOC_FILES entry must exist on disk");
  // 5 English subjects + 5 Arabic counterparts.
  assert.equal(guide.pages.length, NEO_DOC_FILES.length * 2);
});

test("the real guide is clean: every link, anchor and related page resolves", () => {
  const problems = checkNeoDocs(realGuide());
  assert.deepEqual(
    problems.map((p) => `${p.code}: ${p.message}`),
    [],
    "docs/neo must have no broken links, anchors or related references",
  );
});

test("every subject has an Arabic counterpart with the same section count", () => {
  const guide = realGuide();
  const pairs = localePairs(guide.pages);
  assert.equal(pairs.length, NEO_DOC_FILES.length, "each English page must have an Arabic twin");
  for (const [english, arabic] of pairs) {
    assert.equal(arabic.file, arabicFileOf(english.file));
    assert.equal(
      arabic.sections.length,
      english.sections.length,
      `${arabic.file} and ${english.file} must carry the same sections`,
    );
  }
});

test("the index of each locale points at the same set of pages", () => {
  const guide = realGuide();
  const [enIndex] = guide.pages;
  const arIndex = guide.pages.find((p) => p.file === "README.ar.md");
  assert.ok(enIndex && arIndex, "both index pages exist");
  assert.deepEqual(
    [...docRelated(enIndex.body)].sort(),
    [...docRelated(arIndex!.body)].sort(),
    "the English and Arabic indexes must list the same pages",
  );
});

test("every Arabic page renders RTL and declares its language", () => {
  const guide = realGuide();
  for (const page of guide.pages.filter((p) => p.locale === "ar")) {
    const html = docsPageHtml(page, "Loam");
    assert.match(html, /<html lang="ar">/, `${page.file} must declare lang="ar"`);
  }
});

test("every page has a title and at least one section", () => {
  for (const page of realGuide().pages) {
    assert.ok(page.title.length > 0, `${page.file} has a # title`);
    assert.ok(page.sections.length > 0, `${page.file} has at least one section`);
  }
});

test("no page contains mojibake", () => {
  // The encoding gate rejects these sequences; the guide must satisfy it too. The pattern is
  // composed from code points so this file does not itself trip the gate's mojibake scan.
  const mojibake = new RegExp("[\\u00C2\\u00C3\\u00D8\\u00D9\\u00E2][\\u0080-\\u00BF\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E\\u0192\\u02C6\\u02DC\\u2013\\u2014\\u2018\\u2019\\u201A\\u201C\\u201D\\u201E\\u2020\\u2021\\u2022\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122]");
  for (const page of realGuide().pages) {
    assert.equal(mojibake.test(page.body), false, `${page.file} contains mojibake`);
  }
});

test("a missing page is reported as missing-file", () => {
  const problems = checkNeoDocs(fixtureGuide({ "README.md": INDEX, "canvas.md": CANVAS }));
  assert.ok(
    problems.some((p) => p.code === "missing-file" && p.file === "recipe.md"),
    "a listed file that is absent is a missing-file problem",
  );
  assert.ok(
    problems.some((p) => p.code === "missing-file" && p.file === "recipe.ar.md"),
    "the Arabic counterpart is reported too",
  );
});

test("a link to a page that is not in the guide is a broken-link", () => {
  const problems = checkNeoDocs(
    fixtureGuide({ "README.md": INDEX, "canvas.md": CANVAS, "missions.md": MISSIONS }),
  );
  const broken = problems.filter((p) => p.code === "broken-link");
  assert.ok(
    broken.some((p) => p.message.includes("nope.md")),
    "a link to a non-page is reported",
  );
});

test("a fragment that matches no heading is a broken-anchor", () => {
  const problems = checkNeoDocs(
    fixtureGuide({ "README.md": INDEX, "canvas.md": CANVAS, "missions.md": MISSIONS }),
  );
  const anchor = problems.filter((p) => p.code === "broken-anchor");
  assert.ok(
    anchor.some((p) => p.message.includes("README.md#nope")),
    "a fragment with no matching heading is reported",
  );
});

test("a related link to a non-page is a broken-related", () => {
  const body = `# Canvas\n\nRelated: [gone](gone.md)\n\n## Nodes\n\nText.\n`;
  const problems = checkNeoDocs(fixtureGuide({ "README.md": INDEX, "canvas.md": body }));
  assert.ok(
    problems.some((p) => p.code === "broken-related"),
    "the Related: line is checked, not just inline links",
  );
});

test("a page with no Related line is reported", () => {
  const problems = checkNeoDocs(
    fixtureGuide({ "README.md": INDEX, "canvas.md": "# Canvas\n\n## Nodes\n\nText.\n" }),
  );
  assert.ok(
    problems.some((p) => p.code === "missing-related" && p.file === "canvas.md"),
    "a subject page must point onward",
  );
});

test("English and Arabic drift is reported", () => {
  const problems = checkNeoDocs(
    fixtureGuide({
      "README.md": INDEX,
      "README.ar.md": INDEX,
      "canvas.md": "# Canvas\n\n## A\n\nx\n\n## B\n\ny\n",
      "canvas.ar.md": "# اللوحة\n\n## أ\n\nx\n",
    }),
  );
  assert.ok(
    problems.some((p) => p.code === "locale-drift" && p.file === "canvas.ar.md"),
    "a differing section count is locale drift",
  );
});

test("isExternalLink recognises schemes and protocol-relative URLs", () => {
  assert.equal(isExternalLink("https://example.com"), true);
  assert.equal(isExternalLink("mailto:a@b.c"), true);
  assert.equal(isExternalLink("//example.com"), true);
  assert.equal(isExternalLink("canvas.md"), false);
  assert.equal(isExternalLink("canvas.md#nodes"), false);
  assert.equal(isExternalLink("#nodes"), false);
});

test("linkPath strips the fragment and query", () => {
  assert.equal(linkPath("canvas.md#nodes"), "canvas.md");
  assert.equal(linkPath("canvas.md?a=1#nodes"), "canvas.md");
  assert.equal(linkPath("#nodes"), "");
});

test("headingAnchor lower-cases, drops punctuation and keeps Arabic", () => {
  assert.equal(headingAnchor("Budget stops are clean ends"), "budget-stops-are-clean-ends");
  assert.equal(headingAnchor("If it does not look like this"), "if-it-does-not-look-like-this");
  assert.equal(headingAnchor("ما الذي تنظر إليه"), "ما-الذي-تنظر-إليه");
  assert.equal(headingAnchor("Step 1: Why"), "step-1-why");
});

test("docLinks finds inline and reference-style links", () => {
  const body = "See [a](a.md) and [b][b].\n\n[b]: b.md\n";
  assert.deepEqual(docLinks(body), ["a.md", "b.md"]);
});

test("docFragmentLinks keeps only targets with a fragment", () => {
  const links = docFragmentLinks("See [a](a.md) and [b](b.md#part).\n");
  assert.deepEqual(links, [{ target: "b.md#part", fragment: "part" }]);
});

test("docRelated reads the English and Arabic cross-reference lines", () => {
  assert.deepEqual(docRelated("Related: [a](a.md) · [b](b.md)"), ["a.md", "b.md"]);
  assert.deepEqual(docRelated("مرتبط: [أ](أ.md)"), ["أ.md"]);
  assert.deepEqual(docRelated("no cross-reference here"), []);
});

test("docTitle reads the first level-one heading", () => {
  assert.equal(docTitle("# Canvas\n\ntext"), "Canvas");
  assert.equal(docTitle("## Only h2\n\ntext"), "");
});

test("docSections returns every heading in order", () => {
  assert.deepEqual(docSections("# T\n\n## A\n\n### B\n\ntext"), ["T", "A", "B"]);
});

test("localeOf reads the locale from the file name", () => {
  assert.equal(localeOf("canvas.md"), "en");
  assert.equal(localeOf("canvas.ar.md"), "ar");
  assert.equal(localeOf("README.ar.md"), "ar");
});

test("renderInline escapes HTML and renders code, bold, italic and links", () => {
  assert.equal(renderInline("a < b & c"), "a &lt; b &amp; c");
  assert.equal(renderInline("`code`"), "<code>code</code>");
  assert.equal(renderInline("**bold**"), "<strong>bold</strong>");
  assert.equal(renderInline("[text](a.md)"), '<a href="a.md">text</a>');
  assert.equal(renderInline("<script>"), "&lt;script&gt;");
});

test("docsHtml renders the block types the guide uses", () => {
  const html = docsHtml(
    [
      "# Title",
      "",
      "A paragraph with `code`.",
      "",
      "## Section",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "> quoted",
      "",
      "---",
      "",
      "```ts",
      "const a = 1;",
      "```",
    ].join("\n"),
  );
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<h2 id="section">Section<\/h2>/);
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>first<\/li>\n<li>second<\/li>\n<\/ol>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td>1<\/td>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<pre><code class="language-ts">const a = 1;<\/code><\/pre>/);
});

test("docsHtml escapes raw HTML instead of passing it through", () => {
  assert.match(docsHtml("<img src=x onerror=alert(1)>"), /&lt;img/);
});

test("docsPageHtml wraps a page in an RTL-aware shell", () => {
  const page: NeoDocPage = {
    file: "canvas.ar.md",
    locale: "ar",
    title: "اللوحة",
    sections: ["العقد"],
    anchors: ["العقد"],
    body: "# اللوحة\n",
    related: [],
  };
  const html = docsPageHtml(page, "دليل لُوام");
  assert.match(html, /<html lang="ar">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<title>اللوحة - دليل لُوام<\/title>/);
});
