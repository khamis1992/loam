// server.mjs — خادم تطبيق المخزون العربي (RTL)
// node:http + node:sqlite فقط، دون أي مكتبات خارجية.
// يستمع على 127.0.0.1:3000 ويخزّن البيانات في قاعدة SQLite فعلية على /tmp/inventory.sqlite
// (داخل حاوية Docker فقط؛ لا تُستخدم مصفوفة في الذاكرة ولا localStorage إطلاقًا).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 1) تحميل node:sqlite
//    (في إصدارات Node الأقدم من 22.13 يُعاد التشغيل مرة واحدة مع --experimental-sqlite)
// ---------------------------------------------------------------------------
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  if (process.env.INVENTORY_SQLITE_FLAGGED === '1') throw err;
  const { spawnSync } = await import('node:child_process');
  const rerun = spawnSync(
    process.execPath,
    ['--experimental-sqlite', '--no-warnings', ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, INVENTORY_SQLITE_FLAGGED: '1' } },
  );
  process.exit(rerun.status ?? 1);
}

// ---------------------------------------------------------------------------
// 2) قاعدة البيانات الفعلية على /tmp/inventory.sqlite (تبدأ بلا أصناف)
// ---------------------------------------------------------------------------
const DB_PATH = '/tmp/inventory.sqlite';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// جدول المخزون — يُنشأ فارغًا بلا أي بيانات أولية
db.exec(
  'CREATE TABLE IF NOT EXISTS stock (sku TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK(quantity>=0))',
);

// استعلامات SQL بمعاملات ربط (?) — لا يُدمج رمز SKU داخل نص SQL مطلقًا
const stmtList = db.prepare('SELECT sku, quantity FROM stock ORDER BY rowid');
const stmtGet = db.prepare('SELECT sku, quantity FROM stock WHERE sku = ?');
const stmtInsert = db.prepare('INSERT INTO stock (sku, quantity) VALUES (?, ?)');
const stmtWithdraw = db.prepare('UPDATE stock SET quantity = quantity - ? WHERE sku = ?');

// ---------------------------------------------------------------------------
// 3) أدوات مساعدة للاستجابة والتحقق من الإدخال
// ---------------------------------------------------------------------------
const HOST = '127.0.0.1';
const PORT = 3000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 1_000_000) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// يعيد كائن JSON صالحًا، أو null عند JSON غير صالح/جسم فارغ/نوع غير كائن (→ 400)
async function readJsonBody(req) {
  const raw = await readBody(req);
  if (raw.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

const isValidSku = (v) => typeof v === 'string' && v.trim().length > 0;
const isValidQuantity = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;

// ---------------------------------------------------------------------------
// 4) مسارات الـ API
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname) {
  // GET /api/stock — قراءة الأصناف من قاعدة البيانات مباشرة
  if (req.method === 'GET' && pathname === '/api/stock') {
    const items = stmtList.all();
    sendJson(res, 200, { items });
    return;
  }

  // POST /api/stock — إنشاء صنف جديد: 201 عند النجاح، 409 عند تكرار الرمز، 400 لإدخال غير صالح
  if (req.method === 'POST' && pathname === '/api/stock') {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'طلب غير صالح: JSON غير صحيح أو الحقول ناقصة' });
      return;
    }
    const { sku, quantity } = body;
    if (!isValidSku(sku) || !isValidQuantity(quantity)) {
      sendJson(res, 400, {
        error: 'الإدخال غير صالح: يجب أن يكون الرمز نصًا غير فارغ والكمية عددًا صحيحًا موجبًا',
      });
      return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (stmtGet.get(sku)) {
        db.exec('ROLLBACK');
        sendJson(res, 409, { error: 'الرمز (SKU) موجود مسبقًا في المخزون' });
        return;
      }
      stmtInsert.run(sku, quantity);
      db.exec('COMMIT');
      sendJson(res, 201, { sku, quantity });
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* لا شيء */ }
      if (
        String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT') ||
        String(err?.message ?? '').includes('UNIQUE constraint failed')
      ) {
        sendJson(res, 409, { error: 'الرمز (SKU) موجود مسبقًا في المخزون' });
        return;
      }
      throw err;
    }
    return;
  }

  // POST /api/withdraw — سحب كمية داخل معاملة:
  // 200 مع الرصيد الجديد عند النجاح، 409 دون أي تغيير عند عدم وجود الصنف أو نقص الرصيد، 400 لإدخال غير صالح
  if (req.method === 'POST' && pathname === '/api/withdraw') {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'طلب غير صالح: JSON غير صحيح أو الحقول ناقصة' });
      return;
    }
    const { sku, quantity } = body;
    if (!isValidSku(sku) || !isValidQuantity(quantity)) {
      sendJson(res, 400, {
        error: 'الإدخال غير صالح: يجب أن يكون الرمز نصًا غير فارغ والكمية عددًا صحيحًا موجبًا',
      });
      return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = stmtGet.get(sku);
      if (!row || row.quantity < quantity) {
        db.exec('ROLLBACK'); // رفض العملية دون أي تغيير في البيانات
        sendJson(res, 409, {
          error: !row ? 'الصنف غير موجود في المخزون' : 'الرصيد غير كافٍ لإتمام عملية السحب',
        });
        return;
      }
      stmtWithdraw.run(quantity, sku);
      db.exec('COMMIT');
      sendJson(res, 200, { sku, quantity: row.quantity - quantity });
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* لا شيء */ }
      throw err;
    }
    return;
  }

  sendJson(res, 404, { error: 'المسار غير موجود' });
}

// ---------------------------------------------------------------------------
// 5) تقديم ملفات الواجهة الثابتة (index.html) من مجلد الخادم نفسه
// ---------------------------------------------------------------------------
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(ROOT_DIR, rel));
  if (filePath !== ROOT_DIR && !filePath.startsWith(ROOT_DIR + path.sep)) {
    sendJson(res, 403, { error: 'وصول ممنوع' });
    return;
  }
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    sendJson(res, 404, { error: 'الملف غير موجود' });
    return;
  }
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

// ---------------------------------------------------------------------------
// 6) الخادم — يستمع على 127.0.0.1:3000
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    // طلبات CORS المسبقة
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);
    } catch {
      sendJson(res, 400, { error: 'مسار غير صالح' });
      return;
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      serveStatic(res, pathname);
    }
  } catch (err) {
    console.error('خطأ غير متوقع:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'خطأ داخلي في الخادم' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('خادم المخزون يعمل الآن على http://127.0.0.1:3000');
});