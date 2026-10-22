// server.mjs — خادم إدارة التذاكر (وحدات Node المدمجة فقط: node:http, node:sqlite, node:fs, node:path, node:url)
// يستمع على 127.0.0.1:3000 ويخزّن البيانات في قاعدة SQLite حقيقية داخل الحاوية:
// /tmp/tickets.sqlite — تهيئة غير مدمرة: تُنشأ إن لم تكن موجودة وتُحفظ بياناتها عبر إعادة تشغيل عملية الخادم.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = '/tmp/tickets.sqlite'; // المسار يُكتب هنا داخل كود الخادم فقط

// عند الإقلاع: تهيئة غير مدمرة — إنشاء الجدول فقط إن لم يكن موجودًا (CREATE TABLE IF NOT EXISTS)
// دون أي DROP TABLE أو DELETE FROM أو حذف لملف القاعدة، لتبقى التذاكر وإصداراتها
// بعد إعادة تشغيل عملية الخادم داخل الحاوية نفسها (لا دوام بعد حذف الحاوية).

// إنشاء قاعدة SQLite حقيقية وجدول tickets (غير مدمرة)
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id      TEXT PRIMARY KEY,
    title   TEXT NOT NULL,
    status  TEXT NOT NULL,
    version INTEGER NOT NULL
  )
`);

// استعلامات مربوطة (معدة مسبقًا بمعاملات ?)
const qAll = db.prepare('SELECT id, title, status, version FROM tickets ORDER BY id ASC');
const qIdExists = db.prepare('SELECT id FROM tickets WHERE id = ?');
const qVersionById = db.prepare('SELECT version FROM tickets WHERE id = ?');
const qInsert = db.prepare('INSERT INTO tickets (id, title, status, version) VALUES (?, ?, ?, ?)');
const qUpdate = db.prepare(
  'UPDATE tickets SET title = ?, status = ?, version = version + 1 WHERE id = ? AND version = ?'
);

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(here, 'index.html');

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function hasNonWhitespace(value) {
  return typeof value === 'string' && /\S/.test(value);
}

function isValidVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

const sendInvalid = (res) => sendJson(res, 400, { error: 'invalid' });
const sendNotFound = (res) => sendJson(res, 404, { error: 'not_found' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 1000000) {
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // JSON معطوب
  }
}

// معاملة ذرّية: BEGIN IMMEDIATE ثم COMMIT، مع ROLLBACK عند أي فشل
function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const result = fn();
    db.exec('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // تجاهل فشل التراجع
      }
    }
  }
}

function serveIndex(res) {
  try {
    const html = readFileSync(INDEX_PATH);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(html);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('index.html غير موجود بعد');
  }
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/tickets') {
    if (req.method === 'GET') {
      // 200 {items:[{id,title,status,version}]} مرتبة تصاعديًا حسب id — بلا حقول إضافية
      sendJson(res, 200, { items: qAll.all() });
      return;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendInvalid(res);
      }
      if (!isPlainObject(body)) return sendInvalid(res);
      const { id, title } = body;
      if (typeof id !== 'string' || !ID_PATTERN.test(id) || !hasNonWhitespace(title)) {
        return sendInvalid(res);
      }
      const cleanTitle = title.trim();
      try {
        const item = inTransaction(() => {
          if (qIdExists.get(id)) return null; // معرف مكرر — دون تعديل السجل السابق
          qInsert.run(id, cleanTitle, 'open', 1);
          return { id, title: cleanTitle, status: 'open', version: 1 };
        });
        if (item === null) return sendJson(res, 409, { error: 'duplicate' });
        return sendJson(res, 201, { item });
      } catch (err) {
        console.error('POST /api/tickets failed:', err);
        return sendJson(res, 500, { error: 'internal' });
      }
    }
    return sendNotFound(res);
  }

  const match = /^\/api\/tickets\/([^/]+)$/.exec(pathname);
  if (match) {
    if (req.method !== 'PATCH') return sendNotFound(res);
    let id = match[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      // نستخدم المقطع الخام كما هو
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendInvalid(res);
    }
    if (!isPlainObject(body)) return sendInvalid(res);
    const { title, status, version } = body;
    if (
      !hasNonWhitespace(title) ||
      (status !== 'open' && status !== 'closed') ||
      !isValidVersion(version)
    ) {
      return sendInvalid(res);
    }
    const cleanTitle = title.trim();
    try {
      const outcome = inTransaction(() => {
        const row = qVersionById.get(id);
        if (!row) return { status: 404, payload: { error: 'not_found' } };
        if (row.version !== version) {
          // تعارض إصدار — دون أي تغيير
          return { status: 409, payload: { error: 'version_conflict' } };
        }
        const updated = qUpdate.run(cleanTitle, status, id, version);
        if (updated.changes !== 1) {
          return { status: 409, payload: { error: 'version_conflict' } };
        }
        return {
          status: 200,
          payload: { item: { id, title: cleanTitle, status, version: version + 1 } }
        };
      });
      return sendJson(res, outcome.status, outcome.payload);
    } catch (err) {
      console.error('PATCH /api/tickets/<id> failed:', err);
      return sendJson(res, 500, { error: 'internal' });
    }
  }

  return sendNotFound(res);
}

const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('طلب غير صالح');
    return;
  }

  // تقديم index.html عند GET /
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveIndex(res);
    return;
  }

  handleApi(req, res, pathname).catch((err) => {
    console.error('Request error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal' });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`خادم التذاكر يعمل على http://${HOST}:${PORT} (قاعدة البيانات: ${DB_PATH})`);
});