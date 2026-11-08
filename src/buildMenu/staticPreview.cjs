'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { installsPackage } = require('./notebooks/installGuard.cjs');

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}
const port = Number(flag('--port'));
const file = flag('--file');
const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase() : false;
if (invokedDirectly && (!file || file.includes('..') || path.isAbsolute(file))) {
  process.stdout.write('FAIL\n');
  process.exit(1);
}
function absolutePath() {
  return path.join(process.cwd(), ...file.split('/'));
}
const tuningEnabled = file === 'app/index.html';
function tuningFilePath() {
  return path.join(process.cwd(), 'app', 'tuning.json');
}

function insideWorkspace(file) {
  try {
    const root = fs.realpathSync(process.cwd());
    const target = fs.realpathSync(file);
    const relative = path.relative(root, target);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function regularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && insideWorkspace(file);
  } catch (error) {
    if (error && error.code === 'EPERM') throw error;
    return false;
  }
}

function clearRegularTemp(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    fs.rmSync(file);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') throw error;
    return Boolean(error && error.code === 'ENOENT');
  }
}

function refuseSharedDestination(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return;
  }
  if (stat.nlink > 1) throw new Error('unsafe_path');
}

function readUnshared(file, encoding) {
  const stat = fs.lstatSync(file);
  if (stat.nlink > 1) throw new Error('unsafe_path');
  return fs.readFileSync(file, encoding);
}

function rethrowReadFailure(error) {
  if (error && (error.code === 'EPERM' || error.message === 'unsafe_path')) throw error;
}

function tuningFile() {
  try {
    const stat = fs.lstatSync(tuningFilePath());
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return stat;
  } catch (error) {
    if (error && error.code === 'EPERM') throw error;
    return null;
  }
}

function checkedTuning(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !Object.hasOwn(raw, 'speed') || !Object.hasOwn(raw, 'gravity')) return null;
  if (typeof raw.speed !== 'number' || typeof raw.gravity !== 'number') return null;
  if (!Number.isFinite(raw.speed) || raw.speed < 50 || raw.speed > 500) return null;
  if (!Number.isFinite(raw.gravity) || raw.gravity < 100 || raw.gravity > 1500) return null;
  return { speed: raw.speed, gravity: raw.gravity };
}

function notebookPath() {
  const file = path.join(process.cwd(), 'app', 'notebook.ipynb');
  return regularFile(file) ? file : null;
}

