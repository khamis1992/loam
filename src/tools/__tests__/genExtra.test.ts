/**
 * N12 generator-tool tests.
 *
 * Each tool is exercised with a mocked provider (or a mocked reasoning model)
 * and, separately, with no provider wired so the "provider not configured"
 * card is proven to be graceful rather than a crash. The storyboard tool is
 * also proven to emit scenes the auto-video planner accepts.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import type { Config } from "../../config.js";
import type { Emit } from "../../agent/events.js";
import type { ToolContext } from "../registry.js";
import type { GenProvider, GenProviders, GenOutput } from "../../creative/genProviders.js";
import type { GenExtraDeps } from "../genExtra.js";

type GenExtra = typeof import("../genExtra.js");
type GenProvidersMod = typeof import("../../creative/genProviders.js");
type Auto = typeof import("../../creative/auto.js");

let genExtra: GenExtra;
let providersMod: GenProvidersMod;
let auto: Auto;
let tmpDir = "";

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-genextra-"));
  genExtra = await import("../genExtra.js");
  providersMod = await import("../../creative/genProviders.js");
  auto = await import("../../creative/auto.js");
});

after(() => {
  try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup raced */ }
});

function ctx(workspace: string, networkEnabled = true): ToolContext {
  return {
    cfg: { policy: { networkEnabled } } as unknown as Config,
    workspace,
    emit: (() => undefined) as Emit,
  };
}

function tool(name: string, deps?: GenExtraDeps) {
  const found = genExtra.createGenExtraTools(deps).find((t) => t.name === name);
  assert.ok(found, `tool ${name} is registered`);
  return found!;
}

function mockProvider(id: string, data: Record<string, unknown>, kind: GenOutput["kind"] = "3d-model"): GenProvider {
  const output: GenOutput = { kind, data };
  return { id, label: id, run: async () => ({ ok: true as const, output }) };
}

function failingProvider(id: string): GenProvider {
  return { id, label: id, run: async () => ({ ok: false as const, content: `${id} backend exploded` }) };
}

function throwingProvider(id: string): GenProvider {
  return { id, label: id, run: async () => { throw new Error("socket hangup"); } };
}

function mockReasoner(content: string) {
  return { chat: async () => ({ content }) };
}

const NOT_CONFIGURED = /not configured/;

describe("genExtra: provider-backed tools with a mocked provider", () => {
  it("gen_3d_from_image returns the provider output", async () => {
    const providers: GenProviders = { imageTo3d: mockProvider("tripo", { modelUrl: "https://cdn/model.glb", format: "glb" }) };
    const res = await tool("gen_3d_from_image", { providers }).run({ image: "assets/cat.png" }, ctx(tmpDir));
    assert.equal(res.ok, true);
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.provider, "tripo");
    assert.equal(parsed.modelUrl, "https://cdn/model.glb");
  });

  it("gen_music returns the provider output", async () => {
    const providers: GenProviders = { music: mockProvider("openai-compatible", { audioUrl: "https://cdn/song.mp3" }, "music") };
    const res = await tool("gen_music", { providers }).run({ prompt: "calm lo-fi beat" }, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(res.content).audioUrl, "https://cdn/song.mp3");
  });

  it("search_images returns the provider output", async () => {
    const providers: GenProviders = { imageSearch: mockProvider("openverse", { query: "desert", results: [{ title: "dunes", url: "https://cdn/d.jpg" }] }, "images") };
    const res = await tool("search_images", { providers }).run({ query: "desert" }, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(res.content).provider, "openverse");
  });

  it("search_x returns the provider output", async () => {
    const providers: GenProviders = { xSearch: mockProvider("x", { query: "loam", tweets: [{ id: "1", text: "hi" }] }, "tweets") };
    const res = await tool("search_x", { providers }).run({ query: "loam" }, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(res.content).provider, "x");
  });

  it("generate_storyboard uses the reasoning model and emits N scenes", async () => {
    const raw = JSON.stringify({
      title: "Desert spot",
      style: "cinematic",
      scenes: [1, 2, 3].map((i) => ({ index: i, title: `S${i}`, visual: `Visual ${i}`, narration: `Line ${i}`, durationSec: 4 })),
    });
    const res = await tool("generate_storyboard", { reasoner: mockReasoner(raw) }).run({ brief: "a desert film", scenes: 3 }, ctx(tmpDir));
    assert.equal(res.ok, true);
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.storyboard.scenes.length, 3);
    assert.equal(parsed.scenes.length, 3);
    assert.equal(parsed.scenes[0].start, 0);
    assert.equal(parsed.scenes[2].end, 12);
  });

  it("solve_logic returns the reasoning model answer", async () => {
    const res = await tool("solve_logic", { reasoner: mockReasoner("FINAL ANSWER: 42") }).run({ problem: "2+2?" }, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(res.content).answer, "FINAL ANSWER: 42");
  });
});

describe("genExtra: unconfigured tools return a clear card, not a crash", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["gen_3d_from_image", { image: "a.png" }],
    ["gen_music", { prompt: "song" }],
    ["generate_storyboard", { brief: "film" }],
    ["solve_logic", { problem: "p" }],
    ["search_images", { query: "cats" }],
    ["search_x", { query: "news" }],
  ];
  for (const [name, args] of cases) {
    it(`${name} is graceful with no provider`, async () => {
      const res = await tool(name).run(args, ctx(tmpDir, false));
      assert.equal(res.ok, false);
      assert.match(res.content, NOT_CONFIGURED);
      const parsed = JSON.parse(res.content);
      assert.equal(parsed.error, genExtra.PROVIDER_NOT_CONFIGURED);
      assert.equal(parsed.tool, name);
      assert.ok(parsed.setup.length > 0, "the card explains how to configure the provider");
    });
  }

  it("requesting an unwired provider names it in the card", async () => {
    const res = await tool("gen_3d_from_image", { providers: { imageTo3d: mockProvider("tripo", {}) } }).run({ image: "a.png", provider: "meshy" }, ctx(tmpDir));
    assert.equal(res.ok, false);
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.provider, "meshy");
  });
});

describe("genExtra: provider failures never crash the tool", () => {
  it("propagates an ok:false provider result", async () => {
    const providers: GenProviders = { imageTo3d: failingProvider("tripo") };
    const res = await tool("gen_3d_from_image", { providers }).run({ image: "a.png" }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /backend exploded/);
  });

  it("converts a provider throw into a failed result", async () => {
    const providers: GenProviders = { imageTo3d: throwingProvider("tripo") };
    const res = await tool("gen_3d_from_image", { providers }).run({ image: "a.png" }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /gen_3d_from_image failed: socket hangup/);
  });

  it("validates required arguments before touching a provider", async () => {
    const res = await tool("gen_3d_from_image", { providers: { imageTo3d: mockProvider("tripo", {}) } }).run({ image: "  " }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /requires image/);
  });
});

describe("compileStoryboard", () => {
  const raw = "Here you go:\n```json\n" + JSON.stringify({
    title: "Spot",
    style: "cinematic",
    scenes: [
      { index: 1, title: "Wide", visual: "Desert horizon", narration: "Opening line", durationSec: 3 },
      { index: 2, title: "Close", visual: "Hands on sand", narration: "Second line", durationSec: 5 },
      { index: 3, title: "Drone", visual: "Aerial dunes", narration: "Third line", durationSec: 4 },
    ],
  }) + "\n```\n";

  it("parses fenced JSON and emits ordered, non-overlapping scenes", () => {
    const compiled = genExtra.compileStoryboard({ raw, sceneCount: 3 });
    assert.ok(compiled.ok);
    const { scenes, captions, storyboard } = compiled.value;
    assert.equal(scenes.length, 3);
    assert.equal(storyboard.scenes.length, 3);
    assert.equal(captions.length, 3);
    let prevEnd = -1;
    for (const scene of scenes) {
      assert.ok(scene.start >= 0, "start is non-negative");
      assert.ok(scene.end > scene.start, "each scene has positive length");
      assert.ok(scene.start >= prevEnd, "scenes are ordered and non-overlapping");
      prevEnd = scene.end;
    }
    assert.deepEqual(scenes[0], { index: 0, start: 0, end: 3, peak: 0.5 });
  });

  it("fills missing scenes with placeholders instead of dropping the storyboard", () => {
    const sparse = JSON.stringify({ title: "Sparse", scenes: [{ index: 1, title: "Only", visual: "One", narration: "One line", durationSec: 2 }] });
    const compiled = genExtra.compileStoryboard({ raw: sparse, sceneCount: 3 });
    assert.ok(compiled.ok);
    assert.equal(compiled.value.scenes.length, 3);
    assert.ok(compiled.value.warnings.length > 0);
  });

  it("distributes a total duration evenly when scenes omit durationSec", () => {
    const noDurations = JSON.stringify({ title: "T", scenes: [{ index: 1, title: "a", visual: "a" }, { index: 2, title: "b", visual: "b" }] });
    const compiled = genExtra.compileStoryboard({ raw: noDurations, sceneCount: 2, durationSec: 10 });
    assert.ok(compiled.ok);
    assert.equal(compiled.value.scenes[0]!.end, 5);
    assert.equal(compiled.value.scenes[1]!.end, 10);
  });

  it("rejects non-JSON and empty-scene replies", () => {
    assert.deepEqual(genExtra.compileStoryboard({ raw: "no json here", sceneCount: 2 }), { ok: false, error: "the model did not return a JSON object" });
    const empty = genExtra.compileStoryboard({ raw: JSON.stringify({ title: "T", scenes: [] }), sceneCount: 2 });
    assert.ok(!empty.ok);
  });
});

