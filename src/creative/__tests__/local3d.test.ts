import assert from "node:assert/strict";
import test from "node:test";
import { buildGlb, sceneFromPrompt, sceneTriangles } from "../local3d.js";

/** Parse a GLB back into { json, bin } so the tests verify the real structure. */
function parseGlb(buffer: Buffer): { json: Record<string, unknown>; bin: Uint8Array } {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF");
  assert.equal(buffer.readUInt32LE(4), 2);
  assert.equal(buffer.readUInt32LE(8), buffer.length);
  let offset = 12;
  let json: Record<string, unknown> | undefined;
  let bin: Uint8Array = new Uint8Array(0);
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    else if (type === 0x004e4942) bin = data;
    offset += 8 + length;
  }
  assert.ok(json, "JSON chunk present");
  return { json, bin };
}

test("sceneFromPrompt: keyword scenes compose real parts", () => {
  const house = sceneFromPrompt("a small house with 3 trees");
  assert.equal(house.label, "house+tree");
  // ground + house body + roof + door + 3 × (trunk + foliage)
  assert.equal(house.parts.length, 4 + 6);
  assert.ok(house.parts.some((part) => part.geometry === "cone"), "roof cone");
  assert.ok(house.parts.some((part) => part.geometry === "sphere"), "tree foliage");

  const city = sceneFromPrompt("night city skyline");
  const towers = city.parts.filter((part) => part.geometry === "box" && part.size[1] >= 2.5);
  assert.ok(towers.length >= 5, `city towers: ${towers.length}`);

  const arabic = sceneFromPrompt("بيت وشجرتان في الصحراء");
  assert.equal(arabic.label, "house+tree");

  const fallback = sceneFromPrompt("completely unknown gibberish zzq");
  assert.equal(fallback.label, "scene");
  assert.ok(fallback.parts.length >= 4, "signature scene always yields geometry");
});

test("sceneFromPrompt: deterministic — same prompt, identical bytes", () => {
  const a = buildGlb(sceneFromPrompt("a red house with two trees"));
  const b = buildGlb(sceneFromPrompt("a red house with two trees"));
  assert.ok(a.equals(b), "byte-identical for the same prompt");
  const c = buildGlb(sceneFromPrompt("a blue car"));
  assert.ok(!a.equals(c), "different prompts differ");
});

test("buildGlb: valid glTF 2.0 with meshes, materials and accessors", () => {
  const scene = sceneFromPrompt("a house");
  const glb = buildGlb(scene);
  const { json, bin } = parseGlb(glb);

  const meshes = json.meshes as Array<Record<string, unknown>>;
  const materials = json.materials as Array<Record<string, unknown>>;
  const accessors = json.accessors as Array<Record<string, unknown>>;
  const bufferViews = json.bufferViews as Array<Record<string, unknown>>;
  const nodes = json.nodes as Array<Record<string, unknown>>;
  const buffers = json.buffers as Array<{ byteLength: number }>;

  assert.equal(meshes.length, scene.parts.length);
  assert.equal(materials.length, scene.parts.length);
  assert.equal(nodes.length, scene.parts.length);
  // 3 accessors per primitive
  assert.equal(accessors.length, scene.parts.length * 3);
  assert.equal((bufferViews[0] as { buffer: number }).buffer, 0);
  const declaredBuffer = buffers[0];
  assert.ok(declaredBuffer, "buffer declaration present");
  assert.equal(declaredBuffer.byteLength, bin.length, "declared BIN length matches the chunk");
  assert.ok(sceneTriangles(scene) > 60, `triangles: ${sceneTriangles(scene)}`);

  // POSITION accessors carry min/max; NORMAL accessors must not
  for (const mesh of meshes) {
    const primitive = (mesh.primitives as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const attributes = primitive.attributes as Record<string, number>;
    const position = accessors[attributes.POSITION as number] as { min?: number[]; max?: number[] };
    const normal = accessors[attributes.NORMAL as number] as { min?: unknown };
    assert.ok(position.min && position.max, "POSITION has min/max");
    assert.equal(position.min.length, 3);
    assert.equal(position.max.length, 3);
    assert.ok((position.max[0] as number) >= (position.min[0] as number));
    assert.equal(normal.min, undefined);
  }
  // every mesh primitive references a material and valid accessors
  for (const mesh of meshes) {
    const primitive = (mesh.primitives as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const attributes = primitive.attributes as Record<string, number>;
    assert.ok(typeof primitive.material === "number");
    assert.ok(attributes.POSITION !== undefined && attributes.NORMAL !== undefined);
    assert.ok(typeof primitive.indices === "number");
  }
  // index accessors are uint16 and consistent with their vertex counts
  for (const mesh of meshes) {
    const primitive = (mesh.primitives as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const indexAccessor = accessors[primitive.indices as number] as { componentType: number; count: number };
    const positionAccessor = accessors[(primitive.attributes as Record<string, number>).POSITION as number] as { count: number };
    assert.equal(indexAccessor.componentType, 5123);
    assert.ok(indexAccessor.count % 3 === 0, "triangle list");
    assert.ok(indexAccessor.count / 3 <= positionAccessor.count * 2);
  }
});

test("buildGlb: rotation becomes a normalized quaternion", () => {
  const scene = sceneFromPrompt("a house");
  const rotated: typeof scene = { ...scene, parts: scene.parts.map((part) => ({ ...part, rotation: [0.3, 0.8, 1.1] })) };
  const { json } = parseGlb(buildGlb(rotated));
  const nodes = json.nodes as Array<{ rotation?: number[] }>;
  assert.ok(nodes.every((node) => Array.isArray(node.rotation) && node.rotation.length === 4));
  for (const node of nodes) {
    const [x, y, z, w] = node.rotation as [number, number, number, number];
    assert.ok(Math.abs(Math.hypot(x, y, z, w) - 1) < 1e-5, "unit quaternion");
  }
});
