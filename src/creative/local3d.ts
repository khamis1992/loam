/**
 * Procedural text-to-3D (blueprint gap 4) — local, key-less, deterministic.
 *
 * `sceneFromPrompt` parses the prompt for object and palette keywords and lays
 * out primitive parts (box / cylinder / sphere / cone) on a ground plane;
 * `buildGlb` packs those parts into a valid binary glTF 2.0 (.glb) with per-part
 * PBR materials — written by hand, no 3D dependency, so the agent can always
 * produce a real 3D asset on-device. A photoreal result still needs the BYOK
 * chain (design_image_generate then gen_3d_from_image); this is the always-on
 * local floor, mirroring the deterministic local image generator.
 */

export type GeometryKind = "box" | "cylinder" | "sphere" | "cone";

export interface ScenePart {
  geometry: GeometryKind;
  /** Dimensions (w, h, d) for boxes; (width, height, depth) meaning diameter×height×diameter for round kinds. */
  size: [number, number, number];
  /** Part center in world units (y is up; the ground top sits at y = 0). */
  position: [number, number, number];
  /** Optional rotation in radians (applied X, then Y, then Z). */
  rotation?: [number, number, number];
  /** Linear base color (sRGB, 0-1). */
  color: [number, number, number];
}

export interface ProceduralScene {
  parts: ScenePart[];
  label: string;
}

// ---------------------------------------------------------------------------
// Deterministic randomness (same prompt -> same scene)
// ---------------------------------------------------------------------------

function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Prompt -> scene
// ---------------------------------------------------------------------------

interface Palette {
  ground: [number, number, number];
  accent: [number, number, number];
  label: string;
}

const PALETTES: Array<{ words: string[]; palette: Palette }> = [
  { words: ["desert", "sand", "صحراء"], palette: { ground: [0.85, 0.74, 0.52], accent: [0.93, 0.62, 0.30], label: "desert" } },
  { words: ["snow", "winter", "ثلج", "شتاء"], palette: { ground: [0.94, 0.95, 0.97], accent: [0.55, 0.65, 0.85], label: "snow" } },
  { words: ["night", "space", "ليل", "فضاء"], palette: { ground: [0.09, 0.09, 0.14], accent: [0.85, 0.75, 0.35], label: "night" } },
  { words: ["city", "مدينة"], palette: { ground: [0.32, 0.32, 0.34], accent: [0.45, 0.65, 0.85], label: "city" } },
];

function paletteFor(prompt: string): Palette {
  for (const entry of PALETTES) {
    if (entry.words.some((word) => prompt.includes(word))) return entry.palette;
  }
  return { ground: [0.36, 0.58, 0.30], accent: [0.80, 0.35, 0.30], label: "day" };
}

