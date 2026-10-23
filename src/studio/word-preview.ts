import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StudioError } from './store.js';
import { safeZip, xml, serialize, all, W } from './ooxml.js';
import { wordRenderSession } from './word-render-session.js';
import { LruCache, byteSizeOfBytes } from '../memory/cache.js';
import { registerCacheStats } from '../memory/stats.js';

let queue: Promise<unknown> = Promise.resolve();
/** In-flight renders (J6): capped, matching the previous `pending.size >= 8` busy check. */
const pending = new LruCache<Promise<Buffer>>({ capacity: 8, name: 'word-preview-pending' });
/** Rendered PDFs (J6): a preview PDF is up to 50 MB, so the byte ceiling is the
 *  real bound; the entry cap keeps the working set small. */
const cache = new LruCache<Buffer>({ capacity: 6, name: 'word-preview', maxBytes: 128 * 1024 * 1024, sizeOf: byteSizeOfBytes });
registerCacheStats('word-preview', () => cache.stats());
registerCacheStats('word-preview-pending', () => pending.stats());

/** Prepare a disposable offline copy. Never change the imported/exported archive. */
export async function offlinePreviewCopy(buffer: Buffer): Promise<Buffer> {
  const zip = await safeZip(buffer);
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    if (file.name.endsWith('.rels')) {
      const doc = xml(await file.async('string'));
      for (const rel of all(doc, '*', 'Relationship')) {
        if (rel.getAttribute('TargetMode') === 'External' && !rel.getAttribute('Type').endsWith('/hyperlink')) rel.parentNode.removeChild(rel);
      }
      zip.file(file.name, serialize(doc));
    } else if (/^word\/.*\.xml$/.test(file.name)) {
      const doc = xml(await file.async('string'));
      for (const node of [...all(doc, W, 'fldChar'), ...all(doc, W, 'fldSimple')]) node.setAttributeNS(W, 'w:fldLock', 'true');
      for (const node of all(doc, W, 'updateFields')) node.setAttributeNS(W, 'w:val', 'false');
      zip.file(file.name, serialize(doc));
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function renderWordPreview(buffer: Buffer): Promise<Buffer> {
  if (process.platform !== 'win32') throw new StudioError('المعاينة المطابقة تتطلب Microsoft Word على Windows.', 503);
  const key = createHash('sha256').update(buffer).digest('hex');
  const hit = cache.get(key); if (hit) return hit;
  const active = pending.get(key); if (active) return active;
  if (pending.size >= 8) throw new StudioError('محرك Word مشغول. أعد المحاولة بعد اكتمال المعاينات الحالية.', 503);
  const job = queue.then(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loam-word-preview-'));
    try {
      const input = path.join(dir, 'document.docx'), output = path.join(dir, 'preview.pdf');
      await fs.writeFile(input, await offlinePreviewCopy(buffer));
      // The persistent dedicated Word session skips per-render startup; crashes and hangs
      // are recovered inside the session with one fresh-session retry.
      await wordRenderSession.render(input, output);
      const pdf = await fs.readFile(output);
      if (pdf.subarray(0, 5).toString() !== '%PDF-' || pdf.length > 50_000_000) throw new StudioError('تعذّر قراءة معاينة Word.', 503);
      // LruCache enforces both caps itself (6 entries / 128 MB).
      cache.set(key, pdf);
      return pdf;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  pending.set(key, job); queue = job.catch(() => {});
  try { return await job; } finally { pending.delete(key); }
}

