/**
 * server.mjs — خادم تطبيق نقل المخزون بين المستودعات A وB وC
 *
 * وحدات Node المدمجة فقط (node:http + node:sqlite) دون أي اعتماديات خارجية.
 * يستمع على 127.0.0.1:3000 ويخزّن البيانات في قاعدة SQLite حقيقية
 * داخل الحاوية على المسار /tmp/transfers.sqlite.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 3000;
const DB_PATH = '/tmp/transfers.sqlite';
const WAREHOUSES = new Set(['A', 'B', 'C']);
const MAX_BODY_BYTES = 1_000_000;

/* تحميل node:sqlite — في بعض إصدارات Node 22 تحتاج الوحدة راية
   --experimental-sqlite، فإن فشل الاستيراد المباشر نعيد تشغيل نفس
   العملية بالراية ونتسلم منها خدمة الطلبات. */
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (importError) {
  const entry = process.argv[1];
  if (!entry) {
    console.error('تعذر تحميل node:sqlite:', importError?.message ?? importError);
    process.exit(1);
  }
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--experimental-sqlite', entry], { stdio: 'inherit' });
  child.on('error', (error) => {
    console.error('فشل إعادة تشغيل الخادم براية sqlite:', error);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
  await new Promise(() => {}); // العملية البديلة تتولى الخدمة
}

/* قاعدة بيانات SQLite حقيقية داخل الحاوية */
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    warehouse TEXT PRIMARY KEY,
    quantity  INTEGER NOT NULL CHECK (quantity >= 0)
  );
  CREATE TABLE IF NOT EXISTS transfers (
    requestId   TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    destination TEXT NOT NULL,
    quantity    INTEGER NOT NULL
  );
`);

/* البذرة A=10 وB=0 وC=0 مرة واحدة فقط عند فراغ الجدول.
   لا إعادة تهيئة إطلاقًا عند القراءة أو إعادة تحميل الصفحة. */
const stockCount = db.prepare('SELECT COUNT(*) AS n FROM stock').get().n;
if (stockCount === 0) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const seed = db.prepare('INSERT INTO stock (warehouse, quantity) VALUES (?, ?)');
    seed.run('A', 10);
    seed.run('B', 0);
    seed.run('C', 0);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* المعاملة مغلقة أصلًا */ }
    throw error;
  }
}

/* أوامر مُعدّة مسبقًا — كل القيم تمر إلى SQL عبر معاملات ربط (?) */
const stmtListStock = db.prepare(
  'SELECT warehouse, quantity FROM stock ORDER BY warehouse'
);
const stmtListTransfers = db.prepare(
  'SELECT requestId, source, destination, quantity FROM transfers ORDER BY rowid'
);
const stmtFindTransfer = db.prepare(
  'SELECT source, destination, quantity FROM transfers WHERE requestId = ?'
);
const stmtStockOf = db.prepare(
  'SELECT quantity FROM stock WHERE warehouse = ?'
);
const stmtDebit = db.prepare(
  'UPDATE stock SET quantity = quantity - ? WHERE warehouse = ?'
);
const stmtCredit = db.prepare(
  'UPDATE stock SET quantity = quantity + ? WHERE warehouse = ?'
);
const stmtInsertTransfer = db.prepare(
  'INSERT INTO transfers (requestId, source, destination, quantity) VALUES (?, ?, ?, ?)'
);

/* التحقق من المدخلات: أي طلب مفقود أو نصي أو كسري أو سالب أو غير صالح يعيد null */
function validateTransfer(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;

  const { requestId, from, to, quantity } = body;

  // المعرف نص غير فارغ ويجب أن يحتوي محارف غير بيضاء:
  // أي معرف مكوّن من مسافات أو tab أو newline فقط (أو فارغ تمامًا) يُرفض.
  // هذا الفحص يقع قبل فتح أي معاملة وقبل أي كتابة في SQLite
  // وقبل فحص كفاية المخزون، فلا يترك أي أثر على أي جدول.
  if (typeof requestId !== 'string' || requestId.trim().length === 0) return null;
  if (typeof from !== 'string' || !WAREHOUSES.has(from)) return null;
  if (typeof to !== 'string' || !WAREHOUSES.has(to)) return null;
  if (from === to) return null;
  if (typeof quantity !== 'number') return null; // رفض القيم النصية مثل "3"
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return null; // رفض الكسري والصفر والسالب

  return { requestId, from, to, quantity };
}

/* تنفيذ النقل داخل معاملة ذرية واحدة. يعيد [حالةHTTP, حمولةJSON]. */
function processTransfer(body) {
  const data = validateTransfer(body);
  if (!data) {
    return [400, {
      error: 'بيانات غير صالحة: يجب أن يكون المعرف نصًا يحتوي محارف غير بيضاء، والمصدر والوجهة مستودعين مختلفين من A/B/C، والكمية عددًا صحيحًا موجبًا.',
    }];
  }

  const { requestId, from, to, quantity } = data;

  // BEGIN IMMEDIATE يقتنص قفل الكتابة فورًا:
  // يمنع الرصيد السالب حتى مع الطلبات المتزامنة.
  db.exec('BEGIN IMMEDIATE');
  try {
    // (1) مقارنة هوية الطلب أولًا — قبل أي فحص لكفاية المخزون الجديد.
    const existing = stmtFindTransfer.get(requestId);
    if (existing) {
      db.exec('ROLLBACK'); // لا أثر إطلاقًا على الجدولين
      if (
        existing.source === from &&
        existing.destination === to &&
        existing.quantity === quantity
      ) {
        // نفس المعرف ونفس البيانات: 200 دون تكرار أي أثر،
        // حتى لو أصبح المخزون غير كافٍ لتنفيذ نقل جديد.
        return [200, { ok: true, duplicate: true, requestId, from, to, quantity }];
      }
      // نفس المعرف مع بيانات مختلفة.
      return [409, { error: 'معرّف الطلب مستخدم مسبقًا مع بيانات مختلفة.' }];
    }

    // (2) فحص رصيد المستودع المصدر داخل المعاملة.
    const sourceRow = stmtStockOf.get(from);
    if (!sourceRow || sourceRow.quantity < quantity) {
      db.exec('ROLLBACK'); // دون تعديل أي جدول
      return [409, { error: 'المخزون غير كافٍ في المستودع المصدر.' }];
    }

    // (3) الخصم + الإضافة + تسجيل النقل: معاملة واحدة ذرية.
    stmtDebit.run(quantity, from);
    stmtCredit.run(quantity, to);
    stmtInsertTransfer.run(requestId, from, to, quantity);
    db.exec('COMMIT');
    return [201, { ok: true, requestId, from, to, quantity }];
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* المعاملة مغلقة أصلًا */ }
    throw error;
  }
}

/* ---------------------------- طبقة HTTP ---------------------------- */

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* تقديم ملفات الواجهة من مجلد الخادم نفسه (قراءة فقط داخل الحاوية) */
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'مسار غير صالح.' });
  }
  if (decoded === '/' || decoded === '') decoded = '/index.html';

  const filePath = path.normalize(path.join(APP_ROOT, decoded));
  if (filePath !== APP_ROOT && !filePath.startsWith(APP_ROOT + path.sep)) {
    return sendJson(res, 403, { error: 'مسار ممنوع.' });
  }

  let data;
  try {
    data = readFileSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'الملف غير موجود.' });
  }

  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const { pathname } = url;

    if (pathname === '/api/stock') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'الطريقة غير مسموحة.' });
      }
      return sendJson(res, 200, { items: stmtListStock.all() });
    }

    if (pathname === '/api/transfers') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { items: stmtListTransfers.all() });
      }
      if (req.method === 'POST') {
        let raw;
        try {
          raw = await readBody(req);
        } catch {
          return sendJson(res, 400, { error: 'تعذر قراءة جسم الطلب.' });
        }

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'JSON معطوب.' }); // ويستمر الخادم في العمل
        }

        const [status, payload] = processTransfer(parsed);
        console.log(`POST /api/transfers -> ${status}`);
        return sendJson(res, status, payload);
      }
      return sendJson(res, 405, { error: 'الطريقة غير مسموحة.' });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'نقطة نهاية غير معروفة.' });
    }

    return serveStatic(res, pathname);
  } catch (error) {
    console.error('خطأ في معالجة الطلب:', error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'خطأ داخلي في الخادم.' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`خادم نقل المخزون يعمل على http://${HOST}:${PORT}`);
});

/* إبقاء الخادم حيًا رغم أي خطأ غير متوقع */
process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error);
});
process.on('unhandledRejection', (error) => {
  console.error('unhandledRejection:', error);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));