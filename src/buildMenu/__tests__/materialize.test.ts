import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { getAppProject } from '../../appbuilder/projects.js';
import { configureBuildMenu, handleBuildMenuRoutes } from '../../server/routes/buildMenu.js';
import { resetDb } from '../../server/sqliteStore.js';
import { resetGrants } from '../grants.js';
import { materialize, readPreview } from '../materialize.js';
import { readMobile, saveMobile } from '../../mobile/store.js';
import { currentConversion } from '../safari/platform.js';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-'));
}

test('website store writes a local preview and keeps the subtype', () => {
  const workspace = tempWorkspace();
  const result = materialize({ selection: { kind: 'website', subtype: 'store' }, workspace, title: 'متجر' });
  assert.equal(result.engine, 'loam-build');
  const preview = fs.readFileSync(path.join(workspace, 'app', 'preview.html'), 'utf8');
  assert.match(preview, /سلة/);
  assert.match(preview, /data-sku="دفتر"/);
  assert.match(preview, /صدّر الحالة/);
  assert.match(preview, /تعذرت قراءة السلة المحفوظة/);
  assert.doesNotMatch(preview, /https?:\/\//);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'loam-website.json'), 'utf8')).subtype, 'store');
  fs.writeFileSync(path.join(workspace, 'app', 'preview.html'), `${preview}\n<p>KEEP</p>\n`);
  const again = materialize({ selection: { kind: 'website', subtype: 'booking' }, workspace, title: 'حجز' });
  assert.equal(again.summary, 'store');
  assert.match(fs.readFileSync(path.join(workspace, 'app', 'preview.html'), 'utf8'), /KEEP/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'loam-website.json'), 'utf8')).subtype, 'store');
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('a second website generate does not fill a project that already has files', () => {
  const workspace = tempWorkspace();
  try {
    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace, title: 'هبوط' });
    const appFile = path.join(workspace, 'app', 'src', 'App.tsx');
    assert.equal(fs.existsSync(appFile), true);
    fs.writeFileSync(appFile, 'export const KEEP_APP = true;\n');
    fs.rmSync(path.join(workspace, 'app', 'package.json'));
    const again = materialize({ selection: { kind: 'website', subtype: 'store' }, workspace, title: 'متجر' });
    assert.equal(again.summary, 'landing');
    assert.equal(fs.readFileSync(appFile, 'utf8'), 'export const KEEP_APP = true;\n');
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'package.json')), false);

    const occupied = tempWorkspace();
    fs.mkdirSync(path.join(occupied, 'app'));
    fs.writeFileSync(path.join(occupied, 'app', 'user.txt'), 'KEEP-USER\n');
    assert.throws(
      () => materialize({ selection: { kind: 'website', subtype: 'store' }, workspace: occupied, title: 'متجر' }),
      (error: unknown) => error instanceof Error && error.message === 'invalid_request',
    );
    assert.equal(fs.readFileSync(path.join(occupied, 'app', 'user.txt'), 'utf8'), 'KEEP-USER\n');
    assert.equal(fs.existsSync(path.join(occupied, 'app', 'preview.html')), false);
    assert.equal(fs.existsSync(path.join(occupied, 'app', 'src', 'App.tsx')), false);
    fs.rmSync(occupied, { recursive: true, force: true });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a nonempty app directory keeps existing bytes and a wrong kind writes nothing', () => {
  const workspace = tempWorkspace();
  const occupied = tempWorkspace();
  try {
    const app = path.join(workspace, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'brief.txt'), 'حتى 2026-11-10\n');
    fs.writeFileSync(path.join(app, 'README.md'), 'KEEP-README\n');
    fs.writeFileSync(path.join(app, 'user.txt'), 'KEEP-USER\n');
    materialize({ selection: { kind: 'automation' }, workspace, title: 'تقرير' });
    assert.equal(fs.readFileSync(path.join(app, 'README.md'), 'utf8'), 'KEEP-README\n');
    assert.equal(fs.readFileSync(path.join(app, 'user.txt'), 'utf8'), 'KEEP-USER\n');
    assert.equal(fs.readFileSync(path.join(app, 'brief.txt'), 'utf8'), 'حتى 2026-11-10\n');
    const spec = JSON.parse(fs.readFileSync(path.join(app, 'automation.json'), 'utf8')) as { until?: string };
    assert.equal(spec.until, '2026-11-10T23:59:59.999Z');
    assert.equal(fs.existsSync(path.join(app, 'schedule.txt')), true);

    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: occupied, title: 'هبوط' });
    const appDir = path.join(occupied, 'app');
    const before = fs.readdirSync(appDir).sort();
    const preview = fs.readFileSync(path.join(appDir, 'preview.html'));
    const index = fs.readFileSync(path.join(appDir, 'index.html'));
    const appSource = fs.readFileSync(path.join(appDir, 'src', 'App.tsx'));
    assert.throws(
      () => materialize({ selection: { kind: 'automation' }, workspace: occupied, title: 'تقرير' }),
      (error: unknown) => error instanceof Error && error.message === 'invalid_request',
    );
    assert.throws(
      () => materialize({ selection: { kind: 'game' }, workspace: occupied, title: 'لعبة' }),
      (error: unknown) => error instanceof Error && error.message === 'invalid_request',
    );
    assert.deepEqual(fs.readdirSync(appDir).sort(), before);
    assert.deepEqual(fs.readFileSync(path.join(appDir, 'preview.html')), preview);
    assert.deepEqual(fs.readFileSync(path.join(appDir, 'index.html')), index);
    assert.deepEqual(fs.readFileSync(path.join(appDir, 'src', 'App.tsx')), appSource);
    assert.equal(fs.existsSync(path.join(appDir, 'automation.json')), false);
    assert.equal(fs.existsSync(path.join(appDir, 'tuning.json')), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(occupied, { recursive: true, force: true });
  }
});

