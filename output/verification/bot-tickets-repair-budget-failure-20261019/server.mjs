// server.mjs — خادم إدارة التذاكر
// وحدات Node المدمجة فقط (node:http و node:sqlite و node:fs لقراءة الصفحة) — دون أي حزم خارجية.
//
// العقود الدقيقة للاستجابات (لا حقول أخرى):
//   GET   /api/tickets      -> 200 {items:[{id,title,status,version}]} مرتبة تصاعديًا حسب id
//   POST  /api/tickets      -> 201 {item:{id,title,status,version}} | 400 {error:"invalid"} | 409 {error:"duplicate"}
//   PATCH /api/tickets/<id> -> 200 {item:{id,title,status,version}} | 400 {error:"invalid"}
//                             | 404 {error:"not_found"} | 409 {error:"version_conflict"}

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

// قراءة index.html عبر وحدة مدمجة (استيراد ديناميكي لوحدة مدمجة؛ لا حزم خارجية إطلاقًا)
const { readFile } = await import('node:fs/promises');

const HOST = '127.0.0.1';
const PORT = 3000;
const DB_PATH = '/tmp/tickets.sqlite';
const APP_ROOT = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const INDEX_PATH = `${APP_ROOT}/index.html`;

// ---------- قاعدة البيانات: تهيئة غير مدمرة (CREATE TABLE IF NOT EXISTS، دون حذف أي بيانات موجودة) ----------
const db = new DatabaseSync(DB_PATH);
db.exec(
  'CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL)'
);

// استعلامات مربوطة (bound) تُحضَّر مرة واحدة وتُعاد استخدامها
const stmtList = db.prepare('SELECT id, title, status, version FROM tickets ORDER BY id ASC');
const stmtGet = db.prepare('SELECT id, title, status, version FROM tickets WHERE id = ?');
const stmtInsert = db.prepare('INSERT INTO tickets (id, title, status, version) VALUES (?, ?, ?, ?)');
const stmtUpdate = db.prepare(
  'UPDATE tickets SET title = ?, status = ?, version = version + 1 WHERE id = ? AND version = ?'
);

// ---------- التحقق من المدخلات ----------
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const isId = (v) => typeof v === 'string' && ID_PATTERN.test(v);
const isTitle = (v) => typeof v === 'string' && v.trim().length > 0;
const isStatus = (v) => v === 'open' || v === 'closed';
const isVersion = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

// ---------- أدوات الاستجابة والقراءة ----------
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// يقرأ الجسم ويحلله؛ يرجع {ok:false} عند JSON معطوب أو جسم غير كائن أو تعذر القراءة
async function readJsonBody(req) {
  try {
    const text = await readBody(req);
    const value = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// ---------- عمليات ذرّية داخل معاملات ----------
function createTicket(id, title) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (stmtGet.get(id)) {
      db.exec('ROLLBACK');
      return { status: 409, body: { error: 'duplicate' } };
    }
    stmtInsert.run(id, title, 'open', 1);
    db.exec('COMMIT');
    return { status: 201, body: { item: { id, title, status: 'open', version: 1 } } };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* تجاهل */ }
    throw err;
  }
}

// المقارنة (SELECT) والتحديث (UPDATE ... WHERE id=? AND version=?) ذرّيان داخل معاملة واحدة
function updateTicket(id, title, status, version) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = stmtGet.get(id);
    if (!row) {
      db.exec('ROLLBACK');
      return { status: 404, body: { error: 'not_found' } };
    }
    if (row.version !== version) {
      db.exec('ROLLBACK');
      return { status: 409, body: { error: 'version_conflict' } };
    }
    const info = stmtUpdate.run(title, status, id, version);
    if (info.changes !== 1) {
      db.exec('ROLLBACK');
      return { status: 409, body: { error: 'version_conflict' } };
    }
    db.exec('COMMIT');
    return { status: 200, body: { item: { id, title, status, version: version + 1 } } };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* تجاهل */ }
    throw err;
  }
}

// ---------- التوجيه ----------
async function handleRequest(req, res) {
  const method = req.method ?? '';
  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    sendJson(res, 400, { error: 'invalid' });
    return;
  }

  // صفحة الواجهة كملف ثابت
  if ((method === 'GET' || method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = await readFile(INDEX_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(method === 'HEAD' ? undefined : html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html غير موجود بعد');
    }
    return;
  }

  if (pathname === '/api/tickets') {
    if (method === 'GET') {
      const items = stmtList
        .all()
        .map((row) => ({ id: row.id, title: row.title, status: row.status, version: row.version }));
      sendJson(res, 200, { items });
      return;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { error: 'invalid' });
        return;
      }
      const { id, title } = parsed.value;
      if (!isId(id) || !isTitle(title)) {
        sendJson(res, 400, { error: 'invalid' });
        return;
      }
      const out = createTicket(id, title.trim());
      sendJson(res, out.status, out.body);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const patchMatch = /^\/api\/tickets\/([A-Za-z0-9_-]{1,40})$/.exec(pathname);
  if (method === 'PATCH' && patchMatch) {
    const id = patchMatch[1];
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'invalid' });
      return;
    }
    const { title, status, version } = parsed.value;
    if (!isTitle(title) || !isStatus(status) || !isVersion(version)) {
      sendJson(res, 400, { error: 'invalid' });
      return;
    }
    const out = updateTicket(id, title.trim(), status, version);
    sendJson(res, out.status, out.body);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  handleRequest(req, res).catch((err) => {
    console.error('request failed:', err);
    try {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    } catch { /* تجاهل */ }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`tickets server listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
});

// إغلاق نظيف عند إيقاف العملية (إعادة تشغيل العملية داخل الحاوية نفسها لا يفقد البيانات)
function shutdown() {
  try { db.close(); } catch { /* تجاهل */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);