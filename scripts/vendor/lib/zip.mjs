import { deflateRawSync, inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function readUInt64LE(buf, offset) {
  const lo = buf.readUInt32LE(offset);
  const hi = buf.readUInt32LE(offset + 4);
  return hi * 0x100000000 + lo;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readCentralDirectory(buf, cdOffset, entryCount) {
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error(`zip: bad central directory entry at ${p}`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (
      compressedSize === ZIP64 ||
      uncompressedSize === ZIP64 ||
      localOffset === ZIP64
    ) {
      let q = p + 46 + nameLen;
      const extraEnd = q + extraLen;
      if (uncompressedSize === ZIP64 && q + 8 <= extraEnd) {
        uncompressedSize = readUInt64LE(buf, q);
        q += 8;
      }
      if (compressedSize === ZIP64 && q + 8 <= extraEnd) {
        compressedSize = readUInt64LE(buf, q);
        q += 8;
      }
      if (localOffset === ZIP64 && q + 8 <= extraEnd) {
        localOffset = readUInt64LE(buf, q);
        q += 8;
      }
    }
    entries.push({ flags, method, crc, compressedSize, uncompressedSize, name, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let entryCount = buf.readUInt16LE(eocd + 10);
  if (cdOffset === ZIP64 || entryCount === 0xffff) {
    for (let i = eocd - 20; i >= Math.max(0, eocd - 21); i--) {
      if (buf.readUInt32LE(i) !== EOCD64_LOCATOR_SIG) continue;
      const eocd64Offset = readUInt64LE(buf, i + 8);
      if (buf.readUInt32LE(eocd64Offset) !== EOCD64_SIG) continue;
      cdOffset = readUInt64LE(buf, eocd64Offset + 40);
      entryCount = readUInt64LE(buf, eocd64Offset + 32);
      break;
    }
  }
  if (typeof cdOffset !== 'number' || cdOffset >= buf.length) {
    throw new Error('zip: central directory offset out of range');
  }
  return readCentralDirectory(buf, cdOffset, entryCount);
}

function safeEntryName(name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  const segments = normalized.split('/');
  return !segments.includes('..');
}

function inflateEntry(buf, entry) {
  if (entry.localOffset + 30 > buf.length || buf.readUInt32LE(entry.localOffset) !== LOCAL_SIG) {
    throw new Error(`zip: bad local header for "${entry.name}"`);
  }
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error(`zip: truncated data for "${entry.name}"`);
  const raw = buf.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`zip: unsupported compression method ${entry.method} for "${entry.name}"`);
}

/**
 * Extract a zip archive into destDir. Handles stored and deflated entries plus
 * the zip64 size/offset extensions. Rejects path-traversal entries.
 */
export function extractZip(buf, destDir) {
  const entries = readEntries(buf);
  const extracted = [];
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (!safeEntryName(name)) throw new Error(`zip: unsafe entry name "${entry.name}"`);
    const target = path.resolve(destDir, name);
    if (!target.startsWith(path.resolve(destDir) + path.sep) && target !== path.resolve(destDir)) {
      throw new Error(`zip: entry escapes destination "${entry.name}"`);
    }
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const data = inflateEntry(buf, entry);
    const actualCrc = crc32(data);
    if (actualCrc !== entry.crc) {
      throw new Error(`zip: crc mismatch for "${entry.name}" (expected ${entry.crc}, got ${actualCrc})`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    extracted.push({ name, size: data.length });
  }
  return extracted;
}

/** Build an in-memory zip (stored entries) — used by the vendoring tests. */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const cdOffset = offset;
  const cdSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
