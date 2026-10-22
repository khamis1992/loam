import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreativeError, readScene, saveScene, validateScene, validateGlb, validateGlbAsset } from "../creative/store.js";
import { createCreativeTools } from "../tools/creative.js";
import type { ToolContext } from "../tools/registry.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-creative-"));
function glb(json: object): Buffer {
  const raw = JSON.stringify(json), data = Buffer.from(raw + " ".repeat((4 - Buffer.byteLength(raw) % 4) % 4));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + data.length, 8);
  header.writeUInt32LE(data.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, data]);
}
const scene = {
  version: 1, title: "Product studio", nodes: [{ id: "box-1", name: "Product", type: "box", position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: { color: "#aabbcc", metalness: .4, roughness: .2 }, visible: true, spin: .5 }],
  environment: { background: "#101020", lightIntensity: 3, exposure: 1, grid: true }, camera: { position: [4, 3, 5], target: [0, 1, 0], fov: 45 }, duration: 8,
};
try {
  assert.equal(readScene(root), null);
  const first = saveScene(root, scene, 0);
  assert.equal(first.revision, 1); assert.deepEqual(readScene(root), first);
  assert.throws(() => saveScene(root, scene, 0), e => e instanceof CreativeError && e.status === 409 && e.scene?.revision === 1);
  assert.equal(saveScene(root, { ...scene, title: "Changed" }, 1).revision, 2);
  assert.throws(() => saveScene(root, scene, undefined), CreativeError);
  for (const change of [{ position: [NaN, 0, 0] }, { position: [Infinity, 0, 0] }, { scale: [0, 1, 1] }, { scale: [101, 1, 1] }, { rotation: [0, 0] }, { spin: 21 }, { material: { color: "red", metalness: 0, roughness: 1 } }]) {
    assert.throws(() => validateScene({ ...scene, nodes: [{ ...scene.nodes[0], ...change }] }), CreativeError);
  }
  assert.throws(() => validateScene({ ...scene, nodes: Array(201).fill(scene.nodes[0]) }), CreativeError);
  assert.throws(() => validateScene({ ...scene, nodes: [scene.nodes[0], scene.nodes[0]] }), CreativeError);
  assert.throws(() => validateScene({ ...scene, nodes: [{ ...scene.nodes[0], id: "<script>" }] }), CreativeError);
  const good = glb({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] });
  validateGlb(good);
  fs.writeFileSync(path.join(root, "model.glb"), good);
  assert.equal(validateGlbAsset(root, "model.glb"), path.join(root, "model.glb"));
  for (const uri of ["https://example.org/x.png", "../secret.bin", "file:///etc/passwd", "//host/x", "data:text/html;base64,AAAA"]) assert.throws(() => validateGlb(glb({ asset: { version: "2.0" }, images: [{ uri }] })), CreativeError);
  for (const asset of ["../model.glb", "C:/model.glb", "/model.glb", "sub/../../model.glb", "missing.glb"]) assert.throws(() => validateGlbAsset(root, asset), CreativeError);
  assert.throws(() => validateGlb(Buffer.from("invalid")), CreativeError);
  const broken = Buffer.from(good); broken.writeUInt32LE(999999, 12); assert.throws(() => validateGlb(broken), CreativeError);
  const other = path.join(root, "other"); fs.mkdirSync(other);
  const linked = path.join(root, "linked"); fs.symlinkSync(other, linked, "junction");
  fs.writeFileSync(path.join(other, "model.glb"), good);
  assert.throws(() => validateGlbAsset(root, "linked/model.glb"), CreativeError);
  fs.unlinkSync(linked);
  const model = { ...scene, nodes: [{ ...scene.nodes[0], type: "model", asset: "model.glb" }] };
  assert.equal(saveScene(root, model, 2).nodes[0]?.asset, "model.glb");
  const tool = createCreativeTools()[0]!;
  const ctx = { workspace: root, taskId: "task_creative_test" } as ToolContext;
  assert.equal((await tool.run({ action: "read" }, ctx)).ok, true);
  assert.equal((await tool.run({ action: "replace", scene, expectedRevision: 0 }, ctx)).ok, false);
  assert.equal((await tool.run({ action: "replace", scene, expectedRevision: 3 }, ctx)).ok, true);
  assert.equal((await tool.run({ action: "read" }, { workspace: root } as ToolContext)).ok, false);
  assert.deepEqual(fs.readdirSync(path.join(root, ".loam")), ["creative.json"]);
  console.log("Creative checks passed: persistence, revisions, validation, GLB safety, task tool.");
} finally {
  // Only this test's unique temp directory is removed.
  fs.rmSync(root, { recursive: true, force: true });
}
