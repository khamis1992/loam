const fs = require('node:fs');
const path = require('node:path');

function refuseSharedLink(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return;
  }
  if (stat.nlink > 1) throw new Error('Symbolic links are not allowed');
}

function resolveFile(rootDirectory, name, extension) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) throw new Error('Invalid file name');
  if (extension && path.extname(name).toLowerCase() !== extension) throw new Error(`Expected a ${extension} file`);
  const root = path.resolve(rootDirectory);
  const absolute = path.resolve(root, name);
  if (path.dirname(absolute) !== root) throw new Error('File is outside the app workspace');
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Symbolic links are not allowed');
  refuseSharedLink(absolute);
  return absolute;
}

function readJson(file, fallback) {
  refuseSharedLink(file);
  if (!fs.existsSync(file)) return fallback;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid local data');
  return parsed;
}

function writeJsonAtomic(file, value) {
  refuseSharedLink(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

const REMOTE_SCHEME = /(?<![A-Za-z])(?:mailto|tel|sms|intent|market|https|http|javascript|data|file|blob)\s*:|(?:^|[^:])\/\//i;

function decodePercent(value) {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function collapseQuotePlus(value) {
  let current = value;
  let previous = '';
  while (current !== previous) {
    previous = current;
    current = current.replace(/['"]\s*\+\s*['"]/g, '');
  }
  return current;
}

function schemeForms(value) {
  const collapsed = collapseQuotePlus(value);
  const opened = collapsed.replace(/['"]/g, '').replace(/\+/g, '');
  const forms = [value];
  if (collapsed !== value) forms.push(collapsed);
  if (opened !== value && opened !== collapsed) forms.push(opened);
  return forms;
}

function formIsRemote(value) {
  return schemeForms(value).some((form) => REMOTE_SCHEME.test(form));
}

function remoteText(value) {
  if (formIsRemote(value)) return true;
  const decoded = decodePercent(value);
  if (decoded !== value && formIsRemote(decoded)) return true;
  const decodedCollapsed = decodePercent(collapseQuotePlus(value));
  return decodedCollapsed !== value && decodedCollapsed !== decoded && formIsRemote(decodedCollapsed);
}

function text(value, label, max = 80) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > max) throw new Error(`Invalid ${label}`);
  if (remoteText(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

module.exports = { resolveFile, readJson, writeJsonAtomic, text };
