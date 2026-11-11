import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TIMEZONE } from '../../server/scheduleTime.js';
import { materialize, readPreview } from '../materialize.js';

const POPUP = '<button id="capture" type="button">LOCAL-POPUP</button>';
const OUTSIDE_POPUP = '<button id="capture" type="button">OUTSIDE-POPUP</button>';
const MANIFEST = `${JSON.stringify({
  manifest_version: 3,
  name: 'LOCAL-MANIFEST',
  version: '0.1.0',
  action: { default_popup: 'popup.html' },
  permissions: ['activeTab', 'scripting', 'storage'],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
})}\n`;
const OUTSIDE_MANIFEST = MANIFEST.replace('LOCAL-MANIFEST', 'OUTSIDE-MANIFEST');
const PAGE = '<h1>LOCAL-PAGE</h1><script>function step(){}</script>';
const OUTSIDE_PAGE = '<h1>OUTSIDE-PAGE</h1><script>function step(){}</script>';
const TUNING = '{"speed":80,"gravity":700}\n';
const OUTSIDE_TUNING = '{"speed":90,"gravity":700}\n';
const NOTEBOOK = `${JSON.stringify({ nbformat: 4, cells: [{ id: 'local-cell', source: 'print(1)\n' }] })}\n`;
const OUTSIDE_NOTEBOOK = `${JSON.stringify({ nbformat: 4, cells: [{ id: 'outside-cell', source: 'print(1)\n' }] })}\n`;
const CONFIG = '{"surface":"widget","title":"old","note":"LOCAL-CONFIG"}\n';
const OUTSIDE_CONFIG = '{"surface":"widget","title":"OUTSIDE"}\n';

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function withPair(prefix: string, run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  try {
    run(workspace, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeLocal(file: string, bytes: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

function linkFile(outsideDir: string, destination: string, name: string, bytes: string): string {
  const outsideFile = path.join(outsideDir, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, destination);
  const linked = fs.lstatSync(destination);
  assert.equal(linked.isSymbolicLink(), false);
  assert.equal(linked.isFile(), true);
  assert.equal(linked.nlink > 1, true);
  assert.equal(linked.ino, fs.lstatSync(outsideFile).ino);
  return outsideFile;
}

function unchanged(file: string, outsideFile: string, bytes: string): void {
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), bytes);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(file).nlink > 1, true);
  assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
}

function epermAfter(file: string, skip: number, run: () => void): void {
  const real = fs.lstatSync;
  let seen = 0;
  Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(target)) !== path.resolve(file)) return real(target, options);
    seen += 1;
    if (seen <= skip) return real(target, options);
    const error = new Error('operation not permitted') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    throw error;
  }) as typeof fs.lstatSync });
  try {
    assert.throws(run, isEperm);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: real });
  }
}

test('the write-side nlink check still runs before writeFileSync', () => {
  const source = fs.readFileSync(new URL('../materialize.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function writeFile('), source.indexOf('function ensureDesktopPreview'));
  const checkAt = body.indexOf('stat.nlink > 1');
  assert.equal(checkAt >= 0 && checkAt < body.indexOf('fs.writeFileSync'), true);
});

test('a hard-linked config is refused before read and the outside bytes stay', () => {
  withPair('loam-48-config-', (workspace, outside) => {
    const file = path.join(workspace, 'app', 'desktop-app.json');
    const outsideFile = linkFile(outside, file, 'desktop-app.json', OUTSIDE_CONFIG);
    assert.throws(
      () => materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace, title: 'موقع' }),
      isUnsafe,
    );
    unchanged(file, outsideFile, OUTSIDE_CONFIG);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'electron', 'main.cjs')), false);
  });
});

test('a regular nlink 1 config still reads the local surface', () => {
  withPair('loam-48-config-1-', (workspace) => {
    const file = path.join(workspace, 'app', 'desktop-app.json');
    writeLocal(file, CONFIG);
    const result = materialize({ selection: { kind: 'widget' }, workspace, title: 'ودجت' });
    assert.equal(result.summary, 'widget');
    const saved = fs.readFileSync(file, 'utf8');
    assert.equal(saved.includes('LOCAL-CONFIG'), true);
    assert.equal(saved.includes('"surface": "widget"'), true);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  });
});

