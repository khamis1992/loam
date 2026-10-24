import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Config } from "../../config.js";
import type { PendingKind, WriteGate } from "../../server/pending.js";
import { gateActive } from "../../server/settings.js";
import { createAppBridgeTools } from "../../tools/appBridgeTools.js";
import type { ToolContext } from "../../tools/registry.js";
import { getManifest } from "../registry.js";
import { bridgeSkillBody, writeBridgeSkill } from "../skillGen.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-tools-"));

function ctx(enabled: Record<string, boolean>): ToolContext {
  return { cfg: { workspace, bridges: { enabled }, maxCommandSeconds: 30 } as unknown as Config, workspace, emit: () => {} } as unknown as ToolContext;
}

function tool(name: string, gate?: WriteGate) {
  const t = createAppBridgeTools({ gate }).find((x) => x.name === name);
  assert.ok(t, name);
  return t;
}

test("app_run refuses a disabled bridge and names the UI fallback", async () => {
  const r = await tool("app_run").run({ app: "ffmpeg", command: "convert", args: {} }, ctx({}));
  assert.equal(r.ok, false);
  assert.match(r.content, /disabled/);
  assert.match(r.content, /computer_ui_tree/);
});

test("app_run rejects an unknown app with the UI hint", async () => {
  const r = await tool("app_run").run({ app: "nope", command: "x" }, ctx({}));
  assert.equal(r.ok, false);
  assert.match(r.content, /computer_ui_click/);
});

test("app_describe lists commands and params", async () => {
  const r = await tool("app_describe").run({ app: "blender" }, ctx({}));
  assert.equal(r.ok, true);
  assert.match(r.content, /run_script \[exec_script\]/);
});

test("exec_script and external commands stage instead of running", { skip: !gateActive() }, async () => {
  const staged: { kind: PendingKind; summary: string; payload: Record<string, unknown> }[] = [];
  const gate: WriteGate = {
    stage: (kind, summary, payload) => {
      staged.push({ kind, summary, payload });
      return { id: "pend_test", at: "", kind, summary, payload };
    },
  };
  const r = await tool("app_run", gate).run({ app: "obsidian", command: "open_vault", args: { vault: "Notes" } }, ctx({ obsidian: true }));
  assert.equal(r.ok, true);
  assert.match(r.content, /staged for approval/);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]!.kind, "app_run");
  assert.equal(staged[0]!.payload["app"], "obsidian");
});

test("generated skill documents every command and is written atomically", () => {
  const m = getManifest("ffmpeg");
  assert.ok(m);
  const body = bridgeSkillBody(m);
  for (const c of m.commands) assert.match(body, new RegExp(`### ${c.id}`));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-skills-"));
  const file = writeBridgeSkill(m, dir);
  assert.equal(path.basename(path.dirname(file)), "bridge-ffmpeg");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^---\nname: bridge-ffmpeg\n/);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