test('desktop and widget reuse the electron template', () => {
  const desktop = tempWorkspace();
  const desktopResult = materialize({ selection: { kind: 'desktop' }, workspace: desktop, title: 'مكتب' });
  const desktopConfig = JSON.parse(fs.readFileSync(path.join(desktop, 'app', 'desktop-app.json'), 'utf8'));
  assert.equal(desktopConfig.surface, undefined);
  assert.equal(fs.existsSync(path.join(desktop, 'app', 'electron', 'main.cjs')), true);
  const desktopFile = fs.readFileSync(path.join(desktop, 'app', 'dist', 'index.html'), 'utf8');
  assert.equal(desktopFile.includes('id="countdown"'), false);
  assert.match(desktopFile, /script-src 'self'/);
  assert.match(desktopFile, /src="\.\/preview\.js"/);
  assert.equal(desktopResult.relativePreview, 'app/dist/index.html');
  const desktopShown = readPreview(desktop, desktopResult.relativePreview) ?? '';
  assert.match(desktopShown, /لا توجد ملاحظة بعد/);
  assert.match(desktopShown, /script-src 'unsafe-inline'/);
  assert.equal(desktopShown.includes('src="./preview.js"'), false);
  assert.equal(fs.readFileSync(path.join(desktop, 'app', 'dist', 'index.html'), 'utf8').includes('unsafe-inline'), false);
  fs.rmSync(desktop, { recursive: true, force: true });

  const widget = tempWorkspace();
  materialize({ selection: { kind: 'widget' }, workspace: widget, title: 'ويدجت' });
  const widgetConfig = JSON.parse(fs.readFileSync(path.join(widget, 'app', 'desktop-app.json'), 'utf8'));
  assert.equal(widgetConfig.surface, 'widget');
  const main = fs.readFileSync(path.join(widget, 'app', 'electron', 'main.cjs'), 'utf8');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  const widgetResult = materialize({ selection: { kind: 'widget' }, workspace: widget, title: 'ويدجت' });
  const page = readPreview(widget, widgetResult.relativePreview) ?? '';
  assert.match(page, /id="countdown"/);
  assert.equal(page.includes('src="./preview.js"'), false);
  assert.match(fs.readFileSync(path.join(widget, 'app', 'dist', 'index.html'), 'utf8'), /script-src 'self'/);
  const script = fs.readFileSync(path.join(widget, 'app', 'dist', 'preview.js'), 'utf8');
  assert.match(page, /id="countdown"/);
  assert.match(script, /clearInterval/);
  assert.equal(/https?:\/\//i.test(page), false);
  fs.rmSync(widget, { recursive: true, force: true });
});

test('preview text stays inside the project and refuses a page that is not a file', () => {
  const root = tempWorkspace();
  const outside = path.join(path.dirname(root), 'outside-secret.txt');
  fs.writeFileSync(outside, 'OUTSIDE_SECRET');
  try {
    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: root, title: 'هبوط' });
    assert.match(readPreview(root, 'app/preview.html') ?? '', /هبوط/);
    assert.equal(readPreview(root, '../outside-secret.txt'), undefined);
    assert.equal(readPreview(root, path.join(path.dirname(root), 'outside-secret.txt')), undefined);
    const page = path.join(root, 'app', 'preview.html');
    fs.rmSync(page);
    fs.mkdirSync(page);
    assert.throws(() => readPreview(root, 'app/preview.html'), /unsafe_path/);
    assert.equal(fs.statSync(page).isDirectory(), true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE_SECRET');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('a second desktop generate keeps the page and refuses a config that is not a file', () => {
  const root = tempWorkspace();
  try {
    materialize({ selection: { kind: 'desktop' }, workspace: root, title: 'مكتب' });
    const page = path.join(root, 'app', 'dist', 'index.html');
    const mainPath = path.join(root, 'app', 'electron', 'main.cjs');
    const main = fs.readFileSync(mainPath);
    fs.appendFileSync(page, '\n<!-- ملاحظة المستخدم -->\n');
    materialize({ selection: { kind: 'desktop' }, workspace: root, title: 'عنوان جديد' });
    const config = JSON.parse(fs.readFileSync(path.join(root, 'app', 'desktop-app.json'), 'utf8')) as { title?: string };
    assert.equal(config.title, 'عنوان جديد');
    assert.match(fs.readFileSync(page, 'utf8'), /ملاحظة المستخدم/);
    assert.deepEqual(fs.readFileSync(mainPath), main);
    const configPath = path.join(root, 'app', 'desktop-app.json');
    fs.rmSync(configPath);
    fs.mkdirSync(configPath);
    assert.throws(() => materialize({ selection: { kind: 'desktop' }, workspace: root, title: 'لا يكتب' }), /unsafe_path/);
    assert.equal(fs.statSync(configPath).isDirectory(), true);
    assert.equal(fs.readdirSync(configPath).length, 0);
    assert.match(fs.readFileSync(page, 'utf8'), /ملاحظة المستخدم/);
    assert.deepEqual(fs.readFileSync(mainPath), main);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automation dry-run stays local', () => {
  const workspace = tempWorkspace();
  const result = materialize({ selection: { kind: 'automation' }, workspace, title: 'تقرير' });
  assert.equal(result.engine, 'loam-schedule');
  const spec = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8'));
  assert.equal(spec.timezone, 'Asia/Qatar');
  assert.equal(spec.dryRun, true);
  assert.equal(spec.send, false);
  assert.equal(spec.enabled, false);
  assert.equal(Object.hasOwn(spec, 'until'), false);
  assert.match(fs.readFileSync(path.join(workspace, 'app', 'report.txt'), 'utf8'), /dry-run/);
  const preview = fs.readFileSync(path.join(workspace, 'app', 'preview.html'), 'utf8');
  assert.match(preview, /ماذا: تقرير محلي/);
  assert.match(preview, /2026-11-09T06:00:00.000Z/);
  assert.match(preview, /2026-11-16T06:00:00.000Z/);
  assert.match(preview, /2026-11-23T06:00:00.000Z/);
  assert.equal(preview.includes('<script'), false);
  assert.equal(result.relativePreview, 'app/preview.html');
  assert.equal(preview.includes('id="send-block"'), false);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('an automation brief end date limits the local schedule', () => {
  const workspace = tempWorkspace();
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app', 'brief.txt'), 'حتى 2026-11-10\n');
  materialize({ selection: { kind: 'automation' }, workspace, title: 'تقرير' });
  const spec = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8')) as { until?: string; send: boolean };
  assert.equal(spec.until, '2026-11-10T23:59:59.999Z');
  assert.equal(spec.send, false);
  const preview = fs.readFileSync(path.join(workspace, 'app', 'preview.html'), 'utf8');
  assert.match(preview, /حتى: 2026-11-10T23:59:59.999Z/);
  assert.match(preview, /2026-11-09T06:00:00.000Z/);
  assert.equal(preview.includes('2026-11-16'), false);
  fs.writeFileSync(path.join(workspace, 'app', 'brief.txt'), 'حتى later\n');
  fs.rmSync(path.join(workspace, 'app', 'automation.json'));
  materialize({ selection: { kind: 'automation' }, workspace, title: 'تقرير' });
  const open = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8')) as { until?: string };
  assert.equal(open.until, undefined);
  fs.writeFileSync(path.join(workspace, 'app', 'brief.txt'), 'حتى 2026-02-31\n');
  fs.rmSync(path.join(workspace, 'app', 'automation.json'));
  materialize({ selection: { kind: 'automation' }, workspace, title: 'تقرير' });
  const invalid = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8')) as { until?: string };
  assert.equal(invalid.until, undefined);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('a second game generate keeps the saved tuning and the page', () => {
  const workspace = tempWorkspace();
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app', 'brief.txt'), 'هدف قريب\n');
  materialize({ selection: { kind: 'game' }, workspace, title: 'لعبة' });
  const page = path.join(workspace, 'app', 'index.html');
  const tuning = path.join(workspace, 'app', 'tuning.json');
  const html = fs.readFileSync(page, 'utf8').replace('<h1>لعبة</h1>', '<h1>KEEP-GAME</h1>');
  fs.writeFileSync(page, html);
  fs.writeFileSync(tuning, '{"speed":80,"gravity":700}\n');
  fs.writeFileSync(path.join(workspace, 'app', 'brief.txt'), 'هدف بعيد\n');
  const again = materialize({ selection: { kind: 'game' }, workspace, title: 'عنوان آخر' });
  const kept = fs.readFileSync(page, 'utf8');
  assert.equal(again.summary, 'canvas');
  assert.match(kept, /<h1>KEEP-GAME<\/h1>/);
  assert.match(kept, /const GOAL=420/);
  assert.equal(fs.readFileSync(tuning, 'utf8'), '{"speed":80,"gravity":700}\n');
  fs.writeFileSync(tuning, '{');
  assert.throws(() => materialize({ selection: { kind: 'game' }, workspace, title: 'لعبة' }), /invalid_tuning/);
  assert.match(fs.readFileSync(page, 'utf8'), /KEEP-GAME/);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('a second mobile generate keeps the edited screen', () => {
  const workspace = tempWorkspace();
  try {
    const first = materialize({ selection: { kind: 'mobile' }, workspace, title: 'دفتر' });
    assert.equal(first.relativePreview, 'app/simulation.html');
    const preview = readPreview(workspace, first.relativePreview) ?? '';
    assert.match(preview, /دفتر/);
    assert.match(preview, /ليست محاكياً أصلياً/);
    assert.equal(preview.includes('classes.dex'), false);
    const current = readMobile(workspace);
    assert.ok(current);
    saveMobile(workspace, {
      ...current,
      screens: current.screens.map((screen, index) => index === 0 ? { ...screen, title: 'KEEP-SCREEN' } : screen),
    }, current.revision);
    const revision = readMobile(workspace)?.revision;
    materialize({ selection: { kind: 'mobile' }, workspace, title: 'عنوان آخر' });
    const kept = readMobile(workspace);
    assert.equal(kept?.screens[0]?.title, 'KEEP-SCREEN');
    assert.equal(kept?.revision, revision);
    assert.match(readPreview(workspace, 'app/simulation.html') ?? '', /KEEP-SCREEN/);
    const page = path.join(workspace, 'app', 'simulation.html');
    fs.rmSync(page);
    fs.mkdirSync(page);
    assert.throws(() => materialize({ selection: { kind: 'mobile' }, workspace, title: 'دفتر' }), /unsafe_path/);
    assert.equal(readMobile(workspace)?.screens[0]?.title, 'KEEP-SCREEN');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a second notebook generate keeps the cell id and the edited source', () => {
  const workspace = tempWorkspace();
  try {
    const first = materialize({ selection: { kind: 'notebook' }, workspace, title: 'دفتر' });
    assert.equal(first.relativePreview, 'app/preview.html');
    const shown = readPreview(workspace, first.relativePreview) ?? '';
    assert.match(shown, /nbformat 4/);
    assert.match(shown, /print\(&quot;loam&quot;\)/);
    assert.equal(shown.includes('<script'), false);
    const file = path.join(workspace, 'app', 'notebook.ipynb');
    const book = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: Array<{ id: string; source: string[] }> };
    assert.equal(book.cells[0]?.id, 'cell-1');
    book.cells[0]!.id = 'cell-kept';
    book.cells[0]!.source = ['print("KEEP-CELL")\n'];
    fs.writeFileSync(file, `${JSON.stringify(book)}\n`);
    const again = materialize({ selection: { kind: 'notebook' }, workspace, title: 'دفتر آخر' });
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: Array<{ id: string; source: string[] }> };
    assert.equal(again.summary, 'nbformat 4');
    assert.equal(kept.cells[0]?.id, 'cell-kept');
    assert.equal(kept.cells[0]?.source[0], 'print("KEEP-CELL")\n');
    assert.match(readPreview(workspace, 'app/preview.html') ?? '', /KEEP-CELL/);
    const page = path.join(workspace, 'app', 'preview.html');
    fs.rmSync(page);
    fs.mkdirSync(page);
    assert.throws(() => materialize({ selection: { kind: 'notebook' }, workspace, title: 'دفتر' }), /unsafe_path/);
    assert.match(fs.readFileSync(file, 'utf8'), /KEEP-CELL/);
    fs.rmSync(page, { recursive: true });
    fs.writeFileSync(file, '{');
    assert.throws(() => materialize({ selection: { kind: 'notebook' }, workspace, title: 'دفتر' }), /invalid_notebook/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a second automation generate keeps a local routine that was turned on', () => {
  const workspace = tempWorkspace();
  materialize({ selection: { kind: 'automation' }, workspace, title: 'تقرير' });
  const specPath = path.join(workspace, 'app', 'automation.json');
  const previewPath = path.join(workspace, 'app', 'preview.html');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { enabled: boolean; previewCount: number; send: boolean };
  spec.enabled = true;
  spec.previewCount = 3;
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  fs.writeFileSync(previewPath, fs.readFileSync(previewPath, 'utf8').replace('<title>تقرير محلي</title>', '<title>KEEP-SCHEDULE</title>'));
  const again = materialize({ selection: { kind: 'automation' }, workspace, title: 'عنوان آخر' });
  const kept = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { enabled: boolean; previewCount: number; send: boolean };
  assert.equal(again.summary, '0 9 * * 1 Asia/Qatar');
  assert.equal(kept.enabled, true);
  assert.equal(kept.previewCount, 3);
  assert.equal(kept.send, false);
  assert.match(fs.readFileSync(previewPath, 'utf8'), /KEEP-SCHEDULE/);
  kept.send = true;
  fs.writeFileSync(specPath, `${JSON.stringify(kept, null, 2)}\n`);
  assert.throws(() => materialize({ selection: { kind: 'automation' }, workspace, title: 'تقرير' }), /approval_required/);
  assert.equal(JSON.parse(fs.readFileSync(specPath, 'utf8')).enabled, true);
  assert.match(fs.readFileSync(previewPath, 'utf8'), /KEEP-SCHEDULE/);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('an automation send brief stays blocked and does not copy the address', () => {
  const workspace = tempWorkspace();
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app', 'brief.txt'), 'أرسل الملخص إلى user@example.com كل صباح\n');
  materialize({ selection: { kind: 'automation' }, workspace, title: 'تقرير' });
  const spec = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'automation.json'), 'utf8')) as { send: boolean };
  const preview = fs.readFileSync(path.join(workspace, 'app', 'preview.html'), 'utf8');
  assert.equal(spec.send, false);
  assert.match(preview, /id="send-block"/);
  assert.match(preview, /لم تُرسل رسالة/);
  assert.equal(preview.includes('user@example.com'), false);
  assert.equal(preview.includes('<script'), false);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('a popup preview inlines its local script and does not point outside', () => {
  const root = tempWorkspace();
  const outside = path.join(path.dirname(root), 'outside-script.js');
  fs.writeFileSync(outside, 'OUTSIDE_SCRIPT');
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace: root, title: 'إضافة' });
    const shown = readPreview(root, 'app/popup.html') ?? '';
    assert.match(shown, /missing_chrome/);
    assert.equal(shown.includes('src="popup.js"'), false);
    assert.match(fs.readFileSync(path.join(root, 'app', 'popup.html'), 'utf8'), /src="popup.js"/);
    const script = path.join(root, 'app', 'popup.js');
    fs.rmSync(script);
    fs.mkdirSync(script);
    assert.throws(() => readPreview(root, 'app/popup.html'), /unsafe_path/);
    fs.rmSync(script, { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'popup.html'), '<script src="../outside-script.js"></script>');
    assert.throws(() => readPreview(root, 'app/popup.html'), /unsafe_path/);
    fs.writeFileSync(path.join(root, 'app', 'popup.html'), '<script src="https://evil.test/a.js"></script>');
    assert.throws(() => readPreview(root, 'app/popup.html'), /unsafe_path/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE_SCRIPT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('notebook is nbformat 4 and mobile has one screen', () => {
  const notebookRoot = tempWorkspace();
  materialize({ selection: { kind: 'notebook' }, workspace: notebookRoot, title: 'دفتر' });
  const notebook = JSON.parse(fs.readFileSync(path.join(notebookRoot, 'app', 'notebook.ipynb'), 'utf8'));
  assert.equal(notebook.nbformat, 4);
  assert.equal(notebook.cells[0].cell_type, 'code');
  fs.rmSync(notebookRoot, { recursive: true, force: true });

  const mobileRoot = tempWorkspace();
  materialize({ selection: { kind: 'mobile' }, workspace: mobileRoot, title: 'جوال' });
  const project = readMobile(mobileRoot);
  assert.equal(project?.screens.length, 1);
  assert.equal(project?.screens[0]?.kind, 'primary');
  fs.rmSync(mobileRoot, { recursive: true, force: true });
});

test('extensions stay local and games expose a canvas loop', () => {
  const chrome = tempWorkspace();
  materialize({ selection: { kind: 'chrome-extension' }, workspace: chrome, title: 'إضافة' });
  const manifest = JSON.parse(fs.readFileSync(path.join(chrome, 'app', 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.doesNotMatch(fs.readFileSync(path.join(chrome, 'app', 'popup.html'), 'utf8'), /https?:\/\//);
  fs.rmSync(chrome, { recursive: true, force: true });

  const safari = tempWorkspace();
  materialize({ selection: { kind: 'safari-extension' }, workspace: safari, title: 'سفاري' });
  const conversion = JSON.parse(fs.readFileSync(path.join(safari, 'app', 'conversion.json'), 'utf8'));
  assert.equal(conversion.conversion, currentConversion());
  assert.equal(conversion.safariTested, false);
  fs.rmSync(safari, { recursive: true, force: true });

  const game = tempWorkspace();
  materialize({ selection: { kind: 'game' }, workspace: game, title: 'لعبة' });
  const html = fs.readFileSync(path.join(game, 'app', 'index.html'), 'utf8');
  assert.match(html, /<h1>لعبة<\/h1>/);
  assert.match(html, /function step/);
  assert.match(html, /const GOAL=600/);
  assert.match(html, /id="scene">هدف بعيد/);
  assert.match(html, /<canvas\b/);
  assert.match(html, /requestAnimationFrame\s*\(/);
  assert.match(html, /window\.__errors\s*=/);
  assert.match(html, /keydown/);
  assert.doesNotMatch(html, /https?:\/\//);
  fs.rmSync(game, { recursive: true, force: true });

  const named = tempWorkspace();
  materialize({ selection: { kind: 'game' }, workspace: named, title: '<img src=x> http://example.test' });
  const namedHtml = fs.readFileSync(path.join(named, 'app', 'index.html'), 'utf8');
  assert.match(namedHtml, /&lt;img/);
  assert.equal(namedHtml.includes('<img'), false);
  assert.doesNotMatch(namedHtml, /https?:\/\//);
  assert.match(namedHtml, /function step/);
  fs.rmSync(named, { recursive: true, force: true });
});

test('a game brief chooses the near scene without copying the brief', () => {
  const game = tempWorkspace();
  fs.mkdirSync(path.join(game, 'app'), { recursive: true });
  fs.writeFileSync(path.join(game, 'app', 'brief.txt'), 'هدف قريب HOSTILE http://example.test\n');
  materialize({ selection: { kind: 'game' }, workspace: game, title: 'لعبة' });
  const html = fs.readFileSync(path.join(game, 'app', 'index.html'), 'utf8');
  assert.match(html, /const GOAL=420/);
  assert.match(html, /id="scene">هدف قريب/);
  assert.equal(html.includes('HOSTILE'), false);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /function step/);
  fs.rmSync(game, { recursive: true, force: true });
});

test('materialize throws unsafe_path when a scaffold file path is a directory and keeps the marker', () => {
  const workspace = tempWorkspace();
  const scaffold = path.join(workspace, 'app', 'routine.json');
  const marker = path.join(scaffold, 'marker.txt');
  fs.mkdirSync(scaffold, { recursive: true });
  fs.writeFileSync(marker, 'KEEP-MARKER\n');
  try {
    assert.throws(
      () => materialize({ selection: { kind: 'automation' }, workspace, title: 'تقرير' }),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    assert.equal(fs.lstatSync(scaffold).isDirectory(), true);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'KEEP-MARKER\n');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('creating a game keeps the app brief for its scene and shows the local plan brief', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-brief-'));
  const previousData = process.env.LOAM_DATA_DIR;
  const previousWorkspace = process.env.LOAM_WORKSPACE;
  process.env.LOAM_DATA_DIR = path.join(root, 'data');
  process.env.LOAM_WORKSPACE = path.join(root, 'workspace');
  resetDb();
  resetGrants();
  configureBuildMenu(true);
  try {
    const response = { status: 0, body: '', writeHead(code: number) { this.status = code; }, end(text: string) { this.body = text; } };
    const req = Readable.from([Buffer.from(JSON.stringify({
      title: 'لعبة',
      brief: 'ابنِ هدف قريب HOSTILE',
      selection: { kind: 'game' },
    }))]) as http.IncomingMessage;
    req.method = 'POST';
    req.headers = { origin: 'app://agent', 'x-loam-local-token': 'token-token' };
    req.url = '/';
    await handleBuildMenuRoutes(req, response as unknown as http.ServerResponse, '/api/build-menu/projects');
    assert.equal(response.status, 200, response.body);
    const project = getAppProject(JSON.parse(response.body).projectId as string);
    assert.ok(project);
    assert.equal(fs.readFileSync(path.join(project.workspaceDir, 'app', 'brief.txt'), 'utf8'), 'ابنِ هدف قريب HOSTILE');
    materialize({ selection: { kind: 'game' }, workspace: project.workspaceDir, title: 'لعبة' });
    const html = fs.readFileSync(path.join(project.workspaceDir, 'app', 'index.html'), 'utf8');
    assert.match(html, /const GOAL=420/);
    assert.match(html, /id="brief">ابنِ هدف قريب HOSTILE<\/p>/);
  } finally {
    configureBuildMenu(false);
    resetGrants();
    resetDb();
    if (previousData === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previousData;
    if (previousWorkspace === undefined) delete process.env.LOAM_WORKSPACE;
    else process.env.LOAM_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
