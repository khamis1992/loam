const fs = require('node:fs');
const path = require('node:path');
const { resolveFile } = require('./helpers.cjs');

const REMOTE_SCHEME = /https?:\/\/|javascript:|data:|file:|blob:|mailto:|tel:|sms:|intent:|market:|(^|[^:])\/\//i;

function decodePercent(value) {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function collapseQuotePlus(value) {
  let current = value;
  let previous;
  do {
    previous = current;
    current = current.replace(/['"]\s*\+\s*['"]/g, '');
  } while (current !== previous);
  return current;
}

function remoteForms(value) {
  const collapsed = collapseQuotePlus(value);
  const opened = collapsed.replace(/['"]/g, '').replace(/\+/g, '');
  const forms = [value];
  if (collapsed !== value) forms.push(collapsed);
  if (opened !== value && opened !== collapsed) forms.push(opened);
  return forms;
}

function formIsRemote(value) {
  const forms = remoteForms(value);
  for (let index = 0; index < forms.length; index += 1) {
    if (REMOTE_SCHEME.test(forms[index])) return true;
  }
  return false;
}

function remoteMarkdown(text) {
  let pending = [text];
  const seen = new Set();
  for (let depth = 0; depth <= 1; depth += 1) {
    const layer = pending;
    pending = [];
    for (let index = 0; index < layer.length; index += 1) {
      const value = layer[index];
      if (seen.has(value)) continue;
      seen.add(value);
      if (formIsRemote(value)) return true;
      if (depth >= 1) continue;
      const decoded = decodePercent(value);
      if (decoded !== value) pending.push(decoded);
      const decodedCollapsed = decodePercent(collapseQuotePlus(value));
      if (decodedCollapsed !== value && decodedCollapsed !== decoded) pending.push(decodedCollapsed);
    }
  }
  return false;
}

function refuseSharedMarkdown(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return;
  }
  if (stat.isFile() && stat.nlink > 1) throw new Error('Hard links are not allowed');
}

function createMarkdownStore(rootDirectory, ipcMain) {
  fs.mkdirSync(rootDirectory, { recursive: true });

  function list() {
    return fs.readdirSync(rootDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
  }

  function read(name) {
    const file = resolveFile(rootDirectory, name, '.md');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Document not found');
    if (fs.statSync(file).size > 1_000_000) throw new Error('Document is too large');
    return { name, content: fs.readFileSync(file, 'utf8') };
  }

  function write(name, content) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1_000_000) throw new Error('Document is too large');
    if (typeof name === 'string' && path.extname(name).toLowerCase() === '.md' && !name.includes('/') && !name.includes('\\') && !name.includes('\0')) {
      const root = path.resolve(rootDirectory);
      const candidate = path.resolve(root, name);
      if (path.dirname(candidate) === root) refuseSharedMarkdown(candidate);
    }
    const file = resolveFile(rootDirectory, name, '.md');
    if (remoteMarkdown(content)) throw new Error('Remote content is not allowed');
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, file);
    return read(name);
  }

  ipcMain?.handle('markdown:list', () => list());
  ipcMain?.handle('markdown:read', (_event, name) => read(name));
  ipcMain?.handle('markdown:write', (_event, name, content) => write(name, content));
  return { list, read, write };
}

module.exports = { createMarkdownStore };
