const fs = require('node:fs');
const path = require('node:path');

const MAX_NOTES_BYTES = 64 * 1024;
const NOTES_NAME = 'notes.txt';

function notesRoot(rootDirectory) {
  const root = path.resolve(rootDirectory);
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe_path');
  } else {
    fs.mkdirSync(root, { recursive: true });
  }
  const real = fs.realpathSync(root);
  const left = process.platform === 'win32' ? real.toLowerCase() : real;
  const right = process.platform === 'win32' ? root.toLowerCase() : root;
  if (left !== right) throw new Error('unsafe_path');
  return root;
}

function notesPath(rootDirectory) {
  const root = notesRoot(rootDirectory);
  const file = path.resolve(root, NOTES_NAME);
  if (path.dirname(file) !== root) throw new Error('unsafe_path');
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
    if (stat.size > MAX_NOTES_BYTES) throw new Error('notes_too_large');
  }
  return file;
}

function loadNotes(rootDirectory) {
  const file = notesPath(rootDirectory);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

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

const REMOTE_SCHEME = /https?:\/\/|javascript:|data:|file:|blob:|mailto:|tel:|sms:|intent:|market:|(^|[^:])\/\//i;

function formIsRemote(value) {
  const forms = remoteForms(value);
  for (let index = 0; index < forms.length; index += 1) {
    if (REMOTE_SCHEME.test(forms[index])) return true;
  }
  return false;
}

function remoteNotes(text) {
  let pending = [text];
  const seen = new Set();
  for (let depth = 0; depth <= 2; depth += 1) {
    const layer = pending;
    pending = [];
    for (let index = 0; index < layer.length; index += 1) {
      const value = layer[index];
      if (seen.has(value)) continue;
      seen.add(value);
      if (formIsRemote(value)) return true;
      if (depth >= 2) continue;
      const decoded = decodePercent(value);
      if (decoded !== value) pending.push(decoded);
      const decodedCollapsed = decodePercent(collapseQuotePlus(value));
      if (decodedCollapsed !== value && decodedCollapsed !== decoded) pending.push(decodedCollapsed);
    }
  }
  return false;
}

function saveNotes(rootDirectory, text) {
  if (typeof text !== 'string') throw new Error('invalid_request');
  if (Buffer.byteLength(text, 'utf8') > MAX_NOTES_BYTES) throw new Error('notes_too_large');
  const file = notesPath(rootDirectory);
  if (remoteNotes(text)) throw new Error('unsafe_path');
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  return text;
}

function registerNotes(rootDirectory, ipcMain) {
  ipcMain?.handle('notes:load', () => loadNotes(rootDirectory));
  ipcMain?.handle('notes:save', (_event, text) => saveNotes(rootDirectory, text));
}

module.exports = { MAX_NOTES_BYTES, loadNotes, saveNotes, registerNotes };
