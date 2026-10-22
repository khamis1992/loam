/**
 * server.mjs — خادم تطبيق المخزون العربي (RTL)
 *
 * • وحدات Node المدمجة فقط (لا مكتبات خارجية إطلاقًا):
 *   node:http لتشغيل الخادم، node:sqlite لقاعدة البيانات، node:fs لقراءة index.html من القرص.
 * • يستمع على 127.0.0.1:3000 ويعمل باستمرار (لا process.exit ولا setTimeout لإنهاء ذاتي).
 * • قاعدة SQLite فعلية على القرص في /tmp/inventory.sqlite — بيانات التشغيل داخل حاوية
 *   Docker فقط، ولا علاقة لها بمسارات إنشاء ملفات المصدر على جهاز المستخدم.
 * • لا مصفوفة في الذاكرة ولا localStorage: قاعدة البيانات هي مصدر الحقيقة الوحيد.
 * • كل عبارات SQL تستخدم معاملات ربط (?) — لا تُدمج أي قيمة (مثل sku) داخل نص الاستعلام.
 */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';

const HOST = '127.0.0.1';
const PORT = 3000;
const DB_PATH = '/tmp/inventory.sqlite';
const MAX_BODY_BYTES = 100_000; // حد أقصى لحجم جسم الطلب (حماية بسيطة)

/* ============================================================
 * قاعدة البيانات: SQLite فعلية في /tmp داخل الحاوية
 * ============================================================ */

// /tmp موجود دائمًا داخل حاوية Linux؛ الإنشاء الاحتياطي لا يمس ملفات المصدر إطلاقًا.
try {
  mkdirSync('/tmp', { recursive: true });
} catch {
  // المجلد موجود مسبقًا أو أنشأته بيئة التشغيل — لا شيء مطلوب.
}

let db;
try {
  db = new DatabaseSync(DB_PATH);
} catch (err) {
  // فشل تهيئة البيئة (مثل عدم توفر /tmp) — رسالة واضحة ثم انهيار صريح عند الإقلاع،
  // بلا أي إنهاء ذاتي صامت أثناء التشغيل الطبيعي.
  console.error(`تعذر فتح قاعدة البيانات في ${DB_PATH}: ${err && err.message ? err.message : err}`);
  throw err;
}

// إنشاء الجدول إن لم يوجد — تبدأ القاعدة بلا أي أصناف مبدئية (لا INSERT إطلاقًا).
db.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    sku TEXT PRIMARY KEY,
    quantity INTEGER NOT NULL CHECK(quantity >= 0)
  )
