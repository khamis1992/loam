/**
 * V11 tool-layer tests: `design_critique`.
 *
 * The tool is the model-facing surface of the vision rubric. These tests drive it
 * end to end with an injected fake vision client (no network, no preview server):
 * the mock model returns a low score and a fix, the tool reports the revise
 * verdict and the fix instruction, the caller applies the fix and calls again,
 * and the second call is accepted. They also pin the honest failure modes: an
 * unusable answer, the round budget, and the always-on + prompt wiring.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ChatOptions, ChatResult, OllamaClient } from "../../ollama.js";
import type { Config } from "../../config.js";
import type { Emit } from "../../agent/events.js";
import type { Tool, ToolContext } from "../registry.js";
import type { PreviewService } from "../../preview/serve.js";
import { CRITIQUE_DIMENSION_IDS, CRITIQUE_PASS_THRESHOLD } from "../../design/critique.js";
import { createDesignCritiqueTools, DESIGN_CRITIQUE_TOOL_NAME, DESIGN_CRITIQUE_TOOL_NAMES } from "../designCritique.js";

let tmpDir = "";
let shotDir = "";

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-design-critique-"));
  shotDir = path.join(tmpDir, ".preview-shots");
  fs.mkdirSync(shotDir, { recursive: true });
  for (const name of ["mobile.png", "tablet.png", "desktop.png"]) {
    fs.writeFileSync(path.join(shotDir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]), "binary");
  }
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const cfg = {
  workspace: tmpDir,
  model: "llama3.2-vision",
  vision: { enabled: true, maxImagesPerStep: 3, model: "llama3.2-vision" },
  policy: { networkEnabled: false, allowOutsideWorkspaceRead: false },
} as unknown as Config;

function ctx(): ToolContext {
  return { cfg, workspace: tmpDir, emit: (() => undefined) as Emit };
}

/** The preview service is never started: every test passes explicit screenshots. */
function stubPreview(): PreviewService {
  return {
    get status() {
      return { running: false, url: null, root: null, requests: 0, startedAt: null };
    },
  } as unknown as PreviewService;
}

/** A model that answers with the given payloads, one per call. */
function fakeOllama(payloads: unknown[]): { client: OllamaClient; calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  let index = 0;
  const client = {
    async chat(options: ChatOptions): Promise<ChatResult> {
      calls.push(options);
      const payload = payloads[Math.min(index, payloads.length - 1)];
      index += 1;
      return {
        content: JSON.stringify(payload),
        toolCalls: [],
        model: options.model,
        usage: { promptTokens: 10, completionTokens: 5, durationMs: 42 },
      };
    },
  } as unknown as OllamaClient;
  return { client, calls };
}

function dimensions(overrides: Partial<Record<string, number>> = {}): Array<{ id: string; score: number; note: string }> {
  return CRITIQUE_DIMENSION_IDS.map((id) => ({
    id,
    score: overrides[id] ?? (id === "rtl" ? 100 : 92),
    note: `${id} note`,
  }));
}

function critiqueTool(client: OllamaClient): Tool {
  const tool = createDesignCritiqueTools(stubPreview(), { ollama: client }).find((t) => t.name === DESIGN_CRITIQUE_TOOL_NAME);
  assert.ok(tool, "design_critique must be registered by the factory");
  return tool;
}

const SCREENSHOTS = [".preview-shots/mobile.png", ".preview-shots/tablet.png", ".preview-shots/desktop.png"];

const SOURCE = [
  '<html lang="en">',
  "  <body>",
  '    <h1 class="text-2xl font-semibold">Ship faster</h1>',
  '    <p class="mt-4 text-muted-foreground">A calm, token-driven landing page.</p>',
  "  </body>",
  "</html>",
].join("\n");