/** Parse a prompt into a deterministic primitive scene. */
export function sceneFromPrompt(prompt: string): ProceduralScene {
  const text = ` ${prompt.toLowerCase()} `;
  const rand = mulberry32(hashString(prompt.toLowerCase()));
  const jitter = (amount: number): number => (rand() - 0.5) * 2 * amount;
  const palette = paletteFor(text);
  const parts: ScenePart[] = [];
  const found: string[] = [];

  // Ground plane (top face at y = 0).
  parts.push({ geometry: "box", size: [24, 0.2, 24], position: [0, -0.1, 0], color: palette.ground });

  const countOf = (singular: string[], plural: string[]): number => {
    for (const word of plural) {
      const match = new RegExp(`(\\d+)\\s+${word}`).exec(text);
      if (match) return Math.min(12, Math.max(1, Number.parseInt(match[1] ?? "1", 10)));
    }
    for (const word of [...singular, ...plural]) if (text.includes(word)) return 1;
    return 0;
  };

  const place = (index: number, total: number, spread: number): [number, number] => {
    if (total <= 1) return [jitter(1.2), jitter(1.2)];
    const angle = (index / total) * Math.PI * 2 + jitter(0.2);
    const radius = spread + jitter(0.8);
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  };

  // House: box body + pyramid roof + door.
  const houses = countOf(["house", "home", "منزل", "بيت"], ["houses", "homes", "منازل"]);
  for (let i = 0; i < houses; i++) {
    const [x, z] = place(i, houses, 4.5);
    const wall: [number, number, number] = [0.88, 0.62, 0.55];
    const roof: [number, number, number] = [0.55, 0.22, 0.18];
    parts.push({ geometry: "box", size: [3, 2, 2.6], position: [x, 1, z], color: wall });
    parts.push({ geometry: "cone", size: [3.5, 1.4, 3.5], position: [x, 2.7, z], rotation: [0, Math.PI / 4, 0], color: roof });
    parts.push({ geometry: "box", size: [0.7, 1.1, 0.12], position: [x, 0.55, z + 1.31], color: [0.35, 0.24, 0.14] });
    found.push("house");
  }

  // Tree: trunk cylinder + foliage sphere. Arabic keeps the dual form too.
  const trees = countOf(["tree", "شجرة", "شجرتان"], ["trees", "أشجار"]);
  for (let i = 0; i < trees; i++) {
    const [x, z] = place(i, trees, 6.5);
    parts.push({ geometry: "cylinder", size: [0.35, 1.6, 0.35], position: [x, 0.8, z], color: [0.38, 0.26, 0.15] });
    parts.push({ geometry: "sphere", size: [1.9 + Math.abs(jitter(0.4)), 1.9, 1.9], position: [x, 2.2, z], color: [0.16, 0.45 + Math.abs(jitter(0.1)), 0.18] });
    found.push("tree");
  }

  // Car: body + cabin + four wheel cylinders.
  const cars = countOf(["car", "سيارة"], ["cars", "سيارات"]);
  for (let i = 0; i < cars; i++) {
    const [x, z] = place(i, cars, 3.5);
    const paint: [number, number, number] = palette.accent;
    parts.push({ geometry: "box", size: [3.4, 0.8, 1.6], position: [x, 0.6, z], color: paint });
    parts.push({ geometry: "box", size: [1.7, 0.7, 1.4], position: [x - 0.2, 1.3, z], color: [0.65, 0.78, 0.86] });
    for (const [wx, wz] of [[-1.1, -0.85], [-1.1, 0.85], [1.1, -0.85], [1.1, 0.85]] as Array<[number, number]>) {
      parts.push({ geometry: "cylinder", size: [0.7, 0.35, 0.7], position: [x + wx, 0.35, z + wz], rotation: [0, 0, Math.PI / 2], color: [0.08, 0.08, 0.08] });
    }
    found.push("car");
  }

  // Robot: box torso + head + cylinder neck + two arms.
  const robots = countOf(["robot", "روبوت"], ["robots", "روبوتات"]);
  for (let i = 0; i < robots; i++) {
    const [x, z] = place(i, robots, 3.5);
    const metal: [number, number, number] = [0.72, 0.75, 0.80];
    parts.push({ geometry: "box", size: [1.4, 2.0, 0.9], position: [x, 1.0, z], color: metal });
    parts.push({ geometry: "cylinder", size: [0.35, 0.35, 0.35], position: [x, 2.15, z], color: [0.35, 0.38, 0.42] });
    parts.push({ geometry: "box", size: [1.0, 0.8, 0.9], position: [x, 2.7, z], color: [0.85, 0.86, 0.90] });
    parts.push({ geometry: "box", size: [0.35, 1.6, 0.35], position: [x - 1.0, 1.1, z], color: [0.60, 0.63, 0.68] });
    parts.push({ geometry: "box", size: [0.35, 1.6, 0.35], position: [x + 1.0, 1.1, z], color: [0.60, 0.63, 0.68] });
    found.push("robot");
  }

  // Tower / building / city skyline.
  const towers = text.includes("city") || text.includes("مدينة")
    ? 5 + Math.floor(rand() * 3)
    : countOf(["tower", "building", "برج", "مبنى"], ["towers", "buildings", "أبراج", "مباني"]);
  for (let i = 0; i < towers; i++) {
    const [x, z] = place(i, towers, 7.5);
    const height = 2.5 + rand() * 4.5;
    parts.push({ geometry: "box", size: [1.6, height, 1.6], position: [x, height / 2, z], color: [0.52 + jitter(0.08), 0.54 + jitter(0.08), 0.60 + jitter(0.08)] });
    parts.push({ geometry: "cylinder", size: [0.08, 1.1, 0.08], position: [x, height + 0.55, z], color: [0.30, 0.30, 0.32] });
    found.push("tower");
  }

  // Mountains / hills: cones.
  const mountains = countOf(["mountain", "hill", "جبل", "تلة"], ["mountains", "hills", "جبال", "تلال"]) || (text.includes("terrain") || text.includes("تضاريس") ? 4 : 0);
  for (let i = 0; i < mountains; i++) {
    const [x, z] = place(i, mountains, 9.5);
    const height = 2 + rand() * 2.5;
    parts.push({ geometry: "cone", size: [3.2 + rand() * 1.5, height, 3.2 + rand() * 1.5], position: [x, height / 2, z], rotation: [0, rand() * Math.PI, 0], color: [0.42, 0.40, 0.38] });
    found.push("mountain");
  }

  // Free primitives.
  const spheres = countOf(["sphere", "ball", "كرة"], ["spheres", "balls", "كرات"]);
  for (let i = 0; i < spheres; i++) {
    const [x, z] = place(i, spheres, 2.5);
    parts.push({ geometry: "sphere", size: [1.6, 1.6, 1.6], position: [x, 0.8, z], color: palette.accent });
    found.push("sphere");
  }
  const cubes = countOf(["cube", "box", "مكعب", "صندوق"], ["cubes", "boxes", "مكعبات"]);
  for (let i = 0; i < cubes; i++) {
    const [x, z] = place(i, cubes, 2.5);
    parts.push({ geometry: "box", size: [1.5, 1.5, 1.5], position: [x, 0.75, z], rotation: [0, jitter(0.6), 0], color: [0.35, 0.55, 0.75] });
    found.push("cube");
  }
  const cones = countOf(["cone", "مخروط"], ["cones", "مخاريط"]);
  for (let i = 0; i < cones; i++) {
    const [x, z] = place(i, cones, 2.5);
    parts.push({ geometry: "cone", size: [1.6, 2.2, 1.6], position: [x, 1.1, z], color: [0.85, 0.60, 0.25] });
    found.push("cone");
  }

  if (found.length === 0) {
    // Signature fallback scene so every prompt yields a real model.
    parts.push({ geometry: "sphere", size: [2.2, 2.2, 2.2], position: [0, 1.1, 0], color: palette.accent });
    parts.push({ geometry: "box", size: [1.4, 1.4, 1.4], position: [-2.6, 0.7, 1.2], rotation: [0, 0.5, 0], color: [0.35, 0.55, 0.75] });
    parts.push({ geometry: "cone", size: [1.8, 2.4, 1.8], position: [2.6, 1.2, -1.0], color: [0.85, 0.60, 0.25] });
    parts.push({ geometry: "cylinder", size: [1.0, 2.0, 1.0], position: [2.2, 1.0, 2.2], color: [0.60, 0.63, 0.68] });
    return { parts, label: "scene" };
  }
  return { parts, label: [...new Set(found)].join("+") };
}

