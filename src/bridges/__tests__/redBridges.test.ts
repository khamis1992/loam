/**
 * Red bridge manifests (RED_TEAM_BUILD_SPEC §4.4, RP1).
 *
 * Every external engine is wrapped in a declarative manifest validated by
 * parseManifest; red bridges ship disabled by default and the orchestrator still
 * gates the target before a bridge executes (the bridge boundary is
 * defense-in-depth, not the authorization itself).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RED_MANIFESTS } from "../../bridges/red.js";
import { BUILTIN_MANIFESTS } from "../../bridges/builtin.js";
import { loadManifests, manifestLoadErrors } from "../../bridges/registry.js";
import { parseManifest } from "../../bridges/manifestSchema.js";
import type { BridgeManifest } from "../../bridges/types.js";

const parseAll = (): BridgeManifest[] =>
  RED_MANIFESTS.map((raw) => {
    const r = parseManifest(raw);
    assert.ok(r.ok, `manifest must parse: ${r.ok ? "" : r.error}`);
    return r.manifest;
  });

const byId = (id: string): BridgeManifest => {
  const m = parseAll().find((x) => x.id === id);
  assert.ok(m, `manifest ${id} exists`);
  return m!;
};

describe("red bridge manifests", () => {
  it("all seven engines are declared and schema-valid", () => {
    const ids = parseAll().map((m) => m.id);
    assert.deepEqual(
      [...ids].sort(),
      ["red-caldera", "red-ffuf", "red-freeway", "red-nuclei", "red-sqlmap", "red-ysoserial", "red-zap"],
    );
  });

  it("ids do not collide with built-in bridges and load into the registry", () => {
    const builtinIds = new Set(BUILTIN_MANIFESTS.map((m) => (m as { id: string }).id));
    for (const m of parseAll()) assert.ok(!builtinIds.has(m.id), `${m.id} must not shadow a builtin`);
    const loaded = loadManifests();
    for (const m of parseAll()) assert.ok(loaded.some((x) => x.id === m.id), `${m.id} loaded by registry`);
    assert.deepEqual(manifestLoadErrors(), []);
  });

  it("every command effect is declared and timeouts are bounded 1..900", () => {
    for (const m of parseAll()) {
      for (const c of m.commands) {
        assert.ok(["read", "write_workspace", "exec_script", "external"].includes(c.effect));
        if (c.timeoutSeconds !== undefined) {
          assert.ok(c.timeoutSeconds >= 1 && c.timeoutSeconds <= 900, `${m.id}.${c.id} timeout out of range`);
        }
      }
    }
  });

  it("sqlmap default test is non-destructive: no --dump/--os-shell outside the dump command", () => {
    const sqlmap = byId("red-sqlmap");
    const test = sqlmap.commands.find((c) => c.id === "test")!;
    const flat = JSON.stringify(test.argv);
    assert.ok(!flat.includes("--dump"), "test command must not dump data");
    assert.ok(!flat.includes("--os-shell"), "test command must not open a shell");
    const dump = sqlmap.commands.find((c) => c.id === "dump");
    assert.ok(dump, "separate destructive dump command exists");
    assert.ok(JSON.stringify(dump!.argv).includes("--dump"));
  });

  it("ysoserial gen is exec_script (local transform) and offers benign URLDNS first", () => {
    const yso = byId("red-ysoserial");
    const gen = yso.commands.find((c) => c.id === "gen")!;
    assert.equal(gen.effect, "exec_script");
    const gadget = gen.params.gadget!;
    assert.equal(gadget.type, "enum");
    assert.ok(gadget.values!.includes("URLDNS"), "benign DNS gadget present");
  });

  it("network-facing scan commands are external and carry rate-limit knobs", () => {
    const nuclei = byId("red-nuclei").commands.find((c) => c.id === "scan")!;
    assert.equal(nuclei.effect, "external");
    const flat = JSON.stringify(nuclei.argv);
    assert.ok(flat.includes("-jsonl"), "nuclei scan emits jsonl");
    assert.ok(flat.includes("when"), "rate limit group present");
    const ffuf = byId("red-ffuf").commands.find((c) => c.id === "fuzz")!;
    assert.equal(ffuf.effect, "external");
    assert.ok(JSON.stringify(ffuf.argv).includes("-of"), "ffuf emits json output");
  });

  it("write_workspace commands declare a write path param (confinement rule)", () => {
    for (const m of parseAll()) {
      for (const c of m.commands) {
        if (c.effect === "write_workspace") {
          assert.ok(
            Object.values(c.params).some((p) => p.type === "path" && p.access === "write"),
            `${m.id}.${c.id} write_workspace needs a write path param`,
          );
        }
      }
    }
  });
});
