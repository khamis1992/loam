/**
 * Unit tests for the LLM-authored design brief (V7).
 *
 * Everything runs offline: the model is a fake client and the deterministic
 * fallback needs no model at all. The tests pin the acceptance contract — the
 * output validates against the schema, the palette is 3-5 colours and the
 * fonts are at most 2 — plus the graceful degradation paths.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ChatMessage, ChatOptions, ChatResult, OllamaClient } from "../../ollama.js";
import type { Config } from "../../config.js";
import {
  DESIGN_BRIEF_MAX_COLORS,
  DESIGN_BRIEF_MAX_FONTS,
  DESIGN_BRIEF_MIN_COLORS,
  buildTokens,
  fallbackDesignBrief,
  generateDesignBrief,
  isRtlBrief,
  normalizeDesignBrief,
  normalizeHex,
  tokenNameFor,
  writeDesignTokens,
} from "../brief.js";

const VALID_BRIEF = {
  mood: "Calm and clear",
  summary: "A light, focused task tracker for small teams.",
  palette: [
    { role: "background", hex: "#fbfbf8", usage: "Page background." },
    { role: "foreground", hex: "#1c1d19", usage: "Body text." },
    { role: "primary", hex: "#2f6f5e", usage: "Primary actions." },
  ],
  fonts: [
    { role: "sans", family: "Inter", fallback: "system-ui, sans-serif" },
    { role: "heading", family: "Fraunces", fallback: "Georgia, serif" },
  ],
  layout: "Single column with a centered hero above the fold.",
  layoutPrinciples: ["Mobile-first single column."],
  imageNeeds: [{ role: "hero", description: "Team photo", placement: "Above the fold", alt: "A small team at work" }],
  accessibility: ["AA contrast throughout."],
  rtl: false,
  tokens: {},
};

const cfg = {
  model: "test-model",
  fallbackModel: "test-model",
  agent: { temperature: 0.2, requestTimeoutMs: 1000 },
} as unknown as Config;

function fakeClient(respond: (messages: ChatMessage[]) => string): OllamaClient {
  return {
    async chat(options: ChatOptions): Promise<ChatResult> {
      return {
        content: respond(options.messages),
        toolCalls: [],
        model: "fake-model",
        usage: { promptTokens: 10, completionTokens: 20, durationMs: 5 },
      };
    },
  } as unknown as OllamaClient;
}

function throwingClient(): OllamaClient {
  return {
    async chat(): Promise<ChatResult> {
      throw new Error("transport down");
    },
  } as unknown as OllamaClient;
}

describe("design brief schema constants", () => {
  it("bounds the palette at 3-5 colours and the fonts at 2", () => {
    assert.equal(DESIGN_BRIEF_MIN_COLORS, 3);
    assert.equal(DESIGN_BRIEF_MAX_COLORS, 5);
    assert.equal(DESIGN_BRIEF_MAX_FONTS, 2);
  });
});

describe("normalizeHex", () => {
  it("normalises shorthand and 6-digit hex to lowercase #rrggbb", () => {
    assert.equal(normalizeHex("#ABC"), "#aabbcc");
    assert.equal(normalizeHex(" #1C1D19 "), "#1c1d19");
    assert.equal(normalizeHex("nope"), null);
    assert.equal(normalizeHex(42), null);
  });
});

describe("tokenNameFor / buildTokens", () => {
  it("turns roles into custom-property names and maps them to hex", () => {
    assert.equal(tokenNameFor("Card Foreground"), "--card-foreground");
    const tokens = buildTokens([
      { role: "background", hex: "#ffffff", usage: "bg" },
      { role: "primary", hex: "#5b5bd6", usage: "actions" },
    ]);
    assert.deepEqual(tokens, { "--background": "#ffffff", "--primary": "#5b5bd6" });
  });
});

describe("normalizeDesignBrief", () => {
  it("accepts a valid brief and derives tokens from the palette", () => {
    const result = normalizeDesignBrief(JSON.parse(JSON.stringify(VALID_BRIEF)), "task tracker", false);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.brief.palette.length, 3);
    assert.equal(result.brief.fonts.length, 2);
    assert.equal(result.brief.tokens["--primary"], "#2f6f5e");
  });

  it("rejects a palette outside the 3-5 range", () => {
    for (const palette of [
      VALID_BRIEF.palette.slice(0, 2),
      [...VALID_BRIEF.palette, { role: "surface", hex: "#eee", usage: "cards" }, { role: "accent", hex: "#f00", usage: "accent" }, { role: "border", hex: "#ccc", usage: "lines" }, { role: "muted", hex: "#999", usage: "muted" }],
    ]) {
      const result = normalizeDesignBrief({ ...VALID_BRIEF, palette }, "brief", false);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.errors.join(" "), /palette must contain 3-5/);
    }
  });

  it("rejects more than two fonts", () => {
    const result = normalizeDesignBrief(
      { ...VALID_BRIEF, fonts: [...VALID_BRIEF.fonts, { role: "mono", family: "Mono", fallback: "monospace" }] },
      "brief",
      false,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(" "), /fonts must contain 1-2/);
  });

  it("rejects malformed hex and missing alt text", () => {
    const badHex = normalizeDesignBrief(
      { ...VALID_BRIEF, palette: VALID_BRIEF.palette.map((c, i) => (i === 0 ? { ...c, hex: "red" } : c)) },
      "brief",
      false,
    );
    assert.equal(badHex.ok, false);
    if (!badHex.ok) assert.match(badHex.errors.join(" "), /#rrggbb/);

    const noAlt = normalizeDesignBrief({ ...VALID_BRIEF, imageNeeds: [{ role: "hero", description: "x", placement: "y", alt: " " }] }, "brief", false);
    assert.equal(noAlt.ok, false);
    if (!noAlt.ok) assert.match(noAlt.errors.join(" "), /alt text/);
  });

  it("rejects a non-object payload", () => {
    assert.equal(normalizeDesignBrief([], "brief", false).ok, false);
    assert.equal(normalizeDesignBrief(null, "brief", false).ok, false);
  });
});

describe("isRtlBrief", () => {
  it("detects Arabic language, Arabic text and an explicit direction", () => {
    assert.equal(isRtlBrief("Build a page", "ar"), true);
    assert.equal(isRtlBrief("صفحة رئيسية", "en"), true);
    assert.equal(isRtlBrief("Build a page", "en", "rtl"), true);
    assert.equal(isRtlBrief("Build a page", "en", "ltr"), false);
    assert.equal(isRtlBrief("Build a page", "en"), false);
  });
});

describe("fallbackDesignBrief", () => {
  it("is deterministic and always schema-valid", () => {
    const a = fallbackDesignBrief("A budget dashboard for freelancers", false);
    const b = fallbackDesignBrief("A budget dashboard for freelancers", false);
    assert.deepEqual(a, b);
    const check = normalizeDesignBrief(JSON.parse(JSON.stringify(a)), "brief", false);
    assert.equal(check.ok, true);
    if (!check.ok) return;
    assert.ok(a.palette.length >= DESIGN_BRIEF_MIN_COLORS && a.palette.length <= DESIGN_BRIEF_MAX_COLORS);
    assert.ok(a.fonts.length <= DESIGN_BRIEF_MAX_FONTS);
    assert.ok(a.imageNeeds.every((image) => image.alt.length > 0));
  });

  it("switches to Arabic-capable fonts and rtl notes for Arabic content", () => {
    const brief = fallbackDesignBrief("لوحة تحكم للمستقلين", true);
    assert.equal(brief.rtl, true);
    assert.ok(brief.fonts.some((font) => font.family.includes("Arabic")));
    assert.match(brief.layout, /rtl/);
  });
});

describe("generateDesignBrief", () => {
  it("returns a validated model brief", async () => {
    const client = fakeClient(() => JSON.stringify(VALID_BRIEF));
    const result = await generateDesignBrief({ cfg, ollama: client, brief: "A budget dashboard for freelancers" });
    assert.equal(result.source, "model");
    assert.equal(result.model, "fake-model");
    assert.equal(result.brief.palette.length, 3);
    assert.equal(result.brief.fonts.length, 2);
    assert.deepEqual(result.brief.tokens["--primary"], "#2f6f5e");
  });

  it("asks the model to repair a rejected answer and accepts the second attempt", async () => {
    let call = 0;
    const client = fakeClient((messages) => {
      call += 1;
      if (call === 1) return JSON.stringify({ ...VALID_BRIEF, fonts: [...VALID_BRIEF.fonts, { role: "mono", family: "Mono", fallback: "monospace" }] });
      const user = messages[messages.length - 1]!.content;
      assert.match(user, /rejected/i);
      return JSON.stringify(VALID_BRIEF);
    });
    const result = await generateDesignBrief({ cfg, ollama: client, brief: "A pricing page for a solo SaaS" });
    assert.equal(call, 2);
    assert.equal(result.source, "model");
    assert.equal(result.brief.fonts.length, 2);
  });

  it("falls back deterministically when every model answer is invalid", async () => {
    const client = fakeClient(() => JSON.stringify({ mood: "x", summary: "y", palette: [], fonts: [], layout: "z", layoutPrinciples: [], imageNeeds: [], accessibility: [], rtl: false, tokens: {} }));
    const result = await generateDesignBrief({ cfg, ollama: client, brief: "A landing page for a coffee subscription" });
    assert.equal(result.source, "fallback");
    assert.ok(result.warnings.some((warning) => /deterministic fallback/.test(warning)));
    const check = normalizeDesignBrief(JSON.parse(JSON.stringify(result.brief)), "brief", result.brief.rtl);
    assert.equal(check.ok, true);
  });

  it("falls back when the model transport fails", async () => {
    const result = await generateDesignBrief({ cfg, ollama: throwingClient(), brief: "A docs site for a dev tool" });
    assert.equal(result.source, "fallback");
    assert.ok(result.warnings.some((warning) => /transport down/.test(warning)));
  });

  it("uses the fallback when no model client is injected", async () => {
    const result = await generateDesignBrief({ cfg, brief: "A portfolio for a photographer" });
    assert.equal(result.source, "fallback");
  });

  it("rejects a too-short brief", async () => {
    await assert.rejects(() => generateDesignBrief({ cfg, brief: "abc" }), /at least 4 characters/);
  });
});

describe("writeDesignTokens", () => {
  it("writes the token map and returns a workspace-relative path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-brief-"));
    try {
      const brief = fallbackDesignBrief("A dashboard for a logistics startup", false);
      const rel = await writeDesignTokens(dir, "design-tokens.json", brief);
      assert.equal(rel, "design-tokens.json");
      const written = JSON.parse(fs.readFileSync(path.join(dir, rel), "utf-8")) as Record<string, unknown>;
      assert.equal(written["generatedBy"], "design_brief");
      assert.deepEqual(written["tokens"], brief.tokens);
      assert.equal((written["palette"] as unknown[]).length, brief.palette.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
