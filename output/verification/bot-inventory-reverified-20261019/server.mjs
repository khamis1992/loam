// server.mjs — خادم تطبيق المخزون العربي (RTL)
// يعمل بـ node:http و node:sqlite فقط، دون أي مكتبات خارجية.
// يستمع على 127.0.0.1:3000 ويخزّن في قاعدة SQLite حقيقية داخل /tmp/inventory.sqlite
// (الكتابة داخل /tmp فقط — لا تُكتب أي بيانات في مجلد التطبيق).

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 3000;
const DB_PATH = '/tmp/inventory.sqlite';
const MAX_BODY_BYTES = 64 * 1024; // حد أقصى لحجم جسم الطلب
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(ROOT_DIR, 'index.html');

/* ---------------- قاعدة البيانات (SQLite حقيقية) ---------------- */

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    sku      TEXT PRIMARY KEY,
    quantity INTEGER NOT NULL CHECK(quantity >= 0)
  )
`);

// تبدأ القاعدة بلا أصناف عند كل إقلاع للخادم
db.exec('DELETE FROM stock');

// عبارات SQL بمعاملات ربط (?) فقط — لا يُدمج أي إدخال من المستخدم داخل نص SQL إطلاقًا
const stmtListStock  = db.prepare('SELECT sku, quantity FROM stock ORDER BY sku');
const stmtFindSku    = db.prepare('SELECT 1 AS present FROM stock WHERE sku = ? LIMIT 1');
const stmtGetBalance = db.prepare('SELECT quantity FROM stock WHERE sku = ?');
const stmtInsertItem = db.prepare('INSERT INTO stock (sku, quantity) VALUES (?, ?)');
const stmtDoWithdraw = db.prepare(
  'UPDATE stock SET quantity = quantity - ? WHERE sku = ? AND quantity >= ?'
);

/* ---------------- أدوات مساعدة ---------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function isValidSku(sku) {
  return typeof sku === 'string' && sku.trim().length > 0;
}

function isValidQuantity(quantity) {
  return typeof quantity === 'number' && Number.isInteger(quantity) && quantity > 0;
}

// يقرأ جسم الطلب مع حد للحجم، ويحلل JSON داخل try/catch.
// يعيد الكائن المحلل، أو null بعد إرسال 400 عند جسم فارغ/تالف/أكبر من الحد.
function readJsonBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;
    let rejected = false;

    const reject = (message) => {
      if (rejected) return;
      rejected = true;
      sendJson(res, 400, { error: message });
      resolve(null);
    };

    req.on('data', (chunk) => {
      if (rejected) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject('حجم الطلب يتجاوز الحد المسموح');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        reject('جسم الطلب فارغ');
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject('JSON غير صالح');
      }
    });

    req.on('error', () => reject('تعذر قراءة جسم الطلب'));
  });
}

// يتحقق من صحة {sku, quantity} ويعيد 400 عند الإدخال غير الصالح،
// أو يعيد {sku, quantity} بعد التطبيع عند النجاح.
function extractValidInput(body, res) {
  const sku = body?.sku;
  const quantity = body?.quantity;

  if (!isValidSku(sku)) {
    sendJson(res, 400, { error: 'الرمز (sku) مطلوب ويجب أن يكون نصًا غير فارغ' });
    return null;
  }
  if (!isValidQuantity(quantity)) {
    sendJson(res, 400, { error: 'الكمية يجب أن تكون عددًا صحيحًا موجبًا' });
    return null;
  }
  return { sku: sku.trim(), quantity };
}

/* ---------------- معالجات الـ API ---------------- */

// GET /api/stock → 200 {items:[{sku,quantity}]}
function handleListStock(res) {
  const items = stmtListStock.all();
  sendJson(res, 200, { items });
}

// POST /api/stock → 201 عند الإنشاء، 409 عند تكرار الرمز، 400 عند إدخال غير صالح
function handleAddStock(req, res) {
  readJsonBody(req, res).then((body) => {
    if (body === null) return; // تمت بالفعل إرسال 400
    const input = extractValidInput(body, res);
    if (input === null) return;

    if (stmtFindSku.get(input.sku)) {
      sendJson(res, 409, { error: 'هذا الرمز موجود مسبقًا في المخزون' });
      return;
    }

    try {
      stmtInsertItem.run(input.sku, input.quantity);
      sendJson(res, 201, { sku: input.sku, quantity: input.quantity });
    } catch (err) {
      // شبكة أمان إضافية: انتهاك قيد المفتاح الأساسي (تزامن نادر)
      if (String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT')) {
        sendJson(res, 409, { error: 'هذا الرمز موجود مسبقًا في المخزون' });
      } else {
        sendJson(res, 500, { error: 'خطأ غير متوقع في الخادم' });
      }
    }
  });
}

// POST /api/withdraw → 200 مع الرصيد الجديد، 409 عند عدم وجود الصنف أو عدم كفاية
// الرصيد (دون أي تغيير في البيانات)، 400 عند إدخال غير صالح.
function handleWithdraw(req, res) {
  readJsonBody(req, res).then((body) => {
    if (body === null) return; // تمت بالفعل إرسال 400
    const input = extractValidInput(body, res);
    if (input === null) return;

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = stmtGetBalance.get(input.sku);
      if (!row || row.quantity < input.quantity) {
        db.exec('ROLLBACK'); // لا تغيير في البيانات عند الرفض
        sendJson(res, 409, {
          error: row ? 'الرصيد غير كافٍ لإتمام عملية السحب' : 'الصنف غير موجود في المخزون',
        });
        return;
      }
      stmtDoWithdraw.run(input.quantity, input.sku, input.quantity);
      db.exec('COMMIT');
      sendJson(res, 200, { sku: input.sku, quantity: row.quantity - input.quantity });
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {
        // تجاهل: لا توجد معاملة مفتوحة
      }
      sendJson(res, 500, { error: 'خطأ غير متوقع في الخادم' });
    }
  });
}

// يخدم index.html على "/" (و"/index.html") مع 200
async function serveIndex(res) {
  try {
    const html = await readFile(INDEX_PATH);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-store',
    });
    res.end(html);
  } catch {
    sendText(res, 500, 'تعذر تحميل الصفحة: index.html غير موجود');
  }
}

/* ---------------- الخادم ---------------- */

const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    sendText(res, 400, 'طلب غير صالح');
    return;
  }

  if (pathname === '/api/stock') {
    if (req.method === 'GET') {
      handleListStock(res);
      return;
    }
    if (req.method === 'POST') {
      handleAddStock(req, res);
      return;
    }
    sendJson(res, 404, { error: 'المسار غير موجود' });
    return;
  }

  if (pathname === '/api/withdraw') {
    if (req.method === 'POST') {
      handleWithdraw(req, res);
      return;
    }
    sendJson(res, 404, { error: 'المسار غير موجود' });
    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveIndex(res);
    return;
  }

  // أي مسار آخر → 404
  sendText(res, 404, '404 — المسار غير موجود');
});

server.listen(PORT, HOST, () => {
  console.log(`خادم المخزون يعمل على http://${HOST}:${PORT}`);
});