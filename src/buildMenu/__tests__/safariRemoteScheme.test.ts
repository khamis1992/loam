import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { extensionFiles } from '../extensions/source.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { assertSafariHandoff, currentConversion, safariPreviewHtml } from '../safari/platform.js';
import { createSafariPorts } from '../safari/ports.js';

const NOTE = 'تصدير المصدر على هذا الجهاز مكتمل. لم يُختبر Safari نفسه.';
const SCHEMES = ['mailto', 'tel', 'sms', 'intent', 'market', 'javascript', 'data', 'file', 'blob'] as const;

const TAILS: Record<(typeof SCHEMES)[number], string> = {
  mailto: 'user@example.com',
  tel: '+97455500000',
  sms: '+97455500000',
  intent: '//scan/#Intent;end',
  market: '//details?id=com.example.app',
  javascript: 'alert(1)',
  data: 'text/html,hi',
  file: '///c:/secret',
  blob: 'null/uuid',
};

function localPage(): string {
  return `<!doctype html><p id="safari-untested">${NOTE}</p><a href="./notes.html">ملاحظة</a><form action="#save"></form><button id="capture" type="button" formaction="#stay">احفظ النص المحدد</button><script src="./popup.js"></script>`;
}

function refuses(html: string): void {
  assert.throws(
    () => safariPreviewHtml(html),
    (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    html,
  );
}

test('a local popup.html with a relative ./popup.js still passes', () => {
  const page = localPage();
  assert.equal(safariPreviewHtml(page), page);
  assert.match(page, /<script src="\.\/popup\.js"><\/script>/);

  const popup = extensionFiles('ملاحظة').find((file) => file.path === 'popup.html')?.content;
  assert.ok(popup);
  const preview = safariPreviewHtml(popup);
  assert.match(preview, /<script src="popup\.js"><\/script>/);
  assert.equal(safariPreviewHtml(preview), preview);
  assert.equal(preview.includes(NOTE), true);
});

test('safari preview refuses mailto, tel, sms, intent, market, javascript, data, file, and blob', () => {
  const page = localPage();
  for (const scheme of SCHEMES) {
    const tail = TAILS[scheme];
    for (const body of [`${scheme}:${tail}`, `${scheme.toUpperCase()}:${tail}`, `${scheme} :${tail}`]) {
      refuses(`${page}${body}`);
      refuses(`${page}<a href="${body}">x</a>`);
      refuses(`${page}<script src="${body}"></script>`);
      refuses(`${page}<form action="${body}"></form>`);
      refuses(`${page}<button formaction="${body}">x</button>`);
    }
  }
});

test('safari preview refuses percent-encoded forms of those schemes', () => {
  const page = localPage();
  for (const scheme of SCHEMES) {
    const tail = TAILS[scheme];
    for (const body of [`${scheme}%3a${tail}`, `${scheme.toUpperCase()}%3A${tail}`, `${scheme}%253a${tail}`]) {
      refuses(`${page}${body}`);
      refuses(`${page}<a href="${body}">x</a>`);
      refuses(`${page}<script src="${body}"></script>`);
    }
  }
});

test('safari preview refuses quote-split forms of those schemes', () => {
  const page = localPage();
  for (const scheme of SCHEMES) {
    const tail = TAILS[scheme];
    for (const body of [
      `${scheme}'+':${tail}`,
      `"${scheme}"+":${tail}"`,
      `"${scheme.toUpperCase()}" + ":"`,
      `"${scheme}"+"%3a${tail}"`,
      `${scheme}'+'%3a${tail}`,
    ]) {
      refuses(`${page}${body}`);
    }
  }
});

test('a directory named popup.html stays refused and win32 does not claim Safari or Xcode', async () => {
  if (process.platform === 'win32') assert.equal(currentConversion(), 'source-only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-scheme-'));
  try {
    materialize({ selection: { kind: 'safari-extension' }, workspace: root, title: 'ملاحظة' });
    const conversionPath = path.join(root, 'app', 'conversion.json');
    const stored = JSON.parse(fs.readFileSync(conversionPath, 'utf8')) as { conversion: string; platform: string; safariTested: boolean };
    assert.equal(stored.safariTested, false);
    assert.equal(stored.platform, process.platform);
    if (process.platform === 'win32') assert.equal(stored.conversion, 'source-only');

    const popup = path.join(root, 'app', 'popup.html');
    const html = fs.readFileSync(popup, 'utf8').replace('src="popup.js"', 'src="./popup.js"');
    fs.writeFileSync(popup, html);
    assertSafariHandoff(root);
    assert.equal(JSON.parse(fs.readFileSync(conversionPath, 'utf8')).safariTested, false);

    fs.writeFileSync(popup, `${html}<a href="mailto:user@example.com">x</a>`);
    assert.throws(
      () => assertSafariHandoff(root),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    assert.equal(fs.lstatSync(popup).isFile(), true);
    assert.equal(fs.lstatSync(popup).isSymbolicLink(), false);
    assert.equal(JSON.parse(fs.readFileSync(conversionPath, 'utf8')).safariTested, false);

    fs.rmSync(popup);
    fs.mkdirSync(popup);
    const marker = path.join(popup, 'marker.txt');
    fs.writeFileSync(marker, 'marker');
    assert.throws(
      () => assertSafariHandoff(root),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    const stat = fs.lstatSync(popup);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'marker');
    assert.equal(JSON.parse(fs.readFileSync(conversionPath, 'utf8')).safariTested, false);

    if (process.platform === 'win32') {
      const ports = createSafariPorts({ leases: new ProcessLeaseRegistry(200) });
      const selection: BuildManifest['selection'] = { kind: 'safari-extension' };
      const ctx: BuildJobContext = {
        workspace: root,
        jobId: 'job_safari_scheme',
        operation: { action: 'package', format: 'xcode-source' },
        signal: new AbortController().signal,
        manifest: {
          schemaVersion: 1,
          projectId: 'app_abcdefghijkl',
          revision: 1,
          selection,
          title: 'ملاحظة',
          sourceDir: 'app',
          template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
          consent: { autostart: false, publish: false },
        },
      };
      await assert.rejects(
        ports.export(ctx, 'xcode-source'),
        (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_platform' && error.status === 400,
      );
      assert.equal(JSON.parse(fs.readFileSync(conversionPath, 'utf8')).safariTested, false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