test('a hard-linked preview is refused before read and the outside bytes stay', () => {
  withPair('loam-48-preview-', (workspace, outside) => {
    const file = path.join(workspace, 'app', 'preview.html');
    const bytes = '<p>OUTSIDE-PREVIEW</p>';
    const outsideFile = linkFile(outside, file, 'preview.html', bytes);
    assert.throws(() => readPreview(workspace, 'app/preview.html'), isUnsafe);
    unchanged(file, outsideFile, bytes);
  });
});

test('a regular nlink 1 preview still reads and a remote preview is still refused', () => {
  withPair('loam-48-preview-1-', (workspace) => {
    const file = path.join(workspace, 'app', 'preview.html');
    writeLocal(file, '<p>LOCAL-PREVIEW</p>');
    assert.equal(readPreview(workspace, 'app/preview.html'), '<p>LOCAL-PREVIEW</p>');
    assert.equal(fs.lstatSync(file).nlink, 1);
    writeLocal(file, '<a href="https://evil.example/a">x</a>');
    assert.throws(() => readPreview(workspace, 'app/preview.html'), isUnsafe);
  });
});

test('a hard-linked script is refused before read and the outside bytes stay', () => {
  withPair('loam-48-script-', (workspace, outside) => {
    const html = path.join(workspace, 'app', 'preview.html');
    const script = path.join(workspace, 'app', 'local.js');
    const bytes = 'var outsideScript = 1;\n';
    writeLocal(html, '<p>LOCAL-PREVIEW</p><script src="./local.js"></script>');
    const outsideFile = linkFile(outside, script, 'local.js', bytes);
    assert.throws(() => readPreview(workspace, 'app/preview.html'), isUnsafe);
    unchanged(script, outsideFile, bytes);
    assert.equal(fs.readFileSync(html, 'utf8').includes('outsideScript'), false);
  });
});

test('a regular nlink 1 script still reads into the preview', () => {
  withPair('loam-48-script-1-', (workspace) => {
    const html = path.join(workspace, 'app', 'preview.html');
    const script = path.join(workspace, 'app', 'local.js');
    writeLocal(html, '<p>LOCAL-PREVIEW</p><script src="./local.js"></script>');
    writeLocal(script, 'var localScript = 1;\n');
    const shown = readPreview(workspace, 'app/preview.html') ?? '';
    assert.equal(shown.includes('var localScript = 1;'), true);
    assert.equal(shown.includes('src="./local.js"'), false);
    assert.equal(fs.lstatSync(script).nlink, 1);
    assert.equal(fs.lstatSync(html).nlink, 1);
  });
});

test('a hard-linked popup is refused before read and the outside bytes stay', () => {
  withPair('loam-48-popup-', (workspace, outside) => {
    const popup = path.join(workspace, 'app', 'popup.html');
    const manifest = path.join(workspace, 'app', 'manifest.json');
    const outsideFile = linkFile(outside, popup, 'popup.html', OUTSIDE_POPUP);
    writeLocal(manifest, MANIFEST);
    assert.throws(
      () => materialize({ selection: { kind: 'chrome-extension' }, workspace, title: 'إضافة' }),
      isUnsafe,
    );
    unchanged(popup, outsideFile, OUTSIDE_POPUP);
    assert.equal(fs.readFileSync(manifest, 'utf8'), MANIFEST);
  });
});

test('a hard-linked manifest is refused before read and the outside bytes stay', () => {
  withPair('loam-48-manifest-', (workspace, outside) => {
    const popup = path.join(workspace, 'app', 'popup.html');
    const manifest = path.join(workspace, 'app', 'manifest.json');
    writeLocal(popup, POPUP);
    const outsideFile = linkFile(outside, manifest, 'manifest.json', OUTSIDE_MANIFEST);
    assert.throws(
      () => materialize({ selection: { kind: 'chrome-extension' }, workspace, title: 'إضافة' }),
      isUnsafe,
    );
    unchanged(manifest, outsideFile, OUTSIDE_MANIFEST);
    assert.equal(fs.readFileSync(popup, 'utf8'), POPUP);
  });
});

