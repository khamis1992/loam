import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from '../config.js';
import { StudioError } from './store.js';
import { runWordRenderProcess as runOfficeRenderProcess } from './word-render-process.js';

/** Office-native PDF export (Wave C of the office proposals). Word documents
 * reuse renderWordPreview (already PDF); decks and workbooks go through the
 * same owned-process COM pattern as the preview renderers: one export at a
 * time, ready-marker completion, PID+StartTime owner cleanup. */

let queue: Promise<unknown> = Promise.resolve();

const PDF_MAGIC = '%PDF-';
const MAX_INPUT_BYTES = 25_000_000;
const MAX_OUTPUT_BYTES = 50_000_000;

export type OfficePdfDeps = Partial<{ run: typeof runOfficeRenderProcess }>;

async function exportWithScript(
  script: string,
  processName: 'POWERPNT' | 'EXCEL',
  buffer: Buffer,
  ext: 'pptx' | 'xlsx',
  deps: OfficePdfDeps = {},
): Promise<Buffer> {
  if (process.platform !== 'win32') {
    throw new StudioError('تصدير PDF المطابق يتطلب Microsoft Office على Windows.', 503);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new StudioError('ملف Office فارغ أو غير صالح.', 400);
  if (buffer.length > MAX_INPUT_BYTES) throw new StudioError('الملف أكبر من الحد المسموح لتصدير PDF (25MB).', 413);
  const job = queue.then(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `loam-${ext}-pdf-`));
    try {
      const input = path.join(dir, `input.${ext}`), output = path.join(dir, 'export.pdf');
      await fs.writeFile(input, buffer);
      const run = deps.run ?? runOfficeRenderProcess;
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, script), '-InputFile', input, '-OutputFile', output], output)
        .catch(() => { throw new StudioError(`تعذّر إنشاء PDF بواسطة ${processName === 'POWERPNT' ? 'PowerPoint' : 'Excel'}. تأكد من تثبيت Microsoft Office وإكمال تفعيله ثم أعد المحاولة.`, 503); });
      const pdf = await fs.readFile(output);
      if (!pdf.subarray(0, PDF_MAGIC.length).toString('latin1').startsWith(PDF_MAGIC) || pdf.length > MAX_OUTPUT_BYTES) {
        throw new StudioError('تعذّر قراءة ملف PDF الناتج.', 503);
      }
      return pdf;
    } finally {
      // Clean up only the dedicated instance our script recorded, including a timed-out export.
      try {
        const ownerFile = path.join(dir, 'export.pdf.owner.json');
        const owner = JSON.parse((await fs.readFile(ownerFile, 'utf8')).replace(/^\uFEFF/, ''));
        if (Number.isSafeInteger(owner.id) && owner.id > 0 && /^\d+$/.test(owner.started)) {
          await new Promise<void>(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${owner.id} -ErrorAction SilentlyContinue; if($p -and $p.ProcessName -eq '${processName}' -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${owner.started}'){Stop-Process -Id $p.Id -Force}`], { windowsHide: true, timeout: 10_000 }, () => resolve()));
        }
      } catch { /* The Office app closed normally or did not create a dedicated process. */ }
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  queue = job.catch(() => {});
  return job;
}

/** Whole-deck PDF via the PowerPoint COM exporter (scripts/export-deck-pdf.ps1). */
export function renderDeckPdf(buffer: Buffer, deps: OfficePdfDeps = {}): Promise<Buffer> {
  return exportWithScript('scripts/export-deck-pdf.ps1', 'POWERPNT', buffer, 'pptx', deps);
}

/** Whole-workbook PDF via the Excel COM exporter (scripts/export-sheet-pdf.ps1). */
export function renderWorkbookPdf(buffer: Buffer, deps: OfficePdfDeps = {}): Promise<Buffer> {
  return exportWithScript('scripts/export-sheet-pdf.ps1', 'EXCEL', buffer, 'xlsx', deps);
}

/** Contained workspace read for PDF routes: extension whitelist + traversal guard + size cap. */
export async function readOfficeFileBytes(root: string, rel: string, exts: readonly string[]): Promise<Buffer> {
  const normalized = path.posix.normalize(String(rel ?? '').replaceAll('\\', '/')).replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('..') || normalized.includes('\0') || /^[a-z]:/i.test(normalized)) {
    throw new StudioError('مسار ملف غير صالح.', 400);
  }
  if (!exts.some(ext => normalized.toLowerCase().endsWith(ext))) throw new StudioError(`نوع الملف غير مدعوم. المتوقع: ${exts.join(' أو ')}.`, 400);
  const abs = path.resolve(root, normalized);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new StudioError('المسار خارج مساحة العمل.', 400);
  const stat = await fs.stat(abs).catch(() => { throw new StudioError('الملف غير موجود.', 404); });
  if (!stat.isFile()) throw new StudioError('المسار ليس ملفًا.', 400);
  if (stat.size > MAX_INPUT_BYTES) throw new StudioError('الملف أكبر من الحد المسموح لتصدير PDF (25MB).', 413);
  return fs.readFile(abs);
}
