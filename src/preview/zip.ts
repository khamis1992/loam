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
export function zipBuffer(entries: readonly ZipEntry[], now = new Date()): Buffer {
  const cleaned = entries.map((e) => ({ name: e.name.replace(/\\/g, "/").replace(/^\/+/, ""), data: e.data }));
  if (cleaned.some((e) => e.name.length === 0 || e.name.length > 500)) {
    throw new Error("zip: invalid entry name length");
  }
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
