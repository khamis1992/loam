// server.mjs — خادم تطبيق المخزون العربي (RTL)
// Node خالص باستخدام الوحدات المدمجة فقط (node:http + node:sqlite) دون أي مكتبات خارجية.
// يستمع على 127.0.0.1:3000 ويخزّن البيانات في قاعدة SQLite فعلية داخل حاوية Docker.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOST = '127.0.0.1';
const PORT = 3000;

// مسار قاعدة البيانات الفعلية داخل الحاوية (يُكتب فقط تحت /tmp داخل Docker)
const DB_PATH = '/tmp/inventory.sqlite';

/* ---------------- قاعدة البيانات (SQLite فعلية، ليست مصفوفة ذاكرة) ---------------- */

const db = new DatabaseSync(DB_PATH);

// يُنشأ الجدول فارغًا: القاعدة تبدأ بلا أصناف
db.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    sku      TEXT    PRIMARY KEY,
    quantity INTEGER NOT NULL CHECK (quantity >= 0)
  );
`);

// استعلامات مُعدّة بمعاملات ربط (?) — لا تُدمج القيم (مثل الرمز) داخل نص SQL أبدًا
const stmtList     = db.prepare('SELECT sku, quantity FROM stock ORDER BY sku');
const stmtGetBySku = db.prepare('SELECT sku, quantity FROM stock WHERE sku = ?');
const stmtInsert   = db.prepare('INSERT INTO stock (sku, quantity) VALUES (?, ?)');
const stmtWithdraw = db.prepare('UPDATE stock SET quantity = quantity - ? WHERE sku = ?');

/** ينفّذ دالة داخل معاملة SQL: COMMIT عند النجاح وROLLBACK كامل عند أي خطأ (لا تغيير جزئي). */
function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* لا شيء لتراجعه */ }
    throw err;
  }
}

/** ينشئ خطأً يحمل رمز حالة HTTP ليُترجم لاحقًا إلى رد JSON مناسب. */
function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

/* ---------------- أدوات HTTP مساعدة ---------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** يقرأ جسم الطلب كاملًا (بحد أقصى 1 ميغابايت) ويعيد النص الخام. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > 1_000_000) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(httpError(400, 'حجم الطلب كبير جدًا.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * يتحقق من صحة المدخلات {sku, quantity}:
 * - sku نص غير فارغ (يُقتطع من الفراغات الطرفية).
 * - quantity عدد صحيح موجب (يُرفض 0 والسالب والكسري وغير الرقمي).
 * يعيد {sku, quantity} عند الصحة، أو {error} عند عدم الصلاحية (→ 400).
 */
function parseStockPayload(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'صيغة JSON غير صالحة.' };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'الجسم المرسل يجب أن يكون كائن JSON بالشكل {sku, quantity}.' };
  }
  const { sku, quantity } = data;
  if (typeof sku !== 'string' || sku.trim() === '') {
    return { error: 'الرمز (sku) مطلوب ويجب أن يكون نصًا غير فارغ.' };
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { error: 'الكمية يجب أن تكون عددًا صحيحًا موجبًا.' };
  }
  return { sku: sku.trim(), quantity };
}

/* ---------------- نقاط النهاية ---------------- */

/** GET /api/stock → 200 {items:[{sku,quantity}]} */
function handleListStock(res) {
  const items = stmtList.all().map((row) => ({ sku: row.sku, quantity: row.quantity }));
  sendJson(res, 200, { items });
}

/** POST /api/stock → 201 عند الإنشاء، 409 عند تكرار الرمز، 400 عند إدخال غير صالح */
async function handleCreateStock(req, res) {
  const parsed = parseStockPayload(await readRawBody(req));
  if (parsed.error) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  const { sku, quantity } = parsed;
  try {
    const created = inTransaction(() => {
      if (stmtGetBySku.get(sku)) {
        throw httpError(409, 'هذا الرمز (sku) موجود مسبقًا في المخزون.');
      }
      stmtInsert.run(sku, quantity);
      return { sku, quantity };
    });
    sendJson(res, 201, created);
  } catch (err) {
    if (err.statusCode === 409) {
      sendJson(res, 409, { error: err.message });
      return;
    }
    throw err;
  }
}

/** POST /api/withdraw → 200 عند نجاح السحب، 409 عند عدم وجود الصنف أو عدم كفاية الرصيد (دون أي تغيير في البيانات)، 400 عند إدخال غير صالح */
async function handleWithdraw(req, res) {
  const parsed = parseStockPayload(await readRawBody(req));
  if (parsed.error) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  const { sku, quantity } = parsed;
  try {
    const updated = inTransaction(() => {
      const row = stmtGetBySku.get(sku);
      if (!row) {
        throw httpError(409, 'الصنف غير موجود في المخزون.');
      }
      if (row.quantity < quantity) {
        throw httpError(409, `الرصيد غير كافٍ: المتاح ${row.quantity} والمطلوب سحبه ${quantity}.`);
      }
      stmtWithdraw.run(quantity, sku);
      return { sku, quantity: row.quantity - quantity };
    });
    sendJson(res, 200, updated);
  } catch (err) {
    if (err.statusCode === 409) {
      // لم يحدث أي تغيير: المعاملة تُراجع بالكامل قبل الوصول إلى هنا
      sendJson(res, 409, { error: err.message });
      return;
    }
    throw err;
  }
}

/* ---------------- تقديم الواجهة (index.html) ---------------- */

const rootDir = dirname(fileURLToPath(import.meta.url));
const indexPath = join(rootDir, 'index.html');

function serveIndex(res) {
  try {
    const html = readFileSync(indexPath);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  } catch {
    sendJson(res, 500, { error: 'ملف index.html غير موجود بجانب server.mjs.' });
  }
}

/* ---------------- الخادم ---------------- */

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (pathname === '/' || pathname === '/index.html') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveIndex(res);
      } else {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
      }
      return;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/api/stock') {
      if (req.method === 'GET') {
        handleListStock(res);
      } else if (req.method === 'POST') {
        await handleCreateStock(req, res);
      } else {
        res.writeHead(405, { Allow: 'GET, POST' });
        res.end();
      }
      return;
    }

    if (pathname === '/api/withdraw') {
      if (req.method === 'POST') {
        await handleWithdraw(req, res);
      } else {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
      }
      return;
    }

    sendJson(res, 404, { error: 'المسار غير موجود.' });
  } catch (err) {
    console.error('خطأ غير متوقع:', err);
    if (!res.headersSent) {
      sendJson(res, err.statusCode ?? 500, { error: err.message ?? 'خطأ داخلي في الخادم.' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`خادم المخزون يعمل الآن على http://${HOST}:${PORT} (قاعدة البيانات: ${DB_PATH})`);
});

/* إغلاق نظيف عند إيقاف الحاوية */
function shutdown() {
  server.close(() => {
    try { db.close(); } catch { /* تجاهل */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);