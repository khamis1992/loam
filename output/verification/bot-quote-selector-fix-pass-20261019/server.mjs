/**
 * تطبيق عروض الأسعار (عربي RTL) — خادم Node.js بوحدات مدمجة فقط
 * المنفذ: 3000
 *
 * المسارات:
 *   GET  /            → index.html (صفحة ثابتة)
 *   GET  /<ملف>       → ملفات ثابتة من جذر المشروع
 *   POST /api/quote   → حساب المجاميع مع تحقق صارم للمدخلات
 *
 * واجهة POST /api/quote:
 *   الجسم: { items:[{sku, unitPriceCents, quantity}], discountPercent, shippingCents }
 *   النجاح 200: { subtotalCents, discountCents, shippingCents, totalCents } (هذه الحقول الأربعة فقط)
 *   أي مدخل مخالف أو JSON معطوب: 400 {"error":"invalid"}
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 1_000_000; // حد أقصى لحجم جسم الطلب (1MB)

/* ------------------------------ استجابات ------------------------------ */

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** كل مدخل مخالف أو JSON معطوب → 400 {"error":"invalid"} */
function invalid(res) {
  sendJson(res, 400, { error: 'invalid' });
}

/* --------------------------- التحقق الصارم --------------------------- */

/** عدد صحيح آمن ضمن مجال — دون أي تحويل للنصوص أو null إلى أرقام */
function isSafeIntInRange(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * يحسب عرض السعر من حمولة JSON بعد التحقق الصارم.
 * يعيد كائن الحقول الأربعة عند النجاح، أو null عند أي مخالفة.
 */
function computeQuote(payload) {
  // الجسم يجب أن يكون كائنًا عاديًا (ليس مصفوفة أو null أو نوعًا آخر)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const { items, discountPercent, shippingCents } = payload;

  // items: مصفوفة من 1 إلى 100 عنصرًا
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) return null;

  const seenSkus = new Set();
  let subtotalCents = 0;

  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;

    const { sku, unitPriceCents, quantity } = item;

    // sku: نص غير فارغ بعد trim وغير مكرر ضمن الطلب
    if (typeof sku !== 'string') return null;
    const trimmedSku = sku.trim();
    if (trimmedSku.length === 0) return null;
    if (seenSkus.has(trimmedSku)) return null;
    seenSkus.add(trimmedSku);

    // unitPriceCents: عدد صحيح آمن من 0 إلى 10000000
    if (!isSafeIntInRange(unitPriceCents, 0, 10_000_000)) return null;

    // quantity: عدد صحيح من 1 إلى 10000
    if (!isSafeIntInRange(quantity, 1, 10_000)) return null;

    subtotalCents += unitPriceCents * quantity;
  }

  // مجموع الأسعار قبل الخصم يجب ألا يتجاوز 1000000000 سنت
  if (subtotalCents > 1_000_000_000) return null;

  // discountPercent: عدد صحيح من 0 إلى 100
  if (!isSafeIntInRange(discountPercent, 0, 100)) return null;

  // shippingCents: عدد صحيح من 0 إلى 1000000
  if (!isSafeIntInRange(shippingCents, 0, 1_000_000)) return null;

  // الخصم: تقريب subtotalCents×discountPercent/100 إلى أقرب سنت والنصف للأعلى (Math.round)
  const discountCents = Math.round((subtotalCents * discountPercent) / 100);

  // الشحن يُضاف بعد الخصم ولا يدخل في حسابه
  const totalCents = subtotalCents - discountCents + shippingCents;

  // الحقول الأربعة فقط
  return { subtotalCents, discountCents, shippingCents, totalCents };
}

/* ------------------------- قراءة جسم الطلب ------------------------- */

function readJsonBody(req, res, onParsed) {
  const chunks = [];
  let received = 0;
  let settled = false;

  req.on('data', (chunk) => {
    if (settled) return; // تجاهل ما تبقى بعد الرد
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      settled = true;
      invalid(res); // جسم أكبر من الحد المسموح
      req.resume(); // تصريف بقية البيانات
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (settled) return;
    settled = true;
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      invalid(res); // JSON معطوب
      return;
    }
    onParsed(payload);
  });

  req.on('error', () => {
    if (!settled) {
      settled = true;
      res.destroy();
    }
  });
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
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  // منع تجاوز المسار خارج جذر المشروع
  const relative = path.normalize(decoded).replace(/^[/\\]+/, '');
  const filePath = path.resolve(ROOT, relative);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    let target = filePath;
    if (!statErr && stats.isDirectory()) target = path.join(filePath, 'index.html');

    fs.readFile(target, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const type = MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

/* ------------------------------ الخادم ------------------------------ */

const server = http.createServer((req, res) => {
  if (typeof req.url !== 'string' || !req.url.startsWith('/')) {
    invalid(res);
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    invalid(res);
    return;
  }
  const pathname = url.pathname;

  // واجهة API: POST /api/quote
  if (pathname === '/api/quote') {
    if (req.method !== 'POST') {
      res.writeHead(405, {
        Allow: 'POST',
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ error: 'invalid' }));
      return;
    }
    readJsonBody(req, res, (payload) => {
      const quote = computeQuote(payload);
      if (quote) sendJson(res, 200, quote);
      else invalid(res);
    });
    return;
  }

  // صفحات وملفات ثابتة
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }

  res.writeHead(405, { Allow: 'GET, HEAD, POST' });
  res.end();
});

server.listen(PORT, () => {
  console.log(`✅ خادم عروض الأسعار يعمل على المنفذ ${PORT}`);
});

server.on('error', (err) => {
  console.error('❌ فشل تشغيل الخادم:', err.message);
  process.exitCode = 1;
});