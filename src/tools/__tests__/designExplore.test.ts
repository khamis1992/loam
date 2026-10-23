/**
 * W3 unit tests: the loam_design build-phase tool.
 *
 * The design-exploration phase must hand the agent a stable, testable phase
 * record: 2-3 directions, each with a hex palette, a layout and a hero
 * concept; and the hero action must render through an injected generator
 * (mocked here) without touching the real canvas tool.
 */
import assert from "node:assert";
import { after, describe, it } from "node:test";

// Must come before any import that evaluates `config.js`: `mergeAlwaysOnTools`
// loads the tool registry and builds prompts, which read personalization from
// the SQLite store under DATA_DIR, so without this redirect the test creates the
// repository's real `data/manus.db`.
import { cleanupIsolatedDataDir } from "../../test/isolation.js";
import { closeDb } from "../../server/sqliteStore.js";

after(() => {
  closeDb();
  cleanupIsolatedDataDir();
});

import {
  createDesignExploreTools,
  DESIGN_EXPLORE_TOOL_NAME,
  exploreDesigns,
  type DesignDirection,
  type DesignExploreOutput,
  type DesignPalette,
  type HeroImageGenerator,
} from "../designExplore.js";
import type { ToolContext, ToolResult } from "../../tools/registry.js";
import { BUILD_SUBPHASES, BUILD_PHASE_PROMPT, getBuildPhase } from "../../modes/buildPhases.js";
import { mergeAlwaysOnTools } from "../../server/runTools.js";

const HEX = /^#[\da-f]{6}$/i;

const ctx = {
  cfg: {},
  workspace: "C:/tmp/task",
  emit: () => undefined,
} as unknown as ToolContext;

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

describe("build sub-phase config", () => {
  it("exposes the design-explore entry phase backed by loam_design", () => {
    assert.equal(BUILD_SUBPHASES.mode, "build");
    assert.equal(BUILD_SUBPHASES.entryPhaseId, "design-explore");
    const entry = getBuildPhase(BUILD_SUBPHASES.entryPhaseId);
    assert.equal(entry.order, 0);
    assert.ok(entry.tools.includes(DESIGN_EXPLORE_TOOL_NAME));
    assert.ok(BUILD_PHASE_PROMPT.length > 20);
    assert.match(BUILD_PHASE_PROMPT, /loam_design/);
  });
});

describe("exploreDesigns", () => {
  it("derives 2-3 directions with palette/layout/hero shape", () => {
    const out = exploreDesigns("A task tracker for small teams");
    assert.equal(out.phase, "design-explore");
    assert.ok(out.directions.length >= 2 && out.directions.length <= 3);
    for (const direction of out.directions) {
      assert.ok(direction.id.length > 0);
      assert.ok(direction.name.length > 0);
      for (const value of Object.values(direction.palette)) assert.match(value, HEX);
      assert.ok(direction.layout.length > 10);
      assert.ok(direction.heroConcept.length > 10);
    }
  });

  it("is deterministic for the same brief", () => {
    assert.deepEqual(exploreDesigns("same brief"), exploreDesigns("same brief"));
  });

  it("clamps count into the 1-3 range", () => {
    for (const count of [0, 99, 2]) {
      const out = exploreDesigns("task count clamp", count);
      assert.ok(out.directions.length >= 1 && out.directions.length <= 3);
    }
  });

  it("rejects an empty brief", () => {
    assert.throws(() => exploreDesigns("   "));
  });
});

describe("loam_design tool run", () => {
  it("returns the explore phase output shape", async () => {
    const tool = createDesignExploreTools()[0]!;
    const result = await tool.run({ action: "explore", brief: "Budget dashboard" }, ctx);
    assert.equal(result.ok, true);
    const out = JSON.parse(result.content) as unknown as DesignExploreOutput;
    assert.equal(out.phase, "design-explore");
    assert.equal(out.directions.length, 3);
    for (const direction of out.directions) assert.match(direction.palette.background, HEX);
  });

  it("renders a hero through the injected mock generator", async () => {
    const calls: Record<string, unknown>[] = [];
    const mock: HeroImageGenerator = async (args) => {
      calls.push(args);
      return { ok: true, content: JSON.stringify({ path: args.path, width: 1200, height: 900, format: "svg" }) };
    };
    const tool = createDesignExploreTools({ heroGenerator: mock })[0]!;
    const result = await tool.run(
      { action: "generate_hero", brief: "Photography portfolio", directionId: "dark-foundry" },
      ctx,
    );
    assert.equal(result.ok, true);
    const out = parse(result.content) as Record<string, unknown>;
    assert.equal((out.direction as DesignDirection).name, "Dark Foundry");
    assert.match(String(out.path), /dark-foundry-hero\.svg$/);
    assert.match(String((out.palette as DesignPalette).background), HEX);

    assert.equal(calls.length, 1);
    const sent = calls[0] as Record<string, string>;
    assert.match(sent["path"]!, /hero\.svg$/);
    assert.match(sent["background"]!, HEX);
    assert.match(sent["foreground"]!, HEX);
    assert.match(sent["accent"]!, HEX);
    assert.ok(sent["title"]!.length > 0);
  });

  it("surfaces the generator failure as a failed run", async () => {
    const failing: HeroImageGenerator = async () => ({ ok: false, content: "boom" });
    const tool = createDesignExploreTools({ heroGenerator: failing })[0]!;
    const result = await tool.run({ action: "generate_hero", brief: "Failing hero brief" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /boom/);
  });

  it("appears in the effective allowlist after merging always-on tools", () => {
    const merged = mergeAlwaysOnTools({ resolvedAllow: [], registeredTools: [DESIGN_EXPLORE_TOOL_NAME] });
    assert.ok(merged.includes(DESIGN_EXPLORE_TOOL_NAME));
  });

  it("injects the design-exploration directive into the system prompt", async () => {
    const { buildSystemPrompt } = await import("../../agent/prompt.js");
    const cfg = { workspace: "C:/tmp/task", policy: { networkEnabled: false } } as unknown as Parameters<typeof buildSystemPrompt>[0];
    const withTool = buildSystemPrompt(cfg, [], [DESIGN_EXPLORE_TOOL_NAME]);
    assert.match(withTool, /Design phase/);
    const withoutTool = buildSystemPrompt(cfg, [], ["file_read"]);
    assert.ok(!withoutTool.includes("Design phase"));
  });
});
