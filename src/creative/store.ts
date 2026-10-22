import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { taskPath } from "../server/taskWorkspace.js";

export type Vector3 = [number, number, number];
export type CreativeNode = {
  id: string; name: string; type: "box" | "sphere" | "cylinder" | "torus" | "plane" | "cone" | "model";
  position: Vector3; rotation: Vector3; scale: Vector3;
  material: { color: string; metalness: number; roughness: number };
  visible: boolean; asset?: string; spin: number;
};
export type Scene = {
  version: 1; title: string; revision: number; nodes: CreativeNode[];
  environment: { background: string; lightIntensity: number; exposure: number; grid: boolean };
  camera: { position: Vector3; target: Vector3; fov: number }; duration: number;
};
export class CreativeError extends Error {
  constructor(message: string, public status = 400, public scene?: Scene | null) { super(message); }
}
const fail = (message: string): never => { throw new CreativeError(message); };
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("Expected an object");
  return v as Record<string, unknown>;
}
function number(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return fail(`Expected a finite number between ${min} and ${max}`);
  return v;
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) return fail(`Expected nonempty text up to ${max} characters`);
  return v;
}
function color(v: unknown): string { if (typeof v !== "string" || !/^#[a-f\d]{6}$/i.test(v)) return fail("Expected a six-digit hex color"); return v; }
function bool(v: unknown): boolean { if (typeof v !== "boolean") return fail("Expected a boolean"); return v; }
function vector(v: unknown, min = -10000, max = 10000): Vector3 {
  if (!Array.isArray(v) || v.length !== 3) return fail("Expected a three-component vector");
  return v.map(n => number(n, min, max)) as Vector3;
}
export const MAX_GLB_BYTES = 25 * 1024 * 1024;
/** Accept self-contained GLB 2.0 only; loaders must never fetch external resources. */
export function validateGlb(buffer: Buffer): void {
  if (buffer.length < 20 || buffer.length > MAX_GLB_BYTES || buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) fail("Invalid GLB 2.0 header or size (maximum 25 MB)");
  let offset = 12, chunks = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) fail("Truncated GLB chunk");
    const length = buffer.readUInt32LE(offset), type = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 || offset + length > buffer.length) fail("Invalid GLB chunk length");
    if (chunks === 0) {
      if (type !== 0x4e4f534a) fail("GLB must start with a JSON chunk");
      let json: unknown;
      try { json = JSON.parse(buffer.subarray(offset, offset + length).toString("utf8")); } catch { fail("Invalid GLB JSON"); }
      const root = object(json), asset = object(root.asset);
      if (asset.version !== "2.0") fail("GLB asset must use glTF 2.0");
      const stack: unknown[] = [root];
      while (stack.length) {
        const current = stack.pop();
        if (current && typeof current === "object") for (const [key, value] of Object.entries(current)) {
          if (key === "uri" && (typeof value !== "string" || !/^data:(?:image\/(?:png|jpeg|webp)|application\/octet-stream);base64,[a-z\d+/=]*$/i.test(value))) fail("External GLB resource URIs are not allowed");
          if (value && typeof value === "object") stack.push(value);
        }
      }
    } else if (chunks !== 1 || type !== 0x004e4942) fail("Unsupported GLB chunk");
    offset += length; chunks++;
  }
}
export function validateGlbAsset(workspace: string, asset: string): string {
  if (!/\.glb$/i.test(asset) || /[:\\]/.test(asset) || asset.startsWith("/") || asset.split("/").some(p => !p || p === "." || p === "..")) fail("Asset must be a task-relative GLB path");
  let file: string;
  try { file = taskPath(workspace, asset); } catch { return fail("Asset path is outside the task or contains links"); }
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return fail("GLB asset does not exist"); }
  if (!stat.isFile() || stat.size > MAX_GLB_BYTES) fail("GLB asset must be a file of at most 25 MB");
  validateGlb(fs.readFileSync(file));
  return file;
}
export function validateScene(input: unknown, workspace?: string): Omit<Scene, "revision"> {
  const v = object(input), environment = object(v.environment), camera = object(v.camera);
  if (v.version !== 1) fail("Unsupported scene version");
  if (!Array.isArray(v.nodes) || v.nodes.length > 200) fail("A scene supports at most 200 nodes");
  const ids = new Set<string>();
  const nodes = (v.nodes as unknown[]).map(item => {
    const n = object(item), m = object(n.material), id = text(n.id, 100);
    if (!/^[a-z\d_-]+$/i.test(id) || ids.has(id)) fail("Node IDs must be safe and unique");
    ids.add(id);
    if (!["box", "sphere", "cylinder", "torus", "plane", "cone", "model"].includes(String(n.type))) fail("Invalid node type");
    let asset: string | undefined;
    if (n.type === "model") {
      asset = text(n.asset, 400);
      if (!/\.glb$/i.test(asset) || /[:\\]/.test(asset) || asset.startsWith("/") || asset.split("/").some(p => !p || p === "." || p === "..")) fail("Invalid GLB asset path");
      if (workspace) validateGlbAsset(workspace, asset);
    } else if (n.asset !== undefined) fail("Only model nodes may reference an asset");
    return { id, name: text(n.name, 200), type: n.type as CreativeNode["type"], position: vector(n.position), rotation: vector(n.rotation, -1000, 1000), scale: vector(n.scale, .01, 100), material: { color: color(m.color), metalness: number(m.metalness, 0, 1), roughness: number(m.roughness, 0, 1) }, visible: bool(n.visible), spin: number(n.spin, -20, 20), ...(asset ? { asset } : {}) };
  });
  return { version: 1, title: text(v.title, 300), nodes, environment: { background: color(environment.background), lightIntensity: number(environment.lightIntensity, 0, 10), exposure: number(environment.exposure, .1, 5), grid: bool(environment.grid) }, camera: { position: vector(camera.position), target: vector(camera.target), fov: number(camera.fov, 20, 100) }, duration: number(v.duration, 1, 60) };
}
export function readScene(workspace: string): Scene | null {
  const file = taskPath(workspace, ".loam/creative.json");
  if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size > 1_000_000) fail("Scene exceeds 1 MB");
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fail("Saved scene JSON is invalid"); }
  const value = object(parsed);
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) fail("Invalid saved revision");
  return { ...validateScene(value, workspace), revision: Number(value.revision) };
}
/** Synchronous compare/rename prevents interleaved HTTP and tool writes in this process. */
export function saveScene(workspace: string, input: unknown, expectedRevision: unknown): Scene {
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) fail("expectedRevision must be a nonnegative integer");
  const clean = validateScene(input, workspace), current = readScene(workspace);
  if ((current?.revision ?? 0) !== expectedRevision) throw new CreativeError("Scene changed. Reload the latest revision before saving.", 409, current);
  const scene: Scene = { ...clean, revision: Number(expectedRevision) + 1 };
  const file = taskPath(workspace, ".loam/creative.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = taskPath(workspace, `.loam/creative-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(scene), { flag: "wx", encoding: "utf8" }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return scene;
}
