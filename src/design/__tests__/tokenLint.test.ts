/**
 * V4 unit tests: the Loam UI Kit token linter.
 *
 * The acceptance contract is a fixed set of 15 source fixtures, each with an
 * expected pass/fail verdict (and, for failures, the exact set of violation
 * categories that must be reported). The fixtures exercise every rule in
 * src/design/tokenLint.ts: raw colours, palette size, font count, arbitrary
 * px, emoji icons, missing alt text and gradients.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_MAX_COLOURS,
  DEFAULT_MAX_FONTS,
  DESIGN_VIOLATION_CATEGORIES,
  formatDesignLintResult,
  isDesignLintClean,
  lintDesignSource,
  type DesignLintResult,
  type DesignViolationCategory,
} from "../tokenLint.js";

interface Fixture {
  id: string;
  name: string;
  source: string;
  /** Expected verdict. When false, `categories` lists the exact categories. */
  ok: boolean;
  categories?: DesignViolationCategory[];
}

const CLEAN_PAGE = `export function Page() {
  return (
    <main className="min-h-screen bg-background text-foreground font-sans">
      <header className="border-b border-border">
        <h1 className="text-2xl font-heading">Acme</h1>
      </header>
      <section className="mx-auto max-w-3xl space-y-6 p-6">
        <p className="text-base leading-6">A calm, focused workspace.</p>
        <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground">Get started</button>
      </section>
    </main>
  );
}`;

const FIXTURES: Fixture[] = [
  {
    id: "clean-token-page",
    name: "token-only page passes",
    source: CLEAN_PAGE,
    ok: true,
  },
  {
    id: "raw-tailwind-utility",
    name: "Tailwind white/black utilities are raw colours",
    source: `<div className="bg-white text-black">Raw utilities</div>`,
    ok: false,
    categories: ["raw-colour"],
  },
  {
    id: "inline-hex",
    name: "inline hex colour is a raw colour",
    source: `<div style={{ color: "#ff0000" }}>Red text</div>`,
    ok: false,
    categories: ["raw-colour"],
  },
  {
    id: "named-colour",
    name: "named colours in declarations are raw colours",
    source: `const styles = { background: "red", color: "white" };`,
    ok: false,
    categories: ["raw-colour"],
  },
  {
    id: "rgb-colour",
    name: "rgb() colour is a raw colour",
    source: `<div style={{ backgroundColor: "rgb(255, 0, 0)" }}>RGB</div>`,
    ok: false,
    categories: ["raw-colour"],
  },
  {
    id: "too-many-colours",
    name: "six distinct colours exceed the palette limit",
    source: [
      `<div>`,
      `  <span style={{ color: "#111111" }}>a</span>`,
      `  <span style={{ color: "#222222" }}>b</span>`,
      `  <span style={{ color: "#333333" }}>c</span>`,
      `  <span style={{ color: "#444444" }}>d</span>`,
      `  <span style={{ color: "#555555" }}>e</span>`,
      `  <span style={{ color: "#666666" }}>f</span>`,
      `</div>`,
    ].join("\n"),
    ok: false,
    categories: ["raw-colour", "too-many-colours"],
  },
  {
    id: "five-colours-within-limit",
    name: "exactly five colours stay within the palette limit",
    source: [
      `<div>`,
      `  <span style={{ color: "#111111" }}>a</span>`,
      `  <span style={{ color: "#222222" }}>b</span>`,
      `  <span style={{ color: "#333333" }}>c</span>`,
      `  <span style={{ color: "#444444" }}>d</span>`,
      `  <span style={{ color: "#555555" }}>e</span>`,
      `</div>`,
    ].join("\n"),
    ok: false,
    categories: ["raw-colour"],
  },
  {
    id: "too-many-fonts",
    name: "three font families exceed the two-family limit",
    source: [
      `const a = { fontFamily: "Inter, sans-serif" };`,
      `const b = { fontFamily: "Playfair Display, serif" };`,
      `const c = { fontFamily: "JetBrains Mono, monospace" };`,
    ].join("\n"),
    ok: false,
    categories: ["too-many-fonts"],
  },
  {
    id: "two-fonts-ok",
    name: "two font families pass",
    source: `<section className="font-sans"><h1 className="font-heading">Title</h1></section>`,
    ok: true,
  },
  {
    id: "arbitrary-px-text",
    name: "arbitrary text-[13px] is flagged",
    source: `<p className="text-[13px]">Tight copy</p>`,
    ok: false,
    categories: ["arbitrary-px"],
  },
  {
    id: "arbitrary-px-width",
    name: "arbitrary w-[137px] is flagged",
    source: `<div className="w-[137px]">Fixed width</div>`,
    ok: false,
    categories: ["arbitrary-px"],
  },
  {
    id: "emoji-icon",
    name: "emoji used as an icon is flagged",
    source: `<button type="button">🚀 Launch</button>`,
    ok: false,
    categories: ["emoji-icon"],
  },
  {
    id: "img-missing-alt",
    name: "img without alt text is flagged",
    source: `<img src="/hero.png" />`,
    ok: false,
    categories: ["missing-alt"],
  },
  {
    id: "img-with-alt",
    name: "img with alt text passes",
    source: `<img src="/hero.png" alt="Hero illustration" />`,
    ok: true,
  },
  {
    id: "gradient",
    name: "decorative gradient is flagged",
    source: `<div className="bg-gradient-to-r from-primary to-accent">Gradient</div>`,
    ok: false,
    categories: ["gradient"],
  },
];