// ---------------------------------------------------------------------------
// Geometry builders (flat float arrays + uint16 indices)
// ---------------------------------------------------------------------------

interface RawGeometry {
  positions: number[];
  normals: number[];
  indices: number[];
}

function boxGeometry(w: number, h: number, d: number): RawGeometry {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  // Six faces: [normal, four corners]
  const faces: Array<[[number, number, number], Array<[number, number, number]>]> = [
    [[0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]],
    [[0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]]],
    [[0, 1, 0], [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]]],
    [[0, -1, 0], [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]]],
    [[1, 0, 0], [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]]],
    [[-1, 0, 0], [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  faces.forEach(([normal, corners], face) => {
    const base = face * 4;
    for (const corner of corners) {
      positions.push(...corner);
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return { positions, normals, indices };
}

function cylinderGeometry(radiusTop: number, radiusBottom: number, height: number, segments = 18): RawGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const yTop = height / 2;
  const yBottom = -height / 2;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Side slope for the normal (cones tilt outward at the bottom).
    const slope = radiusBottom - radiusTop;
    const length = Math.hypot(height, slope) || 1;
    const normal: [number, number, number] = [cos * height / length, slope / length, sin * height / length];
    positions.push(cos * radiusTop, yTop, sin * radiusTop);
    normals.push(...normal);
    positions.push(cos * radiusBottom, yBottom, sin * radiusBottom);
    normals.push(...normal);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const addCap = (radius: number, y: number, up: boolean): void => {
    if (radius <= 1e-6) return;
    const centerIndex = positions.length / 3;
    positions.push(0, y, 0);
    normals.push(0, up ? 1 : -1, 0);
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      normals.push(0, up ? 1 : -1, 0);
    }
    for (let i = 0; i < segments; i++) {
      const ring = centerIndex + 1 + i;
      if (up) indices.push(centerIndex, ring + 1, ring);
      else indices.push(centerIndex, ring, ring + 1);
    }
  };
  addCap(radiusTop, yTop, true);
  addCap(radiusBottom, yBottom, false);
  return { positions, normals, indices };
}

function sphereGeometry(radius: number, widthSegments = 20, heightSegments = 14): RawGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= heightSegments; y++) {
    const v = y / heightSegments;
    const phi = v * Math.PI;
    for (let x = 0; x <= widthSegments; x++) {
      const u = x / widthSegments;
      const theta = u * Math.PI * 2;
      const nx = -Math.cos(theta) * Math.sin(phi);
      const ny = Math.cos(phi);
      const nz = Math.sin(theta) * Math.sin(phi);
      positions.push(nx * radius, ny * radius, nz * radius);
      normals.push(nx, ny, nz);
    }
  }
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * (widthSegments + 1) + x;
      const b = a + widthSegments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions, normals, indices };
}

function coneGeometry(radius: number, height: number, segments = 18): RawGeometry {
  return cylinderGeometry(0, radius, height, segments);
}