test('a regular nlink 1 popup and manifest still read', () => {
  withPair('loam-48-ext-1-', (workspace) => {
    const popup = path.join(workspace, 'app', 'popup.html');
    const manifest = path.join(workspace, 'app', 'manifest.json');
    writeLocal(popup, POPUP);
    writeLocal(manifest, MANIFEST);
    const result = materialize({ selection: { kind: 'chrome-extension' }, workspace, title: 'إضافة' });
    assert.equal(result.summary, 'chrome-extension');
    assert.equal(fs.readFileSync(popup, 'utf8'), POPUP);
    assert.equal(fs.readFileSync(manifest, 'utf8'), MANIFEST);
    assert.equal(fs.lstatSync(popup).nlink, 1);
    assert.equal(fs.lstatSync(manifest).nlink, 1);
  });
});

test('a hard-linked page is refused before the kind read and the outside bytes stay', () => {
  withPair('loam-48-page-kind-', (workspace, outside) => {
    const page = path.join(workspace, 'app', 'index.html');
    const bytes = 'OUTSIDE-PAGE-BYTES\n';
    const outsideFile = linkFile(outside, page, 'index.html', bytes);
    assert.throws(
      () => materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace, title: 'موقع' }),
      isUnsafe,
    );
    unchanged(page, outsideFile, bytes);
  });
});

test('a hard-linked game page is refused before read and the outside bytes stay', () => {
  withPair('loam-48-page-', (workspace, outside) => {
    const page = path.join(workspace, 'app', 'index.html');
    const tuning = path.join(workspace, 'app', 'tuning.json');
    const outsideFile = linkFile(outside, page, 'index.html', OUTSIDE_PAGE);
    writeLocal(tuning, TUNING);
    assert.throws(() => materialize({ selection: { kind: 'game' }, workspace, title: 'لعبة' }), isUnsafe);
    unchanged(page, outsideFile, OUTSIDE_PAGE);
    assert.equal(fs.readFileSync(tuning, 'utf8'), TUNING);
  });
});

test('a hard-linked tuning file is refused before read and the outside bytes stay', () => {
  withPair('loam-48-tuning-', (workspace, outside) => {
    const page = path.join(workspace, 'app', 'index.html');
    const tuning = path.join(workspace, 'app', 'tuning.json');
    writeLocal(page, PAGE);
    const outsideFile = linkFile(outside, tuning, 'tuning.json', OUTSIDE_TUNING);
    assert.throws(() => materialize({ selection: { kind: 'game' }, workspace, title: 'لعبة' }), isUnsafe);
    unchanged(tuning, outsideFile, OUTSIDE_TUNING);
    assert.equal(fs.readFileSync(page, 'utf8'), PAGE);
  });
});

test('a regular nlink 1 page and tuning file still read', () => {
  withPair('loam-48-game-1-', (workspace) => {
    const page = path.join(workspace, 'app', 'index.html');
    const tuning = path.join(workspace, 'app', 'tuning.json');
    writeLocal(page, PAGE);
    writeLocal(tuning, TUNING);
    const result = materialize({ selection: { kind: 'game' }, workspace, title: 'لعبة' });
    assert.equal(result.summary, 'canvas');
    assert.equal(fs.readFileSync(page, 'utf8'), PAGE);
    assert.equal(fs.readFileSync(tuning, 'utf8'), TUNING);
    assert.equal(fs.lstatSync(page).nlink, 1);
    assert.equal(fs.lstatSync(tuning).nlink, 1);
  });
});

test('a hard-linked notebook is refused before read and the outside bytes stay', () => {
  withPair('loam-48-notebook-', (workspace, outside) => {
    const file = path.join(workspace, 'app', 'notebook.ipynb');
    const outsideFile = linkFile(outside, file, 'notebook.ipynb', OUTSIDE_NOTEBOOK);
    assert.throws(() => materialize({ selection: { kind: 'notebook' }, workspace, title: 'دفتر' }), isUnsafe);
    unchanged(file, outsideFile, OUTSIDE_NOTEBOOK);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'preview.html')), false);
  });
});

