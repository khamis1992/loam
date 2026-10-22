/**
 * server.mjs — خادم تطبيق حجز الغرف (عربي RTL)
 * ------------------------------------------------------------
 * • وحدات مدمجة فقط (node:http و node:sqlite و node:fs و node:path و node:url) — دون أي حزم npm.
 * • قاعدة بيانات SQLite حقيقية داخل الحاوية على المسار /tmp/bookings.sqlite.
 * • الجدول: bookings(id INTEGER PRIMARY KEY, room TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL)
 *   ويبدأ فارغًا (لا بيانات أولية).
 * • GET  /api/bookings → { items: [{ id, room, start, end }] }
 * • POST /api/bookings → يقبل { room, start, end } ويعيد 201 مع سجل الحجز،
 *   أو 400 عند بيانات غير صالحة (برسالة عربية)، أو 409 عند تعارض الفترة لنفس الغرفة دون أي تغيير.
 * • الفحص والإدخال داخل معاملة واحدة (BEGIN IMMEDIATE / COMMIT / ROLLBACK)
 *   بمعاملات ربط (placeholders) لمنع قبول طلبين متعارضين متزامنين.
 * • حدود الفترات نصف مفتوحة: newStart < existingEnd AND existingStart < newEnd
 *   (بداية جديدة تساوي نهاية السابق مسموحة، والغرف المختلفة مستقلة).
 * • يقدّم index.html كملف ثابت ويستمع على 127.0.0.1:3000.
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 3000;
const DB_PATH = '/tmp/bookings.sqlite'; // داخل الحاوية وقت التشغيل

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ------------------------- قاعدة البيانات ------------------------- */

let db;
try {
  db = new DatabaseSync(DB_PATH);
} catch (err) {
  console.error('تعذر فتح قاعدة البيانات ' + DB_PATH + ' :', err && err.message ? err.message : err);
  process.exit(1);
}

// مهلة انتظار قفل الكتابة حتى تُنجز المعاملات المتزامنة بالتسلسل بدل الفشل الفوري
db.exec('PRAGMA busy_timeout = 5000');

// إنشاء الجدول إن لم يوجد — القاعدة تبدأ فارغة (بدون أي بيانات أولية)
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id    INTEGER PRIMARY KEY,
    room  TEXT NOT NULL,
    start TEXT NOT NULL,
    "end" TEXT NOT NULL
  )