function readBodyLimited(request, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function remoteScriptSource(source) {
  if (/https?:\/\//i.test(source) || /javascript\s*:/i.test(source)) return true;
  return /(?<!:)\/\//.test(source);
}

function decodePercents(value) {
  return value.replace(/%([0-9a-f]{2})/gi, (_whole, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function contactScheme(markup) {
  return /<script\b[^>]*?[\s/]src\s*=\s*['"]?\s*(?:mailto|tel|sms|intent|market)\s*:/i.test(markup)
    || /[\s/.](?:formaction|href|action)\s*=\s*['"]?\s*(?:mailto|tel|sms|intent|market)\s*:/i.test(markup);
}

function contactMarkup(markup) {
  let current = markup;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (contactScheme(current)) return true;
    if (attempt === 2) break;
    const next = decodePercents(current);
    if (next === current) break;
    current = next;
  }
  return false;
}

function remoteMarkup(html) {
  const markup = html
    .replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, '')
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '');
  if (/https?:\/\//i.test(markup) || /javascript\s*:/i.test(markup)) return true;
  if (/<script\b[^>]*?[\s/]src\s*=\s*['"]?\s*(?:\/\/|https?\s*:|javascript\s*:|data\s*:|file\s*:|blob\s*:)/i.test(markup)) return true;
  if (/[\s/.](?:formaction|href|action)\s*=\s*['"]?\s*(?:\/\/|https?\s*:|javascript\s*:|data\s*:|file\s*:|blob\s*:)/i.test(markup)) return true;
  if (contactMarkup(markup)) return true;
  const outside = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  return /\son[a-z]+\s*=/i.test(outside);
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function writeRegular(file, text) {
  const temp = `${file}.tmp`;
  if (!clearRegularTemp(temp)) return false;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, text);
    fs.closeSync(fd);
    fd = undefined;
    if (!regularFile(file) || !regularFile(temp)) throw new Error('unsafe_path');
    refuseSharedDestination(file);
    fs.renameSync(temp, file);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* The descriptor is already closed. */ }
    }
    if (regularFile(temp)) {
      try { fs.rmSync(temp); } catch { /* Leave a file that is no longer a regular file. */ }
    }
    if (error && (error.code === 'EPERM' || error.message === 'unsafe_path')) throw error;
    return false;
  }
}

function writeTuningFile(tuning) {
  return writeRegular(tuningFilePath(), `${JSON.stringify(tuning)}\n`);
}

function showSavedCell(id, source) {
  const preview = path.join(process.cwd(), 'app', 'preview.html');
  if (!regularFile(preview)) return false;
  const html = readUnshared(preview, 'utf8');
  const label = `aria-label="${escapeHtml(id)}"`;
  const start = html.indexOf(label);
  const openEnd = start < 0 ? -1 : html.indexOf('>', start);
  const close = openEnd < 0 ? -1 : html.indexOf('</textarea>', openEnd);
  if (close < 0) return false;
  const next = `${html.slice(0, openEnd + 1)}${escapeHtml(source)}${html.slice(close)}`.replace(
    '<p id="save-note">الحفظ يكتب الخلية في الدفتر ولا ينفّذها.</p>',
    '<p id="save-note">حُفظت الخلية في الدفتر. لم تُنفَّذ.</p>',
  );
  return writeRegular(preview, next);
}

function saveNotebookCell(id, source) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || typeof source !== 'string' || source.length > 100_000) return null;
  const file = notebookPath();
  if (!file) return null;
  const stat = fs.statSync(file);
  if (stat.size > 3_000_000) return null;
  let book;
  try {
    book = JSON.parse(readUnshared(file, 'utf8'));
  } catch (error) {
    rethrowReadFailure(error);
    return null;
  }
  if (!book || book.nbformat !== 4 || !Array.isArray(book.cells)) return null;
  const cell = book.cells.find((item) => item && item.id === id);
  if (!cell) return null;
  const outputs = JSON.stringify(cell.outputs ?? null);
  const stored = source.replace(/\r\n/g, '\n');
  if (installsPackage(stored)) return null;
  cell.source = stored;
  if (JSON.stringify(cell.outputs ?? null) !== outputs) return null;
  if (!writeRegular(file, `${JSON.stringify(book, null, 2)}\n`)) return null;
  return stored;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256) {
        reject(new Error('too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function loopbackHost(request) {
  const header = request.headers.host;
  if (typeof header !== 'string' || header.length === 0 || header.length > 128) return false;
  const name = header.split(',')[0].trim().replace(/:\d+$/, '').toLowerCase().replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

module.exports = { remoteMarkup, showSavedCell, saveNotebookCell, writeTuningFile, handleRequest };

async function handleRequest(request, response) {
  if (!loopbackHost(request)) {
    response.writeHead(403, { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    response.end();
    return;
  }
  const url = request.url ?? '';
  if (tuningEnabled && request.method === 'GET' && url === '/tuning.json') {
    if (!tuningFile()) {
      response.writeHead(404, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    if (!regularFile(tuningFilePath())) {
      response.writeHead(404, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    let body;
    try {
      body = readUnshared(tuningFilePath());
    } catch (error) {
      rethrowReadFailure(error);
      response.writeHead(404, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    if (/https?:\/\//i.test(body.toString('utf8')) || /javascript:/i.test(body.toString('utf8'))) {
      response.writeHead(400, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
    return;
  }
  if (tuningEnabled && request.method === 'POST' && url === '/tuning') {
    if (!tuningFile()) {
      response.writeHead(404, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    let tuning = null;
    try {
      tuning = checkedTuning(JSON.parse(await readBody(request)));
    } catch {
      tuning = null;
    }
    if (!tuning) {
      response.writeHead(400, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    let wrote = false;
    try {
      wrote = writeTuningFile(tuning);
    } catch (error) {
      if (error && error.code === 'EPERM') throw error;
      wrote = false;
    }
    if (!wrote) {
      response.writeHead(400, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    response.writeHead(204, { 'x-content-type-options': 'nosniff' });
    response.end();
    return;
  }
  if (request.method === 'POST' && url.split('?')[0] === '/notebook-cell') {
    if (!notebookPath()) {
      response.writeHead(404, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    let stored = null;
    try {
      const fields = new URLSearchParams(await readBodyLimited(request, 120_000));
      const id = fields.get('id') ?? '';
      stored = saveNotebookCell(id, fields.get('source') ?? '');
      if (typeof stored === 'string') showSavedCell(id, stored);
    } catch (error) {
      if (error && error.code === 'EPERM') throw error;
      stored = null;
    }
    if (typeof stored !== 'string') {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
      response.end('<!doctype html><meta charset="utf-8"><p id="save-note">تعذر حفظ الخلية. لم تُنفَّذ.</p>');
      return;
    }
    response.writeHead(303, { location: '/', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    response.end();
    return;
  }
  const pathname = url.split('?')[0];
  if (pathname !== '/' && pathname !== '/health') {
    const name = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const page = absolutePath();
    const scriptPath = path.resolve(path.dirname(page), name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(name) || path.dirname(scriptPath) !== path.resolve(path.dirname(page)) || !regularFile(scriptPath)) {
      response.writeHead(404, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    let scriptBody;
    try {
      scriptBody = readUnshared(scriptPath);
    } catch (error) {
      rethrowReadFailure(error);
      response.writeHead(404, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    if (!regularFile(scriptPath) || scriptBody.includes(Buffer.from('</script')) || remoteScriptSource(scriptBody.toString('utf8'))) {
      response.writeHead(400, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': scriptBody.length,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    response.end(scriptBody);
    return;
  }
  const page = absolutePath();
  if (!regularFile(page)) {
    response.writeHead(400, { 'x-content-type-options': 'nosniff' });
    response.end();
    return;
  }
  let body;
  try {
    body = readUnshared(page);
  } catch (error) {
    rethrowReadFailure(error);
    response.writeHead(400, { 'x-content-type-options': 'nosniff' });
    response.end();
    return;
  }
  if (remoteMarkup(body.toString('utf8'))) {
    response.writeHead(400, { 'x-content-type-options': 'nosniff' });
    response.end();
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  response.end(body);
}

if (invokedDirectly) {
const server = http.createServer(handleRequest);
server.on('error', (error) => {
  process.stdout.write(error && error.code === 'EADDRINUSE' ? 'EADDRINUSE\n' : 'FAIL\n');
  process.exit(error && error.code === 'EADDRINUSE' ? 98 : 1);
});
function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(port, '127.0.0.1', () => process.stdout.write('READY\n'));
}
