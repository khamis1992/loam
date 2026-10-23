/**
 * Loam Video prompt and routing tests (task fc-07).
 *
 * The master prompt asset (`prompts/loam-master.md`, section 6.12) is the
 * human-editable source of truth; `src/agent/videoPrompt.ts` mirrors the guidance
 * in a module that can be sent to runs that do not carry the whole master prompt
 * and can be unit-tested in isolation. These tests pin the contract:
 *
 *  - the guidance is injected for runs that can call video_studio,
 *  - it teaches the open -> state -> incremental edits -> verify -> export loop,
 *  - it states the two-engine routing and the degradation behaviour,
 *  - the master prompt carries the section, with the same routing tables,
 *  - no upstream project name leaks into prompt, tool or planner text.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

// Must come before any import that evaluates `config.js`: `buildSystemPrompt`
// reads user personalization from the SQLite store under DATA_DIR.
import { cleanupIsolatedDataDir } from "../../test/isolation.js";
import { closeDb } from "../../server/sqliteStore.js";

after(() => {
  closeDb();
  cleanupIsolatedDataDir();
});

import {
  EFFECTS_ENGINE_NAME,
  EFFECTS_OPERATIONS,
  FILM_OPERATIONS,
  VIDEO_EDITING_LOOP,
  VIDEO_EDITING_PROMPT,
  VIDEO_PRODUCT_NAME,
  VIDEO_STUDIO_ACTIONS,
  VIDEO_STUDIO_TOOL_NAME,
  TIMELINE_ENGINE_NAME,
  hasVideoStudioTool,
} from "../videoPrompt.js";
import { MASTER_PROMPT_SECTIONS } from "../masterPromptText.js";
import { buildSystemPrompt } from "../prompt.js";
import { PLANNER_SYSTEM } from "../planner.js";
import type { Config } from "../../config.js";

const cfg = {
  workspace: "C:/work/video-task",
  model: "qwen2.5:14b",
  policy: { networkEnabled: false },
} as unknown as Config;

/** Upstream (internal) project names: never user-facing. */
const UPSTREAM_NAMES = ["filmcraft", "effectcraft", "artcraft"];

function videoSection() {
  return MASTER_PROMPT_SECTIONS.find((s) => s.body.includes("### 6.12 Video editing"));
}

describe("Loam Video routing tables", () => {
  it("lists the timeline engine's operations and the effects engine's", () => {
    for (const op of ["cut", "trim", "split", "speed", "audio", "music", "volume", "static (plain) text", "a basic dissolve/fade"]) {
      assert.ok(FILM_OPERATIONS.includes(op), `missing timeline operation: ${op}`);
    }
    for (const op of ["visual effects", "colour looks and grading", "text/motion animation", "keyframed motion", "animated titles"]) {
      assert.ok(EFFECTS_OPERATIONS.includes(op), `missing effects operation: ${op}`);
    }
  });

  it("documents exactly the actions the video_studio tool exposes", () => {
    const expected = [
      "open",
      "state",
      "import",
      "cut",
      "trim",
      "delete",
      "move",
      "reorder",
      "split",
      "speed",
      "add_text",
      "add_audio",
      "music",
      "transition_basic",
      "effect_basic",
      "undo",
      "raw",
    ];
    assert.deepEqual([...VIDEO_STUDIO_ACTIONS], expected);
  });

  it("teaches the five-step loop in order", () => {
    assert.equal(VIDEO_EDITING_LOOP.length, 5);
    const steps = VIDEO_EDITING_LOOP.map((step) => step.split(" ")[0]);
    assert.deepEqual(steps, ["open", "state", "incremental", "verify", "export"]);
  });

  it("detects the tool that should receive the guidance", () => {
    assert.equal(hasVideoStudioTool([VIDEO_STUDIO_TOOL_NAME]), true);
    assert.equal(hasVideoStudioTool(["file_read", "web_search"]), false);
    assert.equal(hasVideoStudioTool([]), false);
  });
});

