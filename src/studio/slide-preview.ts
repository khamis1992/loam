import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { ROOT } from '../config.js';
import { StudioError } from './store.js';
import {offlinePreviewCopy} from './word-preview.js';
import {runWordRenderProcess as runOfficeRenderProcess} from './word-render-process.js';
import { LruCache, byteSizeOfBytes } from '../memory/cache.js';
import { registerCacheStats } from '../memory/stats.js';

let queue: Promise<unknown> = Promise.resolve();
/** In-flight renders (J6): capped so a burst of distinct slides cannot queue
 *  unbounded promises. Matches the previous `pending.size >= 8` busy check. */
const pending = new LruCache<Promise<Buffer>>({ capacity: 8, name: 'slide-preview-pending' });
/** Rendered PNGs (J6): one slide preview is up to 50 MB, so the retained-byte
 *  ceiling matters more than the entry count. */
const cache = new LruCache<Buffer>({ capacity: 3, name: 'slide-preview', maxBytes: 96 * 1024 * 1024, sizeOf: byteSizeOfBytes });
registerCacheStats('slide-preview', () => cache.stats());
registerCacheStats('slide-preview-pending', () => pending.stats());

export async function renderSlidePreview(buffer: Buffer, slideNumber:number): Promise<Buffer> {
  if(!Number.isInteger(slideNumber)||slideNumber<1||slideNumber>200)throw new StudioError('Invalid slide number');
  if (process.platform !== 'win32') throw new StudioError('المعاينة المطابقة تتطلب Microsoft PowerPoint على Windows.', 503);
  const key = createHash('sha256').update(buffer).update(':').update(String(slideNumber)).digest('hex');
  const hit = cache.get(key); if (hit) return hit;
  const active = pending.get(key); if (active) return active;
  if (pending.size >= 8) throw new StudioError('محرك PowerPoint مشغول. أعد المحاولة بعد اكتمال المعاينات الحالية.', 503);
  const job = queue.then(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loam-slide-preview-'));
    try {
      const input = path.join(dir, 'slides.pptx'), output = path.join(dir, 'preview.png');
      await fs.writeFile(input, await offlinePreviewCopy(buffer));
      await runOfficeRenderProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/render-slide-preview.ps1'), '-InputFile', input, '-OutputFile', output, '-SlideNumber',String(slideNumber)], output)
        .catch(() => { throw new StudioError('تعذّر إنشاء المعاينة بواسطة PowerPoint. تأكد من تثبيته وإكمال تفعيله ثم أعد المحاولة.', 503); });
      const png = await fs.readFile(output);
      if (!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.length > 50_000_000) throw new StudioError('تعذّر قراءة معاينة PowerPoint.', 503);
      // LruCache enforces both caps itself (3 entries / 96 MB).
      cache.set(key, png);
      return png;
    } finally {
      // Clean up only the new instance recorded by our helper, including a timed-out conversion.
      try {
        const owner = JSON.parse((await fs.readFile(path.join(dir, 'preview.png.owner.json'), 'utf8')).replace(/^\uFEFF/, ''));
        if (Number.isSafeInteger(owner.id) && owner.id > 0 && /^\d+$/.test(owner.started)) {
          await new Promise<void>(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${owner.id} -ErrorAction SilentlyContinue; if($p -and $p.ProcessName -eq 'POWERPNT' -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${owner.started}'){Stop-Process -Id $p.Id -Force}`], { windowsHide: true, timeout: 10_000 }, () => resolve()));
        }
      } catch { /* PowerPoint closed normally or did not create a dedicated process. */ }
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  pending.set(key, job); queue = job.catch(() => {});
  try { return await job; } finally { pending.delete(key); }
}
