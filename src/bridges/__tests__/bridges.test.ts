import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildArgv } from "../argv.js";
import { toEnvelope } from "../envelope.js";
import { parseManifest } from "../manifestSchema.js";
import { loadManifests, manifestLoadErrors, getManifest } from "../registry.js";
import { expandEnv } from "../windowsProbe.js";

const ws = path.join(os.tmpdir(), "bridge-ws");

test("every built-in manifest validates", () => {
  assert.deepEqual(manifestLoadErrors(), []);
  assert.deepEqual(
    loadManifests().map((m) => m.id).sort(),
    ["blender", "ffmpeg", "inkscape", "libreoffice", "obsidian"],
  );
});

test("manifest fails closed on undeclared placeholder", () => {
  const r = parseManifest({
    id: "x",
    name: "X",
    description: "d",
    probe: { names: ["x.exe"] },
    commands: [{ id: "c", description: "d", effect: "read", argv: ["{nope}"], params: {}, output: "text" }],
  });
  assert.equal(r.ok, false);
});

test("write_workspace needs a write path param", () => {
  const r = parseManifest({
    id: "x",
    name: "X",
    description: "d",
    probe: { names: ["x.exe"] },
    commands: [{ id: "c", description: "d", effect: "write_workspace", argv: [], params: {}, output: "text" }],
  });
  assert.equal(r.ok, false);
});

test("argv: option injection and unknown keys are rejected", () => {
  const cmd = getManifest("ffmpeg")!.commands[0]!;
  assert.equal(buildArgv(cmd, { input: "-i evil", output: "o.mp3" }, ws).ok, false);
  assert.equal(buildArgv(cmd, { input: "a.mp4", output: "o.mp3", extra: "1" }, ws).ok, false);
  assert.equal(buildArgv(cmd, { input: "a.mp4" }, ws).ok, false);
});

test("argv: write path must stay inside the workspace", () => {
  const cmd = getManifest("ffmpeg")!.commands[0]!;
  const bad = buildArgv(cmd, { input: "a.mp4", output: path.join(os.tmpdir(), "..", "escape.mp3") }, ws);
  assert.equal(bad.ok, false);
  const good = buildArgv(cmd, { input: "a.mp4", output: "out.mp3" }, ws);
  assert.equal(good.ok, true);
});

test("argv: optional group only when supplied, enum checked", () => {
  const cmd = getManifest("inkscape")!.commands[0]!;
  const a = buildArgv(cmd, { input: "a.svg", output: "a.png", format: "png" }, ws);
  assert.ok(a.ok && !a.argv.some((t) => t.startsWith("--export-dpi")));
  const b = buildArgv(cmd, { input: "a.svg", output: "a.png", format: "png", dpi: 96 }, ws);
  assert.ok(b.ok && b.argv.includes("--export-dpi=96"));
  assert.equal(buildArgv(cmd, { input: "a.svg", output: "a.png", format: "gif" }, ws).ok, false);
});

test("envelope: json error object, timeout and exit", () => {
  const j = toEnvelope({ output: "json" }, { code: 0, stdout: '{"error":"bad","type":"E1"}', stderr: "", timedOut: false });
  assert.equal(j.ok, false);
  assert.equal(j.error?.type, "E1");
  assert.equal(toEnvelope({ output: "text" }, { code: null, stdout: "", stderr: "", timedOut: true }).error?.type, "timeout");
  assert.equal(toEnvelope({ output: "text" }, { code: 2, stdout: "", stderr: "boom", timedOut: false }).error?.type, "exit");
});

test("expandEnv voids a path with a missing variable", () => {
  assert.equal(expandEnv("%NOPE_X%\\a", {}), null);
  assert.equal(expandEnv("%A%\\b", { A: "C:\\x" }), "C:\\x\\b");
});