`);

// عبارات مُعدّة مسبقًا بمعاملات ربط — لا يُدمج أي إدخال من المستخدم داخل نص SQL
const stmtList     = db.prepare('SELECT id, room, start, "end" FROM bookings ORDER BY id');
const stmtConflict = db.prepare('SELECT id FROM bookings WHERE room = ? AND start < ? AND ? < "end"');
const stmtInsert   = db.prepare('INSERT INTO bookings (room, start, "end") VALUES (?, ?, ?)');
const stmtById     = db.prepare('SELECT id, room, start, "end" FROM bookings WHERE id = ?');

/* ------------------------- أدوات مساعدة ------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

/* ------------------------- التحقق من التواريخ ------------------------- */

// الصيغة الإلزامية: YYYY-MM-DDTHH:mm:ssZ (توقيت UTC)
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * يتحقق من مطابقة الصيغة ومن كون التاريخ فعليًا صحيحًا
 * (شهر 1-12، يوم مناسب للشهر مع السنوات الكبيسة، ساعة 0-23، دقيقة/ثانية 0-59)
 * عبر جولة كاملة Date.UTC ثم مقارنة المكونات. يعيد الزمن بالمللي ثانية أو null.
 */
function parseUtcDate(value) {
  if (typeof value !== 'string') return null;
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const Y = Number(m[1]);
  const MO = Number(m[2]);
  const D = Number(m[3]);
  const H = Number(m[4]);
  const MI = Number(m[5]);
  const S = Number(m[6]);
  const ms = Date.UTC(Y, MO - 1, D, H, MI, S);
  const dt = new Date(ms);
  const valid =
    dt.getUTCFullYear() === Y &&
    dt.getUTCMonth() === MO - 1 &&
    dt.getUTCDate() === D &&
    dt.getUTCHours() === H &&
    dt.getUTCMinutes() === MI &&
    dt.getUTCSeconds() === S;
  return valid ? ms : null;
}

/* ------------------------- معالجات API ------------------------- */

function listBookings(res) {
  try {
    const items = stmtList.all(); // [{ id, room, start, end }]
    sendJson(res, 200, { items });
  } catch (err) {
    console.error('فشل جلب الحجوزات:', err);
    sendJson(res, 500, { error: 'خطأ داخلي في الخادم' });
  }
}

function createBooking(res, rawBody) {
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return sendJson(res, 400, { error: 'صيغة الطلب غير صالحة: يلزم كائن JSON' });
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return sendJson(res, 400, { error: 'جسم الطلب يجب أن يكون كائن JSON يحوي room و start و end' });
  }

  const room = data.room;
  const start = data.start;
  const end = data.end;

  if (typeof room !== 'string' || room.trim() === '') {
    return sendJson(res, 400, { error: 'اسم الغرفة مطلوب: نص غير فارغ' });
  }
  const startMs = parseUtcDate(start);
  if (startMs === null) {
    return sendJson(res, 400, { error: 'تاريخ البداية غير صالح: استخدم صيغة UTC‏ YYYY-MM-DDTHH:mm:ssZ بتاريخ فعلي صحيح' });
  }
  const endMs = parseUtcDate(end);
  if (endMs === null) {
    return sendJson(res, 400, { error: 'تاريخ النهاية غير صالح: استخدم صيغة UTC‏ YYYY-MM-DDTHH:mm:ssZ بتاريخ فعلي صحيح' });
  }
  if (!(startMs < endMs)) {
    return sendJson(res, 400, { error: 'يجب أن تكون بداية الحجز قبل نهايته' });
  }

  // الفحص والإدخال داخل معاملة واحدة ذرّية لمنع قبول طلبين متعارضين متزامنين
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // تعارض نصف مفتوح لنفس الغرفة فقط:
      // newStart < existingEnd  AND  existingStart < newEnd
      // (المساواة مسموحة: بداية حجز جديد تساوي نهاية السابق)
      const clash = stmtConflict.get(room, end, start);
      if (clash) {
        db.exec('ROLLBACK'); // لا تغيير في البيانات إطلاقًا
        return sendJson(res, 409, { error: 'تعارض في الحجز: الغرفة «' + room + '» محجوزة بالفعل خلال هذه الفترة' });
      }
      const info = stmtInsert.run(room, start, end);
      db.exec('COMMIT');
      const row = stmtById.get(Number(info.lastInsertRowid)) || { id: Number(info.lastInsertRowid), room, start, end };
      return sendJson(res, 201, row); // { id, room, start, end }
    } catch (txErr) {
      try { db.exec('ROLLBACK'); } catch { /* تجاهل */ }
      throw txErr;
    }
  } catch (err) {
    console.error('فشل معاملة الحجز:', err);
    return sendJson(res, 500, { error: 'خطأ داخلي في الخادم' });
  }
}

/* ------------------------- الملفات الثابتة ------------------------- */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(res, pathname) {
  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = join(__dirname, 'index.html');
  } else {
    const rel = normalize(pathname).replace(/^[/\\]+/, '');
    filePath = normalize(join(__dirname, rel));
    if (filePath !== __dirname && !filePath.startsWith(__dirname + sep)) {
      return sendText(res, 404, '404 — غير موجود');
    }
  }
  try {
    const content = readFileSync(filePath);
    const type = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    return sendText(res, 404, '404 — الملف غير موجود');
  }
}

/* ------------------------- الخادم ------------------------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
    const pathname = url.pathname;

    if (pathname === '/api/bookings') {
      if (req.method === 'GET') return listBookings(res);
      if (req.method === 'POST') {
        let body;
        try {
          body = await readBody(req);
        } catch {
          return sendJson(res, 400, { error: 'تعذر قراءة جسم الطلب' });
        }
        return createBooking(res, body);
      }
      res.setHeader('Allow', 'GET, POST');
      return sendJson(res, 405, { error: 'طريقة غير مسموحة لهذا المسار' });
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'مسار API غير موجود' });
    }

    return serveStatic(res, pathname);
  } catch (err) {
    console.error('خطأ غير متوقع:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'خطأ داخلي في الخادم' });
    } else {
      try { res.end(); } catch { /* تجاهل */ }
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('خادم حجز الغرف يعمل على http://' + HOST + ':' + PORT);
  console.log('قاعدة البيانات: ' + DB_PATH);
});

server.on('error', (err) => {
  console.error('فشل تشغيل الخادم:', err && err.message ? err.message : err);
  process.exit(1);
});

function shutdown() {
  try { db.close(); } catch { /* تجاهل */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);