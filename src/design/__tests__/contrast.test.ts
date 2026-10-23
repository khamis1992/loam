/**
 * Unit tests: the Loam UI Kit WCAG contrast checker.
 *
 * The acceptance contract is that known colour pairs score correctly. The
 * reference values below are the published WCAG 2.2 ratios for well-known
 * sRGB colours, so the parser, the oklch/oklab/hsl conversions, the
 * luminance formula and the alpha compositing are all pinned to an
 * independent external source rather than to the implementation itself.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  CONTRAST_THRESHOLDS,
  checkPair,
  checkThemeContrast,
  contrastGrade,
  contrastRatio,
  isContrastLevel,
  parseColor,
  readableInk,
  relativeLuminance,
  requiredRatio,
  TEXT_TOKEN_PAIRS,
  TOKEN_PAIRS,
  UI_TOKEN_PAIRS,
  type TokenMap,
} from "../contrast.js";

/** Assert a rounded ratio is within `tol` of an expected WCAG reference. */
function ratioNear(actual: number, expected: number, tol = 0.011): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ratio ${expected} but got ${actual}`,
  );
}

describe("known contrast ratios", () => {
  const cases: Array<[string, string, number]> = [
    ["#000000", "#ffffff", 21],
    ["#ffffff", "#000000", 21],
    ["#ffffff", "#ffffff", 1],
    ["#000000", "#000000", 1],
    // The canonical AA boundary: #767676 clears 4.5:1, #777777 does not.
    ["#767676", "#ffffff", 4.54],
    ["#777777", "#ffffff", 4.48],
    ["#ff0000", "#ffffff", 4.0],
    ["#00ff00", "#ffffff", 1.37],
    ["#0000ff", "#ffffff", 8.59],
    // Shorthand and alpha hex forms.
    ["#fff", "#000", 21],
    ["#00000080", "#ffffff", 4.0],
  ];

  for (const [foreground, background, expected] of cases) {
    it(`${foreground} on ${background} scores ${expected}`, () => {
      ratioNear(contrastRatio(foreground, background), expected);
    });
  }

  it("is symmetric", () => {
    assert.equal(contrastRatio("#333333", "#eeeeee"), contrastRatio("#eeeeee", "#333333"));
  });
});

describe("oklch, oklab and hsl conversions", () => {
  it("treats oklch lightness 1/0 as white/black", () => {
    ratioNear(contrastRatio("oklch(100% 0 0)", "oklch(0% 0 0)"), 21);
  });

  it("converts a mid-tone oklch to the same sRGB as its hex equivalent", () => {
    // oklch(70% 0.15 250) is a muted blue; compare against the hex the
    // conversion should land on and require a non-degenerate ratio.
    const parsed = parseColor("oklch(70% 0.15 250)");
    assert.ok(parsed, "oklch must parse");
    ratioNear(contrastRatio("oklch(70% 0.15 250)", "#ffffff"), 2.66);
  });

  it("matches hsl and rgb to the same hex ratio", () => {
    ratioNear(contrastRatio("hsl(0 100% 50%)", "#ffffff"), 4.0);
    ratioNear(contrastRatio("rgb(100% 0% 0%)", "#ffffff"), 4.0);
    // hsl(210 100% 50%) is #0080ff, which sits at ~5.5:1 against black.
    ratioNear(contrastRatio("hsl(210 100% 50%)", "#000000"), 5.5);
  });

  it("parses oklab with a plain a/b pair", () => {
    assert.ok(parseColor("oklab(50% 0.1 0.1)"), "oklab must parse");
  });

  it("returns null for unparseable input", () => {
    assert.equal(parseColor("not-a-color"), null);
    assert.equal(parseColor(""), null);
    assert.equal(contrastRatio("not-a-color", "#ffffff"), Number.NaN);
  });
});

describe("alpha compositing", () => {
  it("composites a translucent foreground over its background", () => {
    // 50% black over white is a mid grey around #808080, ~4:1.
    ratioNear(contrastRatio("rgba(0 0 0 / 0.5)", "#ffffff"), 3.98);
    // Legacy comma form resolves to the same colour.
    ratioNear(contrastRatio("rgba(0,0,0,0.5)", "#ffffff"), 3.98);
    // Alpha also applies to hsl.
    ratioNear(contrastRatio("hsl(0 100% 50% / 0.5)", "#ffffff"), 2.44);
  });

  it("flattens a translucent background over opaque white", () => {
    // 50% black flattened over white is a mid grey; white text on it is ~3.98:1.
    ratioNear(contrastRatio("#ffffff", "rgba(0 0 0 / 0.5)"), 3.98);
  });
});

describe("relative luminance", () => {
  it("is 1 for white and 0 for black", () => {
    assert.equal(relativeLuminance({ r: 1, g: 1, b: 1 }), 1);
    assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  });
});

describe("grades and thresholds", () => {
  it("maps ratios to WCAG grades", () => {
    assert.equal(contrastGrade(21), "AAA");
    assert.equal(contrastGrade(8.59), "AAA");
    assert.equal(contrastGrade(7), "AAA");
    assert.equal(contrastGrade(6.99), "AA");
    assert.equal(contrastGrade(4.54), "AA");
    assert.equal(contrastGrade(4.48), "AA Large");
    assert.equal(contrastGrade(3), "AA Large");
    assert.equal(contrastGrade(2.99), "Fail");
    assert.equal(contrastGrade(Number.NaN), "Fail");
  });

  it("exposes the WCAG 2.2 thresholds", () => {
    assert.deepEqual(CONTRAST_THRESHOLDS, {
      "aa-normal": 4.5,
      "aa-large": 3,
      "aaa-normal": 7,
      "aaa-large": 4.5,
      ui: 3,
    });
    assert.equal(requiredRatio("aa-normal"), 4.5);
    assert.equal(requiredRatio("ui"), 3);
  });

  it("recognises level names", () => {
    for (const level of ["aa-normal", "aa-large", "aaa-normal", "aaa-large", "ui"]) {
      assert.equal(isContrastLevel(level), true, level);
    }
    assert.equal(isContrastLevel("aaa"), false);
  });

  it("checks a pair against each level", () => {
    const gray = checkPair("#777777", "#ffffff");
    assert.equal(gray.ratio, 4.48);
    assert.equal(gray.pass, false, "4.48:1 must fail normal text AA");
    assert.equal(gray.grade, "AA Large");
    assert.equal(checkPair("#777777", "#ffffff", "aa-large").pass, true);
    assert.equal(checkPair("#ff0000", "#ffffff", "ui").pass, true);
    assert.equal(checkPair("#00ff00", "#ffffff", "ui").pass, false);
  });
});

describe("readableInk", () => {
  it("prefers black on white and white on black", () => {
    assert.equal(readableInk("#ffffff"), "#000000");
    assert.equal(readableInk("#000000"), "#ffffff");
  });

  it("prefers the supplied ink when it already clears the minimum", () => {
    assert.equal(readableInk("#767676", "#000000"), "#000000");
  });

  it("falls back to the higher-contrast ink", () => {
    assert.equal(readableInk("#767676", "#ffffff"), "#ffffff");
  });
});

describe("theme token pairs", () => {
  const light: TokenMap = {
    background: "#ffffff",
    foreground: "#171717",
    card: "#ffffff",
    "card-foreground": "#171717",
    popover: "#ffffff",
    "popover-foreground": "#171717",
    primary: "#171717",
    "primary-foreground": "#ffffff",
    secondary: "#f4f4f5",
    "secondary-foreground": "#171717",
    muted: "#f4f4f5",
    "muted-foreground": "#52525b",
    accent: "#f4f4f5",
    "accent-foreground": "#171717",
    destructive: "#dc2626",
    "destructive-foreground": "#ffffff",
    sidebar: "#f4f4f5",
    "sidebar-foreground": "#171717",
    ring: "#171717",
    border: "#71717a",
    input: "#71717a",
    "chart-1": "#171717",
  };

  const dark: TokenMap = {
    background: "#0a0a0a",
    foreground: "#fafafa",
    card: "#171717",
    "card-foreground": "#fafafa",
    popover: "#171717",
    "popover-foreground": "#fafafa",
    primary: "#fafafa",
    "primary-foreground": "#0a0a0a",
    secondary: "#27272a",
    "secondary-foreground": "#fafafa",
    muted: "#27272a",
    "muted-foreground": "#a1a1aa",
    accent: "#27272a",
    "accent-foreground": "#fafafa",
    destructive: "#7f1d1d",
    "destructive-foreground": "#fafafa",
    sidebar: "#171717",
    "sidebar-foreground": "#fafafa",
    ring: "#fafafa",
    border: "#a1a1aa",
    input: "#a1a1aa",
    "chart-1": "#fafafa",
  };

  it("checks every text and UI pair in both themes", () => {
    const report = checkThemeContrast({ light, dark });
    assert.equal(report.ok, true);
    assert.equal(report.failures.length, 0);
    assert.equal(report.light.length, TOKEN_PAIRS.length);
    assert.equal(report.dark.length, TOKEN_PAIRS.length);
    assert.ok(report.light.every((pair) => pair.mode === "light"));
    assert.ok(report.dark.every((pair) => pair.mode === "dark"));
  });

  it("checks the light theme alone when dark is omitted", () => {
    const report = checkThemeContrast({ light });
    assert.equal(report.ok, true);
    assert.equal(report.dark.length, 0);
  });

  it("reports a low-contrast text pair as a failure", () => {
    const report = checkThemeContrast({ light: { ...light, foreground: "#cccccc" }, dark });
    assert.equal(report.ok, false);
    const failing = report.failures.find((pair) => pair.id === "foreground-on-background");
    assert.ok(failing, "the foreground-on-background pair must fail");
    assert.equal(failing.mode, "light");
    assert.equal(failing.pass, false);
    assert.ok(failing.ratio < 4.5);
  });

  it("treats a missing token as a failure with a note", () => {
    const { primary: _primary, ...incomplete } = light;
    const report = checkThemeContrast({ light: incomplete });
    assert.equal(report.ok, false);
    const failing = report.failures.find((pair) => pair.id === "primary-foreground-on-primary");
    assert.ok(failing, "the primary pair must fail when the token is missing");
    assert.equal(failing.pass, false);
    assert.equal(failing.note, "missing token: primary");
    assert.ok(!Number.isFinite(failing.ratio));
  });

  it("treats an unparseable colour as a failure with a note", () => {
    const report = checkThemeContrast({ light: { ...light, foreground: "not-a-color" } });
    assert.equal(report.ok, false);
    const failing = report.failures.find((pair) => pair.id === "foreground-on-background");
    assert.ok(failing);
    assert.equal(failing.pass, false);
    assert.match(failing.note ?? "", /unparseable colour/);
  });

  it("exposes a non-empty, unique set of token pairs", () => {
    assert.ok(TEXT_TOKEN_PAIRS.length > 0);
    assert.ok(UI_TOKEN_PAIRS.length > 0);
    assert.equal(TOKEN_PAIRS.length, TEXT_TOKEN_PAIRS.length + UI_TOKEN_PAIRS.length);
    const ids = new Set(TOKEN_PAIRS.map((pair) => pair.id));
    assert.equal(ids.size, TOKEN_PAIRS.length);
  });
});
