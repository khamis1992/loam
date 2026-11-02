import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newId(prefix = ""): string {
  const time = Date.now();
  let n = time;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[n % 32]! + timePart;
    n = Math.floor(n / 32);
  }
  const rand = randomBytes(10);
  let randPart = "";
  for (const byte of rand) randPart += CROCKFORD[byte % 32];
  return `${prefix}${timePart}${randPart}`;
}

export function contentHash(scope: string, content: string): string {
  return createHash("sha1").update(`${scope}\n${content}`).digest("hex");
}

export function toUnit(values: number[] | Float32Array): Float32Array {
  const out = values instanceof Float32Array ? Float32Array.from(values) : Float32Array.from(values);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += (out[i] ?? 0) * (out[i] ?? 0);
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function float32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToFloat32(raw: unknown): Float32Array | undefined {
  if (raw == null) return undefined;
  const bytes = raw instanceof Uint8Array ? raw : Buffer.isBuffer(raw) ? raw : undefined;
  if (!bytes || bytes.byteLength < 4) return undefined;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

export function projectScope(workspacePath: string): string {
  return `project:${createHash("sha1").update(workspacePath).digest("hex")}`;
}