`);

// استعلامات مُجهّزة بمعاملات ربط (?) — لا دمج لأي قيمة داخل نص SQL مطلقًا.
const stmtList = db.prepare('SELECT sku, quantity FROM stock ORDER BY sku');
const stmtGet = db.prepare('SELECT sku, quantity FROM stock WHERE sku = ?');
const stmtInsert = db.prepare('INSERT INTO stock (sku, quantity) VALUES (?, ?)');
const stmtWithdraw = db.prepare('UPDATE stock SET quantity = quantity - ? WHERE sku = ?');

/* ============================================================
 * أدوات مساعدة
 * ============================================================ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// قراءة جسم الطلب كاملًا (كمخازن ثنائية لتفادي تلف الأحرف العربية المقسومة بين
// الحزم) ثم تحليله كـ JSON. الجسم الفارغ => undefined => يُرفض لاحقًا بـ 400.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return; // تجاهل بقية البث؛ يُرفض الطلب عند انتهائه
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('payload-too-large'));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid-json'));
      }
    });

    req.on('error', reject);
  });
}

// التحقق من الإدخال: sku نص غير فارغ + quantity عدد صحيح أكبر من صفر، وإلا null (=> 400).
function parseInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const sku = body.sku;
  const quantity = body.quantity;
  if (typeof sku !== 'string') return null;
  const skuTrimmed = sku.trim();
  if (skuTrimmed === '') return null;
  if (!Number.isInteger(quantity) || quantity <= 0) return null;
  return { sku: skuTrimmed, quantity };
}

// تمييز خطأ تكرار المفتاح PRIMARY KEY عبر أشكال الأخطاء المختلفة لإصدارات node:sqlite.
function isUniqueViolation(err) {
  if (!err) return false;
  const code = String(err.code ?? err.errcode ?? '');
  const message = String(err.message ?? '');
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || /UNIQUE constraint failed/i.test(message);
}

/* ============================================================
 * نقاط النهاية (API ثابت)
 * ============================================================ */

async function handleApi(req, res, pathname) {
  // GET /api/stock — يعيد 200 مع {items:[{sku,quantity}]} من قاعدة البيانات.
  if (pathname === '/api/stock' && req.method === 'GET') {
    sendJson(res, 200, { items: stmtList.all() });
    return;
  }

  // POST /api/stock — إنشاء صنف جديد برصيد صحيح موجب: 201، وتكرار الرمز: 409،
  // وإدخال غير صالح (JSON تالف/ناقص/كمية غير صحيحة): 400.
  if (pathname === '/api/stock' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'صيغة الطلب غير صالحة (JSON مطلوب)' });
      return;
    }

    const input = parseInput(body);
    if (!input) {
      sendJson(res, 400, { error: 'الرمز مطلوب، والكمية يجب أن تكون عددًا صحيحًا موجبًا' });
      return;
    }

    // فحص مسبق للتكرار، مع شبكة أمان عند قيد PRIMARY KEY (في حال سباق بين طلبين).
    if (stmtGet.get(input.sku)) {
      sendJson(res, 409, { error: 'الرمز موجود مسبقًا في المخزون' });
      return;
    }

    try {
      stmtInsert.run(input.sku, input.quantity); // معاملات ربط فقط — لا دمج في SQL
    } catch (err) {
      if (isUniqueViolation(err)) {
        sendJson(res, 409, { error: 'الرمز موجود مسبقًا في المخزون' });
      } else {
        sendJson(res, 500, { error: 'خطأ في الخادم أثناء الإضافة' });
      }
      return;
    }

    sendJson(res, 201, { sku: input.sku, quantity: input.quantity });
    return;
  }

  // POST /api/withdraw — سحب كمية داخل معاملة BEGIN IMMEDIATE:
  // صنف غير موجود أو رصيد غير كافٍ => ROLLBACK و409 دون أي تغيير في البيانات؛
  // وإلا UPDATE ثم COMMIT و200. الإدخال غير الصالح => 400.
  if (pathname === '/api/withdraw' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'صيغة الطلب غير صالحة (JSON مطلوب)' });
      return;
    }

    const input = parseInput(body);
    if (!input) {
      sendJson(res, 400, { error: 'الرمز مطلوب، والكمية يجب أن تكون عددًا صحيحًا موجبًا' });
      return;
    }

    // المعاملة تبدأ بعد اكتمال قراءة الجسم، وكل خطواتها متزامنة بلا أي await
    // حتى لا يتداخل طلب آخر داخل نطاقها (حلقة الأحداث أحادية الخيط).
    try {
      db.exec('BEGIN IMMEDIATE');

      const row = stmtGet.get(input.sku); // معامل ربط ? — لا دمج للرمز في SQL
      if (!row) {
        db.exec('ROLLBACK'); // رفض دون أي تغيير في البيانات
        sendJson(res, 409, { error: 'الصنف غير موجود في المخزون' });
        return;
      }
      if (row.quantity < input.quantity) {
        db.exec('ROLLBACK'); // رفض دون أي تغيير في البيانات
        sendJson(res, 409, { error: 'الرصيد غير كافٍ لإتمام عملية السحب' });
        return;
      }

      stmtWithdraw.run(input.quantity, input.sku); // معاملات ربط فقط — لا دمج في SQL
      db.exec('COMMIT');

      const updated = stmtGet.get(input.sku);
      sendJson(res, 200, { sku: updated.sku, quantity: updated.quantity });
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // لا معاملة مفتوحة — لا شيء مطلوب.
      }
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'خطأ في الخادم أثناء السحب' });
      }
    }
    return;
  }

  // طرق غير مدعومة على مسارات API المعروفة.
  if (pathname === '/api/stock' || pathname === '/api/withdraw') {
    sendJson(res, 405, { error: 'الطريقة غير مدعومة لهذا المسار' });
    return;
  }

  sendJson(res, 404, { error: 'المسار غير موجود' });
}

/* ============================================================
 * تقديم index.html على المسار /
 * ============================================================ */

const INDEX_URL = new URL('./index.html', import.meta.url);

function serveIndex(res) {
  let html;
  try {
    html = readFileSync(INDEX_URL);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('index.html غير موجود بجانب server.mjs');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

/* ============================================================
 * الخادم — يعمل باستمرار (لا process.exit ولا setTimeout إنهائي)
 * ============================================================ */

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  } catch {
    sendJson(res, 400, { error: 'طلب غير صالح' });
    return;
  }

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
      serveIndex(res); // بالنسبة لـ HEAD يتجاهل Node جسم الاستجابة تلقائيًا
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('غير موجود');
  } catch {
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'خطأ في الخادم' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`خادم المخزون يعمل على http://${HOST}:${PORT} — قاعدة البيانات: ${DB_PATH}`);
});