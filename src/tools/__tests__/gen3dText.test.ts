import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createGenExtraTools, GEN_EXTRA_TOOL_NAMES } from "../genExtra.js";
import type { Tool, ToolContext } from "../registry.js";

function setup() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gen3d-text-"));
  const tools = new Map<string, Tool>(createGenExtraTools({}).map((t) => [t.name, t]));
  const ctx = { cfg: {}, emit: () => {}, workspace, taskId: "task-1" } as unknown as ToolContext;
  const tool = (name: string): Tool => {
    const t = tools.get(name);
    assert.ok(t, name);
    return t;
  };
  return { ctx, tool, workspace, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

test("gen_3d_from_text is registered in the tool-name list", () => {
  assert.ok(GEN_EXTRA_TOOL_NAMES.includes("gen_3d_from_text"));
});

test("gen_3d_from_text: writes a real .glb inside the task workspace", async () => {
  const { tool, ctx, workspace, cleanup } = setup();
  const r = await tool("gen_3d_from_text").run({ prompt: "a house with 2 trees" }, ctx);
  assert.ok(r.ok, r.content);
  const meta = JSON.parse(r.content) as { path: string; provider: string; label: string; parts: number; triangles: number; bytes: number };
  assert.equal(meta.provider, "local-procedural");
  assert.equal(meta.label, "house+tree");
  assert.ok(meta.triangles > 60);
  // containment: the tool must never emit a path outside the workspace root
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, meta.path);
  assert.ok(resolved === root || resolved.startsWith(root + path.sep), `path stays inside the workspace: ${meta.path}`);
  assert.ok(fs.existsSync(resolved), "glb written");
  const written = fs.readFileSync(resolved);
  assert.equal(written.subarray(0, 4).toString("ascii"), "glTF");
  assert.equal(written.length, meta.bytes);
  cleanup();
});

test("gen_3d_from_text: Arabic prompts work and empty prompts are refused", async () => {
  const { tool, ctx, cleanup } = setup();
  const arabic = await tool("gen_3d_from_text").run({ prompt: "برج وكرتان في الليل" }, ctx);
  assert.ok(arabic.ok, arabic.content);
  const meta = JSON.parse(arabic.content) as { label: string };
  assert.ok(meta.label.length > 0);
  const empty = await tool("gen_3d_from_text").run({ prompt: "   " }, ctx);
  assert.equal(empty.ok, false);
  cleanup();
});