describe("tokenLint: 15 fixture cases", () => {
  it("declares exactly 15 fixtures", () => {
    assert.equal(FIXTURES.length, 15);
    assert.equal(new Set(FIXTURES.map((f) => f.id)).size, 15);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.id}: ${fixture.name}`, () => {
      const result = lintDesignSource(fixture.source);
      assert.equal(result.ok, fixture.ok, `verdict mismatch: ${formatDesignLintResult(result)}`);

      if (fixture.ok) {
        assert.deepEqual(result.violations, []);
        assert.equal(result.summary.counts["raw-colour"], 0);
        return;
      }

      const expected = new Set(fixture.categories ?? []);
      assert.ok(expected.size > 0, `fixture ${fixture.id} must declare expected categories`);
      const actual = new Set(result.violations.map((v) => v.category));
      assert.deepEqual(
        [...actual].sort(),
        [...expected].sort(),
        `category mismatch for ${fixture.id}: ${formatDesignLintResult(result)}`,
      );
    });
  }
});

describe("tokenLint: coordinates and reporting", () => {
  it("reports 1-based line and column for a raw colour", () => {
    const source = `const a = 1;\nconst b = { color: "#ff0000" };\n`;
    const result = lintDesignSource(source);
    const violation = result.violations.find((v) => v.category === "raw-colour");
    assert.ok(violation, "expected a raw-colour violation");
    assert.equal(violation!.line, 2);
    assert.ok(violation!.column > 0);
    assert.match(violation!.snippet, /#ff0000/);
  });

  it("formats a clean result and a failing result", () => {
    assert.match(formatDesignLintResult(lintDesignSource(CLEAN_PAGE)), /^design lint: OK/);
    const failing = lintDesignSource(`<img src="/x.png" />`);
    assert.match(formatDesignLintResult(failing), /missing-alt/);
  });

  it("exposes isDesignLintClean as the negation of violations", () => {
    assert.equal(isDesignLintClean(CLEAN_PAGE), true);
    assert.equal(isDesignLintClean(`<img src="/x.png" />`), false);
  });

  it("reports colour and font counts in the summary", () => {
    const result = lintDesignSource(FIXTURES.find((f) => f.id === "too-many-colours")!.source);
    assert.equal(result.summary.colours, 6);
    const fonts = lintDesignSource(FIXTURES.find((f) => f.id === "too-many-fonts")!.source);
    assert.equal(fonts.summary.fonts, 3);
  });
});

describe("tokenLint: options", () => {
  it("honours maxColours and maxFonts overrides", () => {
    const six = FIXTURES.find((f) => f.id === "too-many-colours")!.source;
    assert.equal(lintDesignSource(six, { maxColours: 10 }).ok, false); // still raw colours
    assert.equal(lintDesignSource(six, { maxColours: 10 }).violations.some((v) => v.category === "too-many-colours"), false);
    const twoFonts = FIXTURES.find((f) => f.id === "two-fonts-ok")!.source;
    assert.equal(lintDesignSource(twoFonts, { maxFonts: 1 }).violations.some((v) => v.category === "too-many-fonts"), true);
  });

  it("allows explicitly permitted colours", () => {
    const source = `<div style={{ color: "#ff0000" }}>Permitted</div>`;
    const result = lintDesignSource(source, { allowedColours: ["#ff0000"] });
    assert.equal(result.violations.some((v) => v.category === "raw-colour"), false);
  });

  it("skips disabled rules", () => {
    const source = `<img src="/x.png" />`;
    assert.equal(lintDesignSource(source, { disabled: ["missing-alt"] }).ok, true);
  });

  it("ignores CSS custom-property token definitions by default", () => {
    const tokens = `:root {\n  --primary: #6366f1;\n  --background: #ffffff;\n}`;
    const result = lintDesignSource(tokens);
    assert.equal(result.violations.some((v) => v.category === "raw-colour"), false);
    assert.equal(result.summary.colours, 0);
  });

  it("counts token definitions when ignoreTokenDefinitions is false", () => {
    const tokens = `:root {\n  --primary: #6366f1;\n}`;
    const result = lintDesignSource(tokens, { ignoreTokenDefinitions: false });
    assert.equal(result.summary.colours, 1);
  });

  it("exposes the documented defaults", () => {
    assert.equal(DEFAULT_MAX_COLOURS, 5);
    assert.equal(DEFAULT_MAX_FONTS, 2);
    assert.deepEqual(DESIGN_VIOLATION_CATEGORIES.slice().sort(), [
      "arbitrary-px",
      "emoji-icon",
      "gradient",
      "missing-alt",
      "raw-colour",
      "rtl-direction",
      "rtl-logical-properties",
      "too-many-colours",
      "too-many-fonts",
    ]);
  });

  it("returns a stable result shape", () => {
    const result: DesignLintResult = lintDesignSource(CLEAN_PAGE);
    assert.equal(typeof result.source, "string");
    assert.equal(Array.isArray(result.violations), true);
    assert.equal(typeof result.summary.counts, "object");
  });
});

