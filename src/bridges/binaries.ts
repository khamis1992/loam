import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface PinnedBinary {
  id: string; version: string; tarball: string;
  integrity: string;
  tgzSha256: string;
  entry: string;
  exeSha256: string;
  license: string; notice: string;
}

export const PINNED: Record<string, PinnedBinary> = {
  wakaru: {
    id: "wakaru", version: "1.14.0",
    tarball: "https://registry.npmjs.org/@wakaru/cli-win32-x64/-/cli-win32-x64-1.14.0.tgz",
    integrity: "sha512-eKZflccawVg0oLcYExgk8mpnjm+Da6ypHmURa9TkG9b1/sL8leEGHa4Vkuj2fw3xLs4M9oHDLe5pmzTZ4Qy1eQ==",
    tgzSha256: "cdc214535604de220b7185ae9ef58368a6829f946623a521b11cfe6da0bb97d4",
    entry: "package/wakaru.exe",
    exeSha256: "fc3f8df191bb22710bcd34ef7d12f85369c9062ee565f78790cdc99822420064",
    license: "Apache-2.0",
    notice: "wakaru © Pionxzh and contributors, Apache License 2.0, https://github.com/pionxzh/wakaru",
  },
};

export function dataDir(): string {
  return process.env.LOAM_DATA_DIR || path.join(process.cwd(), ".loam-data");
}

export function binaryPath(b: PinnedBinary): string {
  return path.join(dataDir(), "bin", b.id, b.version, path.basename(b.entry));
}

const sha256 = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");

export function extractTarEntry(tar: Buffer, wanted: string): Buffer | null {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return null;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const start = off + 512;
    if (full === wanted && (type === "0" || type === "\0")) return Buffer.from(tar.subarray(start, start + size));
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

export function verifyInstalled(b: PinnedBinary): boolean {
  try { return sha256(fs.readFileSync(binaryPath(b))) === b.exeSha256; } catch { return false; }
}

export async function installPinned(
  id: string,
  opts: { signal?: AbortSignal; fetcher?: typeof fetch; body?: Buffer } = {},
): Promise<string> {
  const b = PINNED[id];
  if (!b) throw new Error(`unknown binary ${id}`);
  const dest = binaryPath(b);
  if (fs.existsSync(dest) && verifyInstalled(b)) return dest;
  let body: Buffer;
  if (opts.body) body = opts.body;
  else {
    const fetcher = opts.fetcher ?? fetch;
    const res = await fetcher(b.tarball, { signal: opts.signal });
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  }
  const sri = `sha512-${crypto.createHash("sha512").update(body).digest("base64")}`;
  if (sri !== b.integrity) throw new Error(`${id}: npm integrity mismatch`);
  if (sha256(body) !== b.tgzSha256) throw new Error(`${id}: tarball sha256 mismatch`);
  const exe = extractTarEntry(zlib.gunzipSync(body), b.entry);
  if (!exe) throw new Error(`${id}: ${b.entry} not found in tarball`);
  if (sha256(exe) !== b.exeSha256) throw new Error(`${id}: executable sha256 mismatch`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${crypto.randomUUID()}.part`;
  fs.writeFileSync(tmp, exe, { mode: 0o755 });
  fs.renameSync(tmp, dest);
  fs.writeFileSync(path.join(path.dirname(dest), "NOTICE.txt"), `${b.notice}\n`, "utf8");
  return dest;
}

/** Re-verify before every launch. */
export function assertWakaruReady(): string {
  const b = PINNED.wakaru!;
  if (!verifyInstalled(b)) throw new Error("wakaru_not_installed_or_tampered");
  return binaryPath(b);
}