test('a regular nlink 1 notebook still reads', () => {
  withPair('loam-48-notebook-1-', (workspace) => {
    const file = path.join(workspace, 'app', 'notebook.ipynb');
    writeLocal(file, NOTEBOOK);
    const result = materialize({ selection: { kind: 'notebook' }, workspace, title: 'دفتر' });
    assert.equal(result.summary, 'nbformat 4');
    assert.equal(fs.readFileSync(file, 'utf8').includes('local-cell'), true);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  });
});

test('a hard-linked website marker is refused before read and the outside bytes stay', () => {
  withPair('loam-48-marker-', (workspace, outside) => {
    const preview = path.join(workspace, 'app', 'preview.html');
    const marker = path.join(workspace, 'app', 'loam-website.json');
    const bytes = '{"subtype":"store"}\n';
    writeLocal(preview, '<p>LOCAL-PREVIEW</p>');
    const outsideFile = linkFile(outside, marker, 'loam-website.json', bytes);
    assert.throws(
      () => materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace, title: 'موقع' }),
      isUnsafe,
    );
    unchanged(marker, outsideFile, bytes);
    assert.equal(fs.readFileSync(preview, 'utf8'), '<p>LOCAL-PREVIEW</p>');
  });
});

test('a regular nlink 1 website marker still reads its subtype', () => {
  withPair('loam-48-marker-1-', (workspace) => {
    const preview = path.join(workspace, 'app', 'preview.html');
    const marker = path.join(workspace, 'app', 'loam-website.json');
    writeLocal(preview, '<p>LOCAL-PREVIEW</p>');
    writeLocal(marker, '{"subtype":"booking"}\n');
    const result = materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace, title: 'موقع' });
    assert.equal(result.summary, 'booking');
    assert.equal(fs.readFileSync(marker, 'utf8'), '{"subtype":"booking"}\n');
    assert.equal(fs.lstatSync(marker).nlink, 1);
  });
});

test('lstat EPERM is not swallowed before a config, preview, or script read', () => {
  withPair('loam-48-eperm-config-', (workspace) => {
    const file = path.join(workspace, 'app', 'desktop-app.json');
    writeLocal(file, CONFIG);
    epermAfter(file, 1, () => materialize({ selection: { kind: 'widget' }, workspace, title: 'ودجت' }));
    assert.equal(fs.readFileSync(file, 'utf8'), CONFIG);
    assert.equal(fs.lstatSync(file).nlink, 1);
  });
  withPair('loam-48-eperm-preview-', (workspace) => {
    const file = path.join(workspace, 'app', 'preview.html');
    writeLocal(file, '<p>LOCAL-PREVIEW</p>');
    epermAfter(file, 0, () => readPreview(workspace, 'app/preview.html'));
    assert.equal(fs.readFileSync(file, 'utf8'), '<p>LOCAL-PREVIEW</p>');
  });
  withPair('loam-48-eperm-script-', (workspace) => {
    const html = path.join(workspace, 'app', 'preview.html');
    const script = path.join(workspace, 'app', 'local.js');
    const bytes = 'var localScript = 1;\n';
    writeLocal(html, '<p>LOCAL-PREVIEW</p><script src="./local.js"></script>');
    writeLocal(script, bytes);
    epermAfter(script, 0, () => readPreview(workspace, 'app/preview.html'));
    assert.equal(fs.readFileSync(script, 'utf8'), bytes);
    assert.equal(fs.readFileSync(html, 'utf8').includes('localScript'), false);
  });
});