function geometryFor(part: ScenePart): RawGeometry {
  const [w, h, d] = part.size;
  switch (part.geometry) {
    case "box":
      return boxGeometry(w, h, d);
    case "cylinder":
      return cylinderGeometry(w / 2, d / 2, h);
    case "sphere":
      return sphereGeometry(w / 2);
    case "cone":
      return coneGeometry(Math.max(w, d) / 2, h);
  }
}

// ---------------------------------------------------------------------------
// GLB packing (glTF 2.0 binary, hand-written)
// ---------------------------------------------------------------------------

function eulerToQuaternion(rotation: [number, number, number]): [number, number, number, number] {
  const [rx, ry, rz] = rotation;
  const cx = Math.cos(rx / 2);
  const sx = Math.sin(rx / 2);
  const cy = Math.cos(ry / 2);
  const sy = Math.sin(ry / 2);
  const cz = Math.cos(rz / 2);
  const sz = Math.sin(rz / 2);
  // R = Rz * Ry * Rx (X first, then Y, then Z).
  return [
    sz * cy * cx - cz * sy * sx,
    cz * sy * cx + sz * cy * sx,
    cz * cy * sx - sz * sy * cx,
    cz * cy * cx + sz * sy * sx,
  ];
}

/** Pack the scene into a binary glTF (.glb) buffer. */
export function buildGlb(scene: ProceduralScene): Buffer {
  const buffers: Buffer[] = [];
  const bufferViews: Array<Record<string, unknown>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const meshes: Array<Record<string, unknown>> = [];
  const materials: Array<Record<string, unknown>> = [];
  const nodes: Array<Record<string, unknown>> = [];
  let byteOffset = 0;

  const pushView = (data: Buffer, target: number, onChunk: (viewIndex: number) => void): void => {
    const pad = (4 - (data.length % 4)) % 4;
    const padded = Buffer.concat([data, Buffer.alloc(pad)]);
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length, target });
    onChunk(viewIndex);
    buffers.push(padded);
    byteOffset += padded.length;
  };

  scene.parts.forEach((part) => {
    const geometry = geometryFor(part);
    const positionArray = new Float32Array(geometry.positions);
    const normalArray = new Float32Array(geometry.normals);
    const indexArray = new Uint16Array(geometry.indices);

    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positionArray.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = positionArray[i + axis] as number;
        const lo = min[axis] as number;
        const hi = max[axis] as number;
        if (value < lo) min[axis] = value;
        if (value > hi) max[axis] = value;
      }
    }

    let positionAccessor = 0;
    let normalAccessor = 0;
    let indexAccessor = 0;
    pushView(Buffer.from(positionArray.buffer, positionArray.byteOffset, positionArray.byteLength), 34962, (view) => {
      positionAccessor = accessors.length;
      accessors.push({ bufferView: view, componentType: 5126, count: positionArray.length / 3, type: "VEC3", min, max });
    });
    pushView(Buffer.from(normalArray.buffer, normalArray.byteOffset, normalArray.byteLength), 34962, (view) => {
      normalAccessor = accessors.length;
      accessors.push({ bufferView: view, componentType: 5126, count: normalArray.length / 3, type: "VEC3" });
    });
    pushView(Buffer.from(indexArray.buffer, indexArray.byteOffset, indexArray.byteLength), 34963, (view) => {
      indexAccessor = accessors.length;
      accessors.push({ bufferView: view, componentType: 5123, count: indexArray.length, type: "SCALAR" });
    });

    meshes.push({ primitives: [{ attributes: { POSITION: positionAccessor, NORMAL: normalAccessor }, indices: indexAccessor, material: materials.length }] });
    materials.push({
      pbrMetallicRoughness: { baseColorFactor: [...part.color, 1], metallicFactor: 0.05, roughnessFactor: 0.85 },
      doubleSided: true,
    });
    const node: Record<string, unknown> = { mesh: nodes.length, translation: part.position };
    if (part.rotation) node.rotation = eulerToQuaternion(part.rotation);
    nodes.push(node);
  });

  const binLength = byteOffset;
  const gltf = {
    asset: { version: "2.0", generator: "Loam procedural 3D" },
    scene: 0,
    scenes: [{ name: scene.label, nodes: nodes.map((_node, index) => index) }],
    nodes,
    meshes,
    materials,
    buffers: [{ byteLength: binLength }],
    bufferViews,
    accessors,
  };

  const jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const totalLength = 12 + 8 + jsonChunk.length + (binLength > 0 ? 8 + byteOffset : 0);

  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  const chunks: Buffer[] = [header, jsonHeader, jsonChunk];
  if (binLength > 0) {
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(byteOffset, 0);
    binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"
    chunks.push(binHeader, ...buffers);
  }
  return Buffer.concat(chunks);
}

/** Triangle count of a scene (for tool reporting and tests). */
export function sceneTriangles(scene: ProceduralScene): number {
  return scene.parts.reduce((acc, part) => acc + geometryFor(part).indices.length / 3, 0);
}