describe("tokenLint: RTL and logical properties", () => {
  it("flags Arabic content with no dir=rtl", () => {
    const source = `<div className="text-sm">مرحبا بالعالم</div>`;
    const result = lintDesignSource(source);
    assert.equal(result.ok, false, formatDesignLintResult(result));
    assert.equal(
      result.violations.some((v) => v.category === "rtl-direction"),
      true,
    );
  });

  it("accepts Arabic content when the root declares dir=rtl", () => {
    const source = `<div dir="rtl" lang="ar" className="text-sm">مرحبا بالعالم</div>`;
    assert.equal(isDesignLintClean(source), true, formatDesignLintResult(lintDesignSource(source)));
  });

  it("flags physical directional classes under an RTL layout", () => {
    const source = `<div dir="rtl"><span className="ml-4">x</span><span className="text-left">y</span></div>`;
    const result = lintDesignSource(source);
    const categories = new Set(result.violations.map((v) => v.category));
    assert.equal(categories.has("rtl-logical-properties"), true, formatDesignLintResult(result));
  });

  it("flags physical directional properties in inline styles under RTL", () => {
    const source = `<div dir="rtl"><span style={{ paddingLeft: "16px" }}>x</span></div>`;
    const result = lintDesignSource(source);
    assert.equal(
      result.violations.some((v) => v.category === "rtl-logical-properties"),
      true,
      formatDesignLintResult(result),
    );
  });

  it("ignores physical directional properties on a left-to-right layout", () => {
    const source = `<div className="ml-4 text-left">Aligned</div>`;
    assert.equal(isDesignLintClean(source), true, formatDesignLintResult(lintDesignSource(source)));
  });

  it("accepts logical property equivalents under RTL", () => {
    const source = `<div dir="rtl"><span className="ms-4 text-start">x</span></div>`;
    const result = lintDesignSource(source);
    assert.equal(result.violations.some((v) => v.category === "rtl-logical-properties"), false);
  });

  it("reports RTL violations with usable coordinates", () => {
    const source = `<div dir="rtl">\n  <span className="ml-4">x</span>\n</div>`;
    const result = lintDesignSource(source);
    const violation = result.violations.find((v) => v.category === "rtl-logical-properties");
    assert.ok(violation, "expected an rtl-logical-properties violation");
    assert.equal(violation!.line, 2);
    assert.ok(violation!.column > 0);
    assert.match(violation!.snippet, /ml-4/);
  });
});

