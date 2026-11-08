import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Minimal original ZIP writer (deflate + stored entries) used to package
 * build outputs. No external dependency: the archive layout follows the
 * public PKWARE APPNOTE structure (local headers, central directory, EOCD).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31),
    date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
  };
}

export interface ZipEntry {
  /** Archive path with forward slashes, no leading slash. */
  name: string;
  data: Buffer;
}

/** Compress ordered entries into a single ZIP archive buffer (deflate, no AES/zip64). */
function archiveName(name: string): string {
  const slashed = name.replace(/\\/g, "/");
  const parts = slashed.split("/");
  if (
    slashed.startsWith("/")
    || /^[A-Za-z]:/.test(slashed)
    || slashed.length === 0
    || slashed.length > 500
    || parts.some((part) => part.length === 0 || part === "." || part === ".." || part.includes(":"))
  ) {
    throw new Error("zip: unsafe entry name");
  }
  return slashed;
}

export function zipBuffer(entries: readonly ZipEntry[], now = new Date()): Buffer {
  const cleaned = entries.map((e) => ({ name: archiveName(e.name), data: e.data }));
  const { time, date } = dosTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of cleaned) {
    const crc = crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data, { level: 6 });
    const useDeflate = deflated.length < entry.data.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : entry.data;
    const nameBytes = Buffer.from(entry.name, "utf8");

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cleaned.length, 8);
  eocd.writeUInt16LE(cleaned.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

export interface ZipCollector {
  filter?: (rel: string) => boolean;
}

/** Collect regular files under a directory (symlinks skipped, mirroring preview listing). */
export function collectFiles(root: string, opts: ZipCollector = {}): ZipEntry[] {
  const base = path.resolve(root);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error(`zip: not a directory: ${base}`);
  }
  const entries: ZipEntry[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isSymbolicLink()) continue;
      const child = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(child, childRel);
        continue;
      }
      if (!item.isFile()) continue;
      if (opts.filter && !opts.filter(childRel)) continue;
      entries.push({ name: childRel, data: fs.readFileSync(child) });
    }
  };
  walk(base, "");
  return entries;
}

/** Zip an entire directory tree (files only, forward-slash archive paths). */
export function zipDirectory(root: string, opts: ZipCollector = {}): Buffer {
  return zipBuffer(collectFiles(root, opts));
}

const MAX_EXTRACT_ENTRIES = 5_000;
const MAX_EXTRACT_BYTES = 100_000_000;

/** Unpack a ZIP into dest. Names must stay inside dest, and nothing is executed. */
export function extractZip(bytes: Buffer, dest: string): string[] {
  const rootStat = fs.existsSync(dest) ? fs.lstatSync(dest) : undefined;
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("zip: unsafe entry name");
  const root = fs.realpathSync(dest);
  const entries = readStoredEntries(bytes);
  const names = entries.map((entry) => {
    const name = archiveName(entry.name);
    if (deniedZipPart(name)) throw new Error("zip: unsafe entry name");
    return name;
  });
  entries.forEach((entry, index) => {
    const target = path.resolve(root, ...names[index]!.split("/"));
    assertInside(root, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    assertInside(root, target);
    fs.writeFileSync(target, entry.data);
  });
  return names;
}

function deniedZipPart(name: string): boolean {
  return name.split("/").some((part) => part === "node_modules" || part === ".git" || part === ".loam" || part === "credentials.json" || part.startsWith(".env"));
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("zip: unsafe entry name");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("zip: unsafe entry name");
  }
}

function readStoredEntries(bytes: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  let total = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (entries.length >= MAX_EXTRACT_ENTRIES) throw new Error("zip: unsafe entry name");
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const compressed = bytes.readUInt32LE(offset + 18);
    const uncompressed = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if ((flags & 0x8) !== 0 || (method !== 0 && method !== 8)) throw new Error("zip: unsafe entry name");
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    if (start + compressed > bytes.length) throw new Error("zip: unsafe entry name");
    const body = bytes.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body);
    if (data.length !== uncompressed) throw new Error("zip: unsafe entry name");
    total += data.length;
    if (total > MAX_EXTRACT_BYTES) throw new Error("zip: unsafe entry name");
    entries.push({ name, data });
    offset = start + compressed;
  }
  if (entries.length === 0) throw new Error("zip: unsafe entry name");
  return entries;
}

/** Names stored in the central directory. Unsafe paths and zip64 are refused. */
export function zipEntryNames(bytes: Buffer): string[] {
  const marker = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = bytes.lastIndexOf(marker);
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error("zip: unsafe entry name");
  const count = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || cursor === 0xffffffff) throw new Error("zip: unsafe entry name");
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("zip: unsafe entry name");
    const nameLen = bytes.readUInt16LE(cursor + 28);
    const extraLen = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLen + extraLen + commentLen;
    if (end > bytes.length) throw new Error("zip: unsafe entry name");
    names.push(archiveName(bytes.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8")));
    cursor = end;
  }
  return names;
}