describe("Loam Video guidance in the assembled prompt", () => {
  const videoTools = [VIDEO_STUDIO_TOOL_NAME];

  it("is present when video_studio is available", () => {
    const prompt = buildSystemPrompt(cfg, [], videoTools);
    assert.match(prompt, /Loam Video/i, "video guidance missing for video_studio");
  });

  it("is absent when no video tool is available", () => {
    const prompt = buildSystemPrompt(cfg, [], ["file_read", "web_search"]);
    assert.doesNotMatch(prompt, /Loam Video:/, "video guidance leaked into a run with no video tool");
  });

  it("teaches the open -> state -> incremental edits -> verify -> export loop", () => {
    const prompt = buildSystemPrompt(cfg, [], videoTools);
    assert.match(prompt, /open/i);
    assert.match(prompt, /state before every mutating action/i);
    assert.match(prompt, /incremental/i);
    assert.match(prompt, /re-read state/i, "must verify the edit landed");
    assert.match(prompt, /export/i);
  });

  it("states the routing and the degrade-don't-fail contract", () => {
    const prompt = buildSystemPrompt(cfg, [], videoTools);
    assert.match(prompt, /routing/i);
    assert.match(prompt, /route = the engine that owns the operation/i);
    assert.match(prompt, /target = the engine that actually ran it/i);
    assert.match(prompt, /degraded/i);
    assert.match(prompt, /Degrade, do not fail/i);
    assert.match(prompt, /never present a degraded edit as the full effect/i);
  });

  it("keeps the section in the assembled master prompt, after the Craft section", () => {
    const prompt = buildSystemPrompt(cfg, [], videoTools);
    assert.match(prompt, /### 6\.12 Video editing/);
    assert.ok(prompt.indexOf("### 6.11 Craft editors") < prompt.indexOf("### 6.12 Video editing"), "6.12 must follow 6.11");
  });

  it("keeps the Loam Video rule in the planner system prompt", () => {
    assert.match(PLANNER_SYSTEM, /Loam Video/i);
    assert.match(PLANNER_SYSTEM, /video_studio/i);
    assert.match(PLANNER_SYSTEM, /routing/i);
    assert.match(PLANNER_SYSTEM, /artifact_publish/i);
  });
});

describe("master prompt section 6.12", () => {
  it("is authored in the generated master asset", () => {
    const section = videoSection();
    assert.ok(section, "section 6.12 is missing from the generated master prompt");
    assert.match(section!.body, /Loop: open → state → incremental edits → verify → export/i);
    assert.match(section!.body, /Route each operation, do not guess an engine/i);
    assert.match(section!.body, /Degrade, do not fail/i);
    assert.match(section!.body, /Never invent a command id/i);
    assert.match(section!.body, /Arabic-first, one product, no upstream names/i);
  });

  it("carries the same routing tables as videoPrompt.ts", () => {
    const body = videoSection()!.body;
    for (const op of FILM_OPERATIONS) assert.ok(body.includes(op), `section 6.12 is missing the timeline operation: ${op}`);
    for (const op of EFFECTS_OPERATIONS) assert.ok(body.includes(op), `section 6.12 is missing the effects operation: ${op}`);
  });
});

describe("branding contract", () => {
  const guidance = [VIDEO_EDITING_PROMPT, ...VIDEO_EDITING_LOOP, ...FILM_OPERATIONS, ...EFFECTS_OPERATIONS];

  it("never names an upstream project in the guidance", () => {
    for (const text of guidance) {
      for (const name of UPSTREAM_NAMES) {
        assert.ok(!text.toLowerCase().includes(name), `upstream name "${name}" leaked into: ${text}`);
      }
    }
  });

  it("never names an upstream project in section 6.12", () => {
    const body = videoSection()!.body;
    for (const name of UPSTREAM_NAMES) {
      assert.ok(!body.toLowerCase().includes(name), `upstream name "${name}" leaked into section 6.12`);
    }
  });

  it("never names an upstream project in the assembled prompt or the planner prompt", () => {
    const prompt = buildSystemPrompt(cfg, [], [VIDEO_STUDIO_TOOL_NAME]);
    for (const text of [prompt, PLANNER_SYSTEM]) {
      for (const name of UPSTREAM_NAMES) {
        assert.ok(!text.toLowerCase().includes(name), `upstream name "${name}" leaked into a prompt`);
      }
    }
  });

  it("uses exactly the two Loam engine names", () => {
    for (const name of [VIDEO_PRODUCT_NAME, EFFECTS_ENGINE_NAME, TIMELINE_ENGINE_NAME]) {
      assert.match(VIDEO_EDITING_PROMPT, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `guidance must name ${name}`);
    }
  });
});
