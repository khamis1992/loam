const fs = require('node:fs');
const path = require('node:path');

const REMOTE_MARKS = ['mailto', 'tel', 'sms', 'intent', 'market', 'https', 'javascript', '//'];

function decodePercentOnce(value) {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function tagIsRemote(value) {
  const decoded = decodePercentOnce(value);
  const forms = decoded === value ? [value] : [value, decoded];
  return forms.some((form) => {
    const lower = form.toLowerCase();
    return REMOTE_MARKS.some((mark) => lower.includes(mark));
  });
}

function createFileStore(rootDirectory, ipcMain) {
  const root = path.resolve(rootDirectory);
  const tagsPath = path.join(root, '.loam-tags.json');
  fs.mkdirSync(root, { recursive: true });

  function readTags() {
    if (!fs.existsSync(tagsPath)) return {};
    const stat = tagsStat();
    if (stat && stat.nlink > 1) throw new Error('unsafe_path');
    const parsed = JSON.parse(fs.readFileSync(tagsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid tag store');
    return parsed;
  }

  function tagsStat() {
    try {
      return fs.lstatSync(tagsPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      return null;
    }
  }

  function listFiles(filters = {}) {
    const query = String(filters.query ?? '').trim().toLowerCase();
    const tag = String(filters.tag ?? '').trim().toLowerCase();
    const tags = readTags();
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.loam-'))
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => {
        const absolute = path.join(root, entry.name);
        const stat = fs.statSync(absolute);
        return { name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString(), tags: Array.isArray(tags[entry.name]) ? tags[entry.name] : [] };
      })
      .filter((file) => !query || file.name.toLowerCase().includes(query))
      .filter((file) => !tag || file.tags.some((value) => value.toLowerCase() === tag))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function addTag(name, value) {
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw new Error('Invalid file name');
    const file = path.resolve(root, name);
    if (path.dirname(file) !== root || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('File not found');
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized.length > 24 || normalized.startsWith('.loam-') || tagIsRemote(normalized)) throw new Error('Invalid tag');
    const tags = readTags();
    const current = Array.isArray(tags[name]) ? tags[name] : [];
    if (!current.includes(normalized)) current.push(normalized);
    tags[name] = current;
    const stat = tagsStat();
    if (stat && stat.nlink > 1) throw new Error('unsafe_path');
    fs.writeFileSync(tagsPath, JSON.stringify(tags, null, 2));
    return listFiles();
  }

  ipcMain?.handle('files:list', (_event, filters) => listFiles(filters));
  ipcMain?.handle('files:add-tag', (_event, name, value) => addTag(name, value));
  return { listFiles, addTag };
}

module.exports = { createFileStore };
