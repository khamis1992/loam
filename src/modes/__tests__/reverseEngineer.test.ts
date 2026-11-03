import assert from "node:assert/strict";
import test from "node:test";
import { REA_TOOL_ALLOWLIST, REA_VISIBLE_TOOL_ALLOWLIST } from "../../tools/reaAllowlist.js";
import { reverseEngineerMode } from "../reverseEngineer.js";

test("mode shape follows the LoamMode contract (hue2, glyphs, Arabic-first)", () => {
  assert.equal(reverseEngineerMode.id, "reverse-engineer");
  assert.equal(reverseEngineerMode.labelAr, "هندسة عكسية");
  assert.equal(typeof reverseEngineerMode.hue2, "number");
  assert.match(reverseEngineerMode.tagline, /دليل/);
  assert.deepEqual(reverseEngineerMode.panels, ["files"]);
  assert.equal(reverseEngineerMode.readOnly, false);
  assert.ok(reverseEngineerMode.starters.length >= 3);
  for (const s of reverseEngineerMode.starters) assert.ok(/[\u0600-\u06FF]/.test(s.label), "starter labels are Arabic");
  assert.equal(reverseEngineerMode.icon.includes("✨"), false); // no Sparkles, ever
});

test("tools list carries only the engine-free mcp__rea__ names plus the read/skill surface (D8)", () => {
  const mcpTools = reverseEngineerMode.tools.filter((t) => t.startsWith("mcp__rea__"));
  assert.equal(mcpTools.length, REA_VISIBLE_TOOL_ALLOWLIST.length);
  for (const tool of REA_VISIBLE_TOOL_ALLOWLIST) {
    assert.ok(reverseEngineerMode.tools.includes(`mcp__rea__${tool}`), `missing mcp__rea__${tool}`);
  }
  // No engine or mutator tool ever leaks into the mode.
  assert.equal(reverseEngineerMode.tools.some((t) => t.startsWith("mcp__") && !t.startsWith("mcp__rea__")), false);
  for (const base of ["file_read", "file_list", "file_search", "artifact_publish", "skill_list", "skill_view", "ask_user", "task_cancel"]) {
    assert.ok(reverseEngineerMode.tools.includes(base), `missing ${base}`);
  }
});

test("ask mode never sees mcp__* — the mode is the only mcp__rea__ consumer (D8 guard)", () => {
  // The reverse-engineer mode owns the names; other catalogs (checked at wiring time
  // by check:mcp / check-modes) must not gain them. Here we assert the invariant the
  // wiring relies on: every mcp__rea__ name in this module traces to the allowlist.
  const allow = new Set(REA_TOOL_ALLOWLIST.map((t) => `mcp__rea__${t}`));
  for (const t of reverseEngineerMode.tools) {
    if (t.startsWith("mcp__rea__")) assert.ok(allow.has(t));
  }
});
