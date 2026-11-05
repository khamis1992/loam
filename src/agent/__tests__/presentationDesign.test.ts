import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DesignBrief } from "../../design/brief.js";
import { parsePresentationDesignResult, presentationContrast, presentationPaletteFromDesign } from "../presentationDesign.js";

const brief: DesignBrief = {
  mood: "Editorial calm",
  summary: "A clear country profile",
  palette: [
    { role: "background", hex: "#F7F7F2", usage: "slide" },
    { role: "surface", hex: "#FFFFFF", usage: "cards" },
    { role: "foreground", hex: "#17231C", usage: "text" },
    { role: "muted", hex: "#66736B", usage: "secondary text" },
    { role: "primary", hex: "#007A33", usage: "accents" },
  ],
  fonts: [{ role: "sans", family: "Segoe UI", fallback: "sans-serif" }],
  layout: "Four editorial panels",
  layoutPrinciples: ["Readable Arabic hierarchy"],
  imageNeeds: [],
  accessibility: ["AA text"],
  rtl: true,
  tokens: {},
};

const fallback = { background: "#F7F7F2", surface: "#FFFFFF", ink: "#17231C", muted: "#66736B", accent: "#007A33", secondary: "#00843D", line: "#DCE3DC" };

describe("presentation design direction", () => {
  it("maps the semantic design palette and preserves readable contrast", () => {
    const palette = presentationPaletteFromDesign(brief, fallback);
    assert.equal(palette.background, "#F7F7F2");
    assert.equal(palette.accent, "#007A33");
    assert.ok(presentationContrast(palette.ink, palette.surface) >= 4.5);
    assert.ok(presentationContrast(palette.muted, palette.surface) >= 4.5);
  });

  it("repairs an unreadable model palette instead of exporting it", () => {
    const palette = presentationPaletteFromDesign({
      ...brief,
      palette: [
        { role: "background", hex: "#FFFFFF", usage: "slide" },
        { role: "surface", hex: "#FFFFFF", usage: "cards" },
        { role: "foreground", hex: "#FEFEFE", usage: "text" },
        { role: "muted", hex: "#FAFAFA", usage: "secondary" },
        { role: "primary", hex: "#FFFFFF", usage: "accent" },
      ],
    }, fallback);
    assert.equal(palette.ink, "#17231C");
    assert.notEqual(palette.muted, "#FAFAFA");
    assert.equal(palette.accent, fallback.accent);
  });

  it("parses the real tool result and preserves model usage", () => {
    const result = parsePresentationDesignResult(JSON.stringify({
      source: "model",
      model: "design-model",
      warnings: [],
      usage: { promptTokens: 12, completionTokens: 7, durationMs: 19 },
      brief,
    }));
    assert.equal(result.source, "model");
    assert.equal(result.usage.promptTokens, 12);
    assert.equal(result.brief.rtl, true);
  });
});