describe("tokenLint: edge cases", () => {
  it("treats token references as compliant, not raw colours", () => {
    const source = `<div className="bg-[var(--primary)] text-[color:var(--fg)]">Tokens</div>`;
    assert.equal(isDesignLintClean(source), true, formatDesignLintResult(lintDesignSource(source)));
  });

  it("flags colour utilities with arbitrary literal values", () => {
    const source = `<div className="bg-[#ff0000]">Red</div>`;
    const result = lintDesignSource(source);
    assert.equal(result.violations.some((v) => v.category === "raw-colour"), true);
  });

  it("flags palette shade utilities such as bg-slate-500", () => {
    const source = `<div className="bg-slate-500">Shade</div>`;
    const result = lintDesignSource(source);
    assert.equal(result.violations.some((v) => v.category === "raw-colour"), true);
  });

  it("handles empty and whitespace-only sources", () => {
    assert.equal(isDesignLintClean(""), true);
    assert.equal(isDesignLintClean("   \n\t  "), true);
  });

  it("counts distinct colours rather than raw occurrences", () => {
    const source = `<div><span style={{ color: "#ff0000" }}>a</span><span style={{ color: "#ff0000" }}>b</span></div>`;
    assert.equal(lintDesignSource(source).summary.colours, 1);
  });

  it("deduplicates a repeated font family", () => {
    const source = `const a = { fontFamily: "Inter" };\nconst b = { fontFamily: "Inter" };`;
    assert.equal(lintDesignSource(source).summary.fonts, 1);
  });

  it("supports colour and font overrides together", () => {
    const source = `<div className="font-sans font-heading font-mono">x</div>`;
    const relaxed = lintDesignSource(source, { maxFonts: 3 });
    assert.equal(relaxed.violations.some((v) => v.category === "too-many-fonts"), false);
    const strict = lintDesignSource(source, { maxFonts: 1 });
    assert.equal(strict.violations.some((v) => v.category === "too-many-fonts"), true);
  });

  it("respects an allow-list for Tailwind colour utilities", () => {
    const source = `<div className="bg-white">White</div>`;
    const result = lintDesignSource(source, { allowedColours: ["bg-white"] });
    assert.equal(result.violations.some((v) => v.category === "raw-colour"), false);
  });

  it("keeps token-definition colours out of the palette by default", () => {
    const tokens = `:root {\n  --primary: #6366f1;\n  --surface: #f8fafc;\n  --ring: #94a3b8;\n  --muted: #64748b;\n  --accent: #0ea5e9;\n  --danger: #ef4444;\n}`;
    const result = lintDesignSource(tokens);
    assert.equal(result.summary.colours, 0);
    assert.equal(result.ok, true, formatDesignLintResult(result));
  });

  it("flags oklch literals outside token definitions", () => {
    const source = `<div style={{ color: "oklch(0.5 0.1 240)" }}>x</div>`;
    const result = lintDesignSource(source);
    assert.equal(result.violations.some((v) => v.category === "raw-colour"), true);
  });

  it("flags gradients declared in plain CSS", () => {
    const source = `.hero { background: linear-gradient(to right, #111, #222); }`;
    const result = lintDesignSource(source);
    assert.equal(result.violations.some((v) => v.category === "gradient"), true);
  });

  it("flags emoji on buttons and links", () => {
    const result = lintDesignSource(`<a href="/home">🏠</a><button>✨</button>`);
    assert.equal(result.violations.filter((v) => v.category === "emoji-icon").length, 2);
  });

  it("treats alt=\"\" as present for decorative images", () => {
    assert.equal(isDesignLintClean(`<img src="/dot.png" alt="" />`), true);
  });

  it("is deterministic across repeated calls", () => {
    const source = `<div className="bg-slate-500 text-[13px]">🚀</div>`;
    assert.deepEqual(lintDesignSource(source), lintDesignSource(source));
  });
});