test('lstat EPERM is not swallowed before a popup, page, tuning, notebook, or marker read', () => {
  withPair('loam-48-eperm-popup-', (workspace) => {
    const popup = path.join(workspace, 'app', 'popup.html');
    const manifest = path.join(workspace, 'app', 'manifest.json');
    writeLocal(popup, POPUP);
    writeLocal(manifest, MANIFEST);
    epermAfter(popup, 0, () => materialize({ selection: { kind: 'chrome-extension' }, workspace, title: 'إضافة' }));
    assert.equal(fs.readFileSync(popup, 'utf8'), POPUP);
  });
  withPair('loam-48-eperm-page-', (workspace) => {
    const page = path.join(workspace, 'app', 'index.html');
    writeLocal(page, 'OUTSIDE-PAGE-BYTES\n');
    epermAfter(page, 0, () => materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace, title: 'موقع' }));
    assert.equal(fs.readFileSync(page, 'utf8'), 'OUTSIDE-PAGE-BYTES\n');
  });
  withPair('loam-48-eperm-tuning-', (workspace) => {
    const page = path.join(workspace, 'app', 'index.html');
    const tuning = path.join(workspace, 'app', 'tuning.json');
    writeLocal(page, PAGE);
    writeLocal(tuning, TUNING);
    epermAfter(tuning, 1, () => materialize({ selection: { kind: 'game' }, workspace, title: 'لعبة' }));
    assert.equal(fs.readFileSync(tuning, 'utf8'), TUNING);
    assert.equal(fs.readFileSync(page, 'utf8'), PAGE);
  });
  withPair('loam-48-eperm-notebook-', (workspace) => {
    const file = path.join(workspace, 'app', 'notebook.ipynb');
    writeLocal(file, NOTEBOOK);
    epermAfter(file, 1, () => materialize({ selection: { kind: 'notebook' }, workspace, title: 'دفتر' }));
    assert.equal(fs.readFileSync(file, 'utf8'), NOTEBOOK);
  });
  withPair('loam-48-eperm-marker-', (workspace) => {
    const preview = path.join(workspace, 'app', 'preview.html');
    const marker = path.join(workspace, 'app', 'loam-website.json');
    const bytes = '{"subtype":"booking"}\n';
    writeLocal(preview, '<p>LOCAL-PREVIEW</p>');
    writeLocal(marker, bytes);
    epermAfter(marker, 1, () => materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace, title: 'موقع' }));
    assert.equal(fs.readFileSync(marker, 'utf8'), bytes);
  });
});

const LOCAL_AUTOMATION = `${JSON.stringify({
  cron: '0 9 * * 1',
  timezone: DEFAULT_TIMEZONE,
  dryRun: true,
  enabled: false,
  send: false,
  previewCount: 0,
})}\n`;

test('a hard-linked automation spec is refused before read and the outside bytes stay', () => {
  withPair('loam-48-automation-', (workspace, outside) => {
    const file = path.join(workspace, 'app', 'automation.json');
    const bytes = 'OUTSIDE-AUTOMATION\n';
    const outsideFile = linkFile(outside, file, 'automation.json', bytes);
    assert.throws(() => materialize({ selection: { kind: 'automation' }, workspace, title: 'روتين' }), isUnsafe);
    unchanged(file, outsideFile, bytes);
  });
});

test('a regular nlink 1 automation spec still reads', () => {
  withPair('loam-48-automation-1-', (workspace) => {
    const file = path.join(workspace, 'app', 'automation.json');
    writeLocal(file, LOCAL_AUTOMATION);
    const result = materialize({ selection: { kind: 'automation' }, workspace, title: 'روتين' });
    assert.equal(result.summary, `0 9 * * 1 ${DEFAULT_TIMEZONE}`);
    assert.equal(fs.readFileSync(file, 'utf8'), LOCAL_AUTOMATION);
    assert.equal(fs.lstatSync(file).nlink, 1);
  });
});

test('lstat EPERM escapes before an automation spec is parsed', () => {
  withPair('loam-48-eperm-automation-', (workspace) => {
    const file = path.join(workspace, 'app', 'automation.json');
    writeLocal(file, LOCAL_AUTOMATION);
    epermAfter(file, 1, () => materialize({ selection: { kind: 'automation' }, workspace, title: 'روتين' }));
    assert.equal(fs.readFileSync(file, 'utf8'), LOCAL_AUTOMATION);
  });
});
