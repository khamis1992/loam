const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { resolveFile } = require('./helpers.cjs');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function png(red, green, blue) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, red, green, blue]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ensurePhotoFixtures(rootDirectory) {
  fs.mkdirSync(rootDirectory, { recursive: true });
  const red = png(24, 118, 101);
  for (const [name, bytes] of [['loam-green.png', red], ['loam-green-copy.png', red], ['loam-blue.png', png(0, 129, 242)]]) {
    const file = path.join(rootDirectory, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function readStat(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertRealDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Symbolic links are not allowed');
  return stat;
}

function relativeToRoot(root, target) {
  return path.relative(fs.realpathSync(root), fs.realpathSync(target));
}

function assertInsideSorted(root, target, directory) {
  const relative = relativeToRoot(root, target);
  const parts = relative.split(path.sep).filter((part) => part && part !== '.');
  const folder = process.platform === 'win32' ? (parts[0] ?? '').toLowerCase() : (parts[0] ?? '');
  const escaped = !relative || relative.startsWith('..') || path.isAbsolute(relative) || folder !== 'sorted';
  if (directory) {
    if (escaped || parts.length !== 1) throw new Error('File is outside the app workspace');
    return;
  }
  if (escaped || parts.length !== 2 || parts[1] === '..') throw new Error('File is outside the app workspace');
}

function assertCopySource(root, source) {
  const stat = readStat(source);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error('Symbolic links are not allowed');
  const relative = relativeToRoot(root, source);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('Symbolic links are not allowed');
  }
}

function createPhotoStore(rootDirectory, ipcMain) {
  ensurePhotoFixtures(rootDirectory);

  function scan() {
    const seen = new Map();
    return fs.readdirSync(rootDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.(?:png|jpe?g)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .map((name) => {
        const file = resolveFile(rootDirectory, name);
        const bytes = fs.readFileSync(file);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const duplicateOf = seen.get(sha256) ?? null;
        if (!seen.has(sha256)) seen.set(sha256, name);
        return { name, size: bytes.length, sha256, duplicateOf };
      });
  }

  function sort() {
    const root = path.resolve(rootDirectory);
    assertRealDirectory(root);
    const files = scan();
    const destination = path.join(root, 'sorted');
    const existing = readStat(destination);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('Symbolic links are not allowed');
    } else {
      fs.mkdirSync(destination);
    }
    assertRealDirectory(destination);
    assertInsideSorted(root, destination, true);
    for (const file of files) {
      const source = resolveFile(root, file.name);
      assertCopySource(root, source);
      const target = resolveFile(destination, `${file.sha256.slice(0, 10)}-${file.name}`);
      if (!samePath(path.dirname(target), destination)) throw new Error('File is outside the app workspace');
      assertRealDirectory(destination);
      assertInsideSorted(root, destination, true);
      const targetStat = readStat(target);
      if (targetStat) {
        if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink > 1) throw new Error('Symbolic links are not allowed');
      } else {
        assertCopySource(root, source);
        const latest = readStat(target);
        if (latest) {
          if (latest.isSymbolicLink() || !latest.isFile() || latest.nlink > 1) throw new Error('Symbolic links are not allowed');
        } else {
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        }
      }
      const written = readStat(target);
      if (!written || written.isSymbolicLink() || !written.isFile() || written.nlink > 1) throw new Error('Symbolic links are not allowed');
      assertInsideSorted(root, target, false);
    }
    return { files, sortedCount: files.length };
  }

  ipcMain?.handle('photos:scan', () => scan());
  ipcMain?.handle('photos:sort', () => sort());
  return { scan, sort };
}

module.exports = { createPhotoStore, ensurePhotoFixtures, png };