describe("design_critique tool", () => {
  it("exposes one tool with the declared name", () => {
    assert.deepEqual(DESIGN_CRITIQUE_TOOL_NAMES, ["design_critique"]);
    const names = createDesignCritiqueTools(stubPreview(), { ollama: fakeOllama([]).client }).map((t) => t.name);
    assert.deepEqual(names, DESIGN_CRITIQUE_TOOL_NAMES);
  });

  it("drives a fix round: revise with the fix, then accept after the caller applies it", async () => {
    const { client, calls } = fakeOllama([
      {
        verdict: "revise",
        score: 70,
        dimensions: dimensions({ contrast: 45 }),
        issues: ["body text sits too light against the card"],
        fixes: ["raise the body text contrast to at least 4.5:1"],
      },
      {
        verdict: "accept",
        score: 92,
        dimensions: dimensions(),
        issues: [],
        fixes: [],
      },
    ]);
    const tool = critiqueTool(client);

    const first = await tool.run(
      { screenshots: SCREENSHOTS, source: SOURCE, prompt: "Build a landing page for a shipping product", round: 1, maxRounds: 2 },
      ctx(),
    );
    assert.equal(first.ok, false, "a revise verdict is not an acceptance");
    assert.match(first.content, /design_critique: revise/);
    assert.match(first.content, /raise the body text contrast/);
    assert.match(first.content, /round 1\/2/);
    assert.match(first.content, /source: model/);
    assert.match(first.content, /Text contrast/);
    assert.match(first.content, /screenshots judged: 3/);
    assert.match(first.content, /round=2/, "the report must say how to continue the loop");

    const second = await tool.run(
      { screenshots: SCREENSHOTS, source: SOURCE, prompt: "Build a landing page for a shipping product", round: 2, maxRounds: 2 },
      ctx(),
    );
    assert.equal(second.ok, true);
    assert.match(second.content, /design_critique: accept/);
    // Six dimensions at 92 plus rtl at 100 (mandatory on an ltr page) mean 93.
    assert.match(second.content, /score 93\/100/);

    assert.equal(calls.length, 2, "one model call per critique round");
    // The screenshots really were attached as base64 images on both rounds.
    for (const call of calls) {
      const images = call.messages.filter((message) => (message.images?.length ?? 0) > 0);
      assert.equal(images.length, SCREENSHOTS.length);
    }
  });

  it("stops asking for fixes once the round budget is spent", async () => {
    const { client } = fakeOllama([
      {
        verdict: "revise",
        score: 64,
        dimensions: dimensions({ overflow: 40 }),
        issues: ["the pricing table scrolls sideways at 375"],
        fixes: ["cap the table width and let cells wrap"],
      },
    ]);
    const tool = critiqueTool(client);

    const last = await tool.run({ screenshots: SCREENSHOTS, source: SOURCE, round: 2, maxRounds: 2 }, ctx());
    assert.equal(last.ok, false);
    assert.match(last.content, /round budget exhausted \(2\/2\)/);
    assert.doesNotMatch(last.content, /call design_critique with round=3/);
    assert.match(last.content, /cap the table width/, "the fix must still be reported");
  });

  it("honours a custom acceptance bar", async () => {
    // Six dimensions at 82 plus rtl at 100 mean 85: above the default 80 bar and
    // below a strict 90 one, so the same verdict flips with the threshold alone.
    const { client } = fakeOllama([
      {
        verdict: "accept",
        score: 85,
        dimensions: dimensions({ hierarchy: 82, spacing: 82, contrast: 82, alignment: 82, "color-count": 82, overflow: 82 }),
        issues: [],
        fixes: [],
      },
    ]);
    const tool = critiqueTool(client);

    const strict = await tool.run({ screenshots: SCREENSHOTS, source: SOURCE, threshold: 90, round: 1, maxRounds: 2 }, ctx());
    assert.equal(strict.ok, false);
    assert.match(strict.content, /bar 90/);
    assert.match(strict.content, /design_critique: revise/, "a high-scoring accept below a strict bar is still a revise");

    const lenient = await tool.run({ screenshots: SCREENSHOTS, source: SOURCE, threshold: 80, round: 1, maxRounds: 2 }, ctx());
    assert.equal(lenient.ok, true, "85 clears an 80 bar");
    assert.match(lenient.content, /bar 80/);
  });

  it("never turns an unusable model answer into a pass", async () => {
    const client = {
      async chat(options: ChatOptions): Promise<ChatResult> {
        return { content: "the page looks nice to me", toolCalls: [], model: options.model, usage: { promptTokens: 3, completionTokens: 2, durationMs: 5 } };
      },
    } as unknown as OllamaClient;
    const tool = critiqueTool(client);

    const result = await tool.run({ screenshots: SCREENSHOTS, source: SOURCE, round: 1, maxRounds: 2 }, ctx());
    assert.equal(result.ok, false);
    assert.match(result.content, /design_critique: invalid/);
    assert.match(result.content, /unusable/);
    assert.doesNotMatch(result.content, /design_critique: accept/);
  });

  it("refuses to judge when no screenshot can be read", async () => {
    const tool = critiqueTool(fakeOllama([{}]).client);
    const result = await tool.run({ screenshots: [".preview-shots/missing.png"] }, ctx());
    assert.equal(result.ok, false);
    assert.match(result.content, /no screenshots to judge/);
  });

  it("reports the deterministic fallback when no vision client is injected", async () => {
    const tool = createDesignCritiqueTools(stubPreview()).find((t) => t.name === DESIGN_CRITIQUE_TOOL_NAME)!;
    const result = await tool.run({ screenshots: SCREENSHOTS, source: SOURCE, prompt: "Build a landing page" }, ctx());
    assert.equal(result.ok, true, "the fallback accepts a clean source");
    assert.match(result.content, /source: fallback/);
    assert.match(result.content, /token lint: 100\/100/);
    assert.match(result.content, /bar 80/);
  });

  it("gates an Arabic page on RTL readiness even without a vision client", async () => {
    const tool = createDesignCritiqueTools(stubPreview()).find((t) => t.name === DESIGN_CRITIQUE_TOOL_NAME)!;
    const { lintSiteSource } = await import("../../design/tokenLint.js");
    const arabic = [
      '<html lang="ar">',
      '  <body><p class="mt-4 text-foreground">مرحبا بكم في لوام</p></body>',
      "</html>",
    ].join("\n");
    const result = await tool.run({ screenshots: SCREENSHOTS, source: arabic, language: "ar" }, ctx());
    assert.equal(result.ok, false);
    assert.match(result.content, /design_critique: revise/);
    assert.match(result.content, /not RTL-ready/);
    assert.match(result.content, /dir="rtl"/);

    // Arabic content is recognised as RTL content, and the corrected page (with
    // dir="rtl" and logical properties) is accepted with the Arabic copy intact.
    assert.equal(lintSiteSource(arabic, { locale: "ar" }).metrics.rtlReady, false);
    const fixed = [
      '<html dir="rtl" lang="ar">',
      '  <body><p class="ms-4 text-foreground">مرحبا بكم في لوام</p></body>',
      "</html>",
    ].join("\n");
    assert.equal(lintSiteSource(fixed, { locale: "ar" }).metrics.rtlReady, true);
    const accepted = await tool.run({ screenshots: SCREENSHOTS, source: fixed, language: "ar" }, ctx());
    assert.equal(accepted.ok, true);
    assert.match(accepted.content, /design_critique: accept/);
  });

  it("returns machine-readable JSON on request", async () => {
    const { client } = fakeOllama([
      { verdict: "accept", score: 91, dimensions: dimensions(), issues: [], fixes: [] },
    ]);
    const tool = critiqueTool(client);
    const result = await tool.run({ screenshots: SCREENSHOTS, source: SOURCE, format: "json", round: 1, maxRounds: 2 }, ctx());
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    assert.equal(payload["verdict"], "accept");
    assert.equal(payload["lintScore"], 100);
    assert.equal(payload["round"], 1);
    assert.equal(payload["maxRounds"], 2);
    assert.deepEqual(payload["screenshots"], SCREENSHOTS);
    assert.equal((payload["dimensions"] as unknown[]).length, CRITIQUE_DIMENSION_IDS.length);
  });

  it("is wired as an always-on tool with a prompt directive", async () => {
    const { ALWAYS_ON_TOOLS, mergeAlwaysOnTools } = await import("../../server/runTools.js");
    assert.ok(ALWAYS_ON_TOOLS.includes(DESIGN_CRITIQUE_TOOL_NAME));
    assert.ok(
      mergeAlwaysOnTools({ resolvedAllow: ["read"], registeredTools: [...ALWAYS_ON_TOOLS] }).includes(DESIGN_CRITIQUE_TOOL_NAME),
    );

    const { DESIGN_CRITIQUE_PROMPT } = await import("../../modes/designRules.js");
    assert.match(DESIGN_CRITIQUE_PROMPT, /design_critique/);
    assert.match(DESIGN_CRITIQUE_PROMPT, /safety gate/i);
    assert.match(DESIGN_CRITIQUE_PROMPT, /preview_screenshot/);
    assert.match(DESIGN_CRITIQUE_PROMPT, /invalid/);

    const { buildSystemPrompt } = await import("../../agent/prompt.js");
    const withTool = buildSystemPrompt(cfg, [], ["design_critique"], [], undefined, undefined, null);
    assert.match(withTool, /design_critique/);
    const withoutTool = buildSystemPrompt(cfg, [], ["read"], [], undefined, undefined, null);
    assert.doesNotMatch(withoutTool, /design_critique/);
  });

  it("keeps the default acceptance bar at the rubric threshold", () => {
    assert.equal(CRITIQUE_PASS_THRESHOLD, 80);
  });
});
