/**
 * V7 unit tests: the design_brief agent tool.
 *
 * The tool wraps the LLM-authored brief (src/design/brief.ts) and must hand the
 * agent a payload that validates against the schema — palette 3-5 colours, at
 * most 2 fonts — with the graceful fallback and the optional token persistence.
 * Everything runs offline: the model is a fake client.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ChatMessage, ChatOptions, ChatResult, OllamaClient } from "../../ollama.js";
import type { Config } from "../../config.js";
import {
  DESIGN_BRIEF_TOOL_NAME,
  DESIGN_BRIEF_TOOL_NAMES,
  DESIGN_TOKENS_DEFAULT_PATH,
  createDesignBriefTools,
  formatDesignBriefResult,
} from "../designBrief.js";
import {
  DESIGN_BRIEF_MAX_COLORS,
  DESIGN_BRIEF_MAX_FONTS,
  DESIGN_BRIEF_MIN_COLORS,
  normalizeDesignBrief,
} from "../../design/brief.js";
import { BUILD_PHASE_PROMPT, getBuildPhase } from "../../modes/buildPhases.js";
import { mergeAlwaysOnTools } from "../../server/runTools.js";
import type { ToolContext } from "../registry.js";

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

function ctxWithWorkspace(workspace: string): ToolContext {
  return { cfg, workspace, emit: () => undefined } as unknown as ToolContext;
}

describe("design_brief tool registration", () => {
  it("exposes the tool under the expected name", () => {
    assert.equal(DESIGN_BRIEF_TOOL_NAME, "design_brief");
    assert.deepEqual(DESIGN_BRIEF_TOOL_NAMES, ["design_brief"]);
    assert.equal(createDesignBriefTools().length, 1);
    assert.equal(createDesignBriefTools()[0]!.name, DESIGN_BRIEF_TOOL_NAME);
  });

  it("is always-on and part of the build design-explore phase", () => {
    const merged = mergeAlwaysOnTools({ resolvedAllow: [], registeredTools: DESIGN_BRIEF_TOOL_NAMES });
    assert.ok(merged.includes(DESIGN_BRIEF_TOOL_NAME));
    const entry = getBuildPhase("design-explore");
    assert.ok(entry.tools.includes(DESIGN_BRIEF_TOOL_NAME));
    assert.match(BUILD_PHASE_PROMPT, /design_brief/);
  });
});

describe("design_brief run", () => {
  it("returns a model brief that validates against the schema", async () => {
    const tool = createDesignBriefTools({ ollama: fakeClient(() => JSON.stringify(VALID_BRIEF)) })[0]!;
    const result = await tool.run({ brief: "A budget dashboard for freelancers" }, ctxWithWorkspace("C:/tmp/task"));
    assert.equal(result.ok, true);
    const out = JSON.parse(result.content) as Record<string, unknown>;
    assert.equal(out["phase"], "design-brief");
    assert.equal(out["source"], "model");
    assert.equal(out["model"], "fake-model");
    const brief = out["brief"] as Record<string, unknown>;
    const palette = brief["palette"] as unknown[];
    const fonts = brief["fonts"] as unknown[];
    assert.ok(palette.length >= DESIGN_BRIEF_MIN_COLORS && palette.length <= DESIGN_BRIEF_MAX_COLORS);
    assert.ok(fonts.length <= DESIGN_BRIEF_MAX_FONTS);
    const check = normalizeDesignBrief(JSON.parse(JSON.stringify(brief)), "brief", false);
    assert.equal(check.ok, true);
  });

  it("falls back deterministically when no model client is injected", async () => {
    const tool = createDesignBriefTools()[0]!;
    const result = await tool.run({ brief: "A landing page for a coffee subscription" }, ctxWithWorkspace("C:/tmp/task"));
    assert.equal(result.ok, true);
    const out = JSON.parse(result.content) as Record<string, unknown>;
    assert.equal(out["source"], "fallback");
    const brief = out["brief"] as Record<string, unknown>;
    const check = normalizeDesignBrief(JSON.parse(JSON.stringify(brief)), "brief", (brief as { rtl: boolean }).rtl);
    assert.equal(check.ok, true);
  });

  it("writes the token map to the workspace when asked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-design-brief-"));
    try {
      const tool = createDesignBriefTools({ ollama: fakeClient(() => JSON.stringify(VALID_BRIEF)) })[0]!;
      const result = await tool.run({ brief: "A docs site for a dev tool", writeTokens: true }, ctxWithWorkspace(dir));
      assert.equal(result.ok, true);
      const out = JSON.parse(result.content) as Record<string, unknown>;
      assert.equal(out["tokensPath"], DESIGN_TOKENS_DEFAULT_PATH);
      const written = JSON.parse(fs.readFileSync(path.join(dir, DESIGN_TOKENS_DEFAULT_PATH), "utf-8")) as Record<string, unknown>;
      assert.equal(written["generatedBy"], "design_brief");
      assert.ok(Object.keys(written["tokens"] as object).length >= DESIGN_BRIEF_MIN_COLORS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write tokens by default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-design-brief-"));
    try {
      const tool = createDesignBriefTools({ ollama: fakeClient(() => JSON.stringify(VALID_BRIEF)) })[0]!;
      const result = await tool.run({ brief: "A portfolio for a photographer" }, ctxWithWorkspace(dir));
      assert.equal(result.ok, true);
      const out = JSON.parse(result.content) as Record<string, unknown>;
      assert.equal(out["tokensPath"], undefined);
      assert.equal(fs.existsSync(path.join(dir, DESIGN_TOKENS_DEFAULT_PATH)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a too-short brief", async () => {
    const tool = createDesignBriefTools({ ollama: fakeClient(() => JSON.stringify(VALID_BRIEF)) })[0]!;
    const result = await tool.run({ brief: "abc" }, ctxWithWorkspace("C:/tmp/task"));
    assert.equal(result.ok, false);
    assert.match(result.content, /at least 4 characters/);
  });
});

describe("formatDesignBriefResult", () => {
  it("includes the palette and font counts and omits tokensPath when absent", () => {
    const brief = {
      mood: "x",
      summary: "y",
      palette: [{ role: "background", hex: "#ffffff", usage: "bg" }],
      fonts: [{ role: "sans", family: "Inter", fallback: "system-ui" }],
      layout: "z",
      layoutPrinciples: ["p"],
      imageNeeds: [],
      accessibility: [],
      rtl: false,
      tokens: { "--background": "#ffffff" },
    } as unknown as import("../../design/brief.js").DesignBrief;
    const payload = JSON.parse(formatDesignBriefResult(brief, { source: "model", model: "m", warnings: [] })) as Record<string, unknown>;
    assert.equal(payload["paletteSize"], 1);
    assert.equal(payload["fontCount"], 1);
    assert.equal(payload["tokensPath"], undefined);
    assert.deepEqual(payload["warnings"], []);
  });
});