describe("storyboard scenes are consumable by the autoVideo pipeline", () => {
  it("pickHighlights accepts the emitted scenes and produces clips", () => {
    const raw = JSON.stringify({
      title: "Product film",
      style: "clean",
      scenes: [
        { index: 1, title: "Intro", visual: "Logo", narration: "Welcome", durationSec: 4 },
        { index: 2, title: "Feature", visual: "App screen", narration: "Here is the app", durationSec: 6 },
        { index: 3, title: "CTA", visual: "Call to action", narration: "Try it today", durationSec: 4 },
        { index: 4, title: "End", visual: "Logo again", narration: "Goodbye", durationSec: 3 },
      ],
    });
    const compiled = genExtra.compileStoryboard({ raw, sceneCount: 4 });
    assert.ok(compiled.ok);
    const clips = auto.pickHighlights(compiled.value.scenes, [], { targetSeconds: 8 });
    assert.ok(Array.isArray(clips));
    assert.ok(clips.length > 0, "the auto-video highlight picker accepts the storyboard scenes");
  });
});

describe("parseJsonObject", () => {
  it("extracts an object surrounded by prose and fences", () => {
    assert.deepEqual(genExtra.parseJsonObject('sure, here: {"a":1} hope it helps'), { a: 1 });
  });
  it("rejects arrays, prose and empty input", () => {
    assert.equal(genExtra.parseJsonObject("[1,2]"), null);
    assert.equal(genExtra.parseJsonObject("nothing"), null);
    assert.equal(genExtra.parseJsonObject(""), null);
  });
});

describe("real provider adapters (mocked network / env)", () => {
  const originalFetch = globalThis.fetch;
  const ENV_KEYS = ["LOAM_TRIPO_API_KEY", "LOAM_MESHY_API_KEY", "LOAM_3D_LOCAL", "LOAM_MUSIC_URL", "LOAM_MUSIC_API_KEY", "LOAM_X_BEARER_TOKEN"];
  const saved: Record<string, string | undefined> = {};

  before(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    globalThis.fetch = originalFetch;
  });

  it("defaultGenProviders wires only what the environment configures", () => {
    assert.deepEqual(providersMod.defaultGenProviders({ policy: { networkEnabled: false } }), {});
    assert.ok(providersMod.defaultGenProviders({ policy: { networkEnabled: true } }).imageSearch, "Openverse image search is built in");
    process.env.LOAM_TRIPO_API_KEY = "tripo-key";
    process.env.LOAM_X_BEARER_TOKEN = "x-token";
    const providers = providersMod.defaultGenProviders({ policy: { networkEnabled: true } });
    assert.equal(providers.imageTo3d?.id, "tripo");
    assert.equal(providers.xSearch?.id, "x");
    delete process.env.LOAM_TRIPO_API_KEY;
    delete process.env.LOAM_X_BEARER_TOKEN;
  });

  it("Tripo adapter reports not configured without a key", async () => {
    const res = await providersMod.tripoImageTo3dProvider.run({ image: "a.png" }, ctx(tmpDir));
    assert.equal(res.ok, false);
    if (res.ok) assert.fail("expected the unconfigured Tripo adapter to fail");
    assert.match(res.content, /not configured/);
  });

  it("local adapter writes a real .glb placeholder into the workspace", async () => {
    const src = path.join(tmpDir, "source.png");
    fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await providersMod.localImageTo3dProvider.run({ image: "source.png", style: "low poly" }, ctx(tmpDir));
    assert.equal(res.ok, true);
    if (!res.ok) assert.fail(res.content);
    const data = res.output.data as { modelPath: string; previewOnly: boolean };
    assert.equal(data.previewOnly, true);
    const file = path.join(tmpDir, data.modelPath);
    assert.ok(fs.existsSync(file), "the placeholder .glb is written");
    assert.equal(fs.readFileSync(file).subarray(0, 4).toString("ascii"), "glTF");
  });

  it("Openverse adapter parses a mocked JSON response", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify({
        result_count: 1,
        results: [{ id: "1", title: "Dunes", url: "https://cdn/d.jpg", creator: "A", license: "cc0", license_url: "https://cc0", width: 100, height: 50 }],
      })),
    })) as unknown as typeof fetch;
    const res = await providersMod.openverseImageSearchProvider.run({ query: "desert", limit: 5 }, ctx(tmpDir));
    assert.equal(res.ok, true);
    if (!res.ok) assert.fail(res.content);
    const results = res.output.data.results as Array<Record<string, unknown>>;
    assert.equal(results.length, 1);
    assert.equal(results[0]!.url, "https://cdn/d.jpg");
  });

  it("X adapter reports not configured without a token", async () => {
    const res = await providersMod.xSearchProvider.run({ query: "loam" }, ctx(tmpDir));
    assert.equal(res.ok, false);
    if (res.ok) assert.fail("expected the unconfigured X adapter to fail");
    assert.match(res.content, /not configured/);
  });
});
