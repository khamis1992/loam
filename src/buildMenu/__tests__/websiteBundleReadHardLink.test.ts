/**
 * The preview HTML read throws unsafe_path when preview.html is a hard link
 * before readFileSync. Outside bytes stay unused. A regular nlink 1 preview
 * and build log still read. Hard links use fs.linkSync. This file does not
 * create a symlink or junction and does not call npm.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/websiteBundleReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BuildMenuError } from '../grants.js';
import { buildWebsiteBundle, recordBlockedWebsiteBuild } from '../websites/bundle.js';
import { cartTotal, demoReply, reserve } from '../websites/demo.js';
import { websiteDocument } from '../websites/page.js';

const LOCAL = '<p>صفحة محلية</p><script>const marker="bundle-local";</script>\n';
const OUTSIDE = '<p>صفحة محلية</p><script>const marker="outside-secret";</script>\n';
const SCRIPT = 'const marker="bundle-local";';
const PRIOR_LOG = 'prior-log-line\n';
const CHAT_SENTENCE = 'هذه محادثة تجريبية؛ لم يُرسل طلب أو يُنفذ حجز خارج هذا الجهاز.';

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function withFixture(run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-bundle-read-'));
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

function sealTemplate(workspace: string): void {
  const app = path.join(workspace, 'app');
  fs.mkdirSync(app, { recursive: true });
  const template = fileURLToPath(new URL('../../../templates/web-app/', import.meta.url));
  fs.copyFileSync(path.join(template, 'package.json'), path.join(app, 'package.json'));
  fs.copyFileSync(path.join(template, 'vite.config.ts'), path.join(app, 'vite.config.ts'));
}

function writePreview(workspace: string, html: string): string {
  const preview = path.join(workspace, 'app', 'preview.html');
  fs.writeFileSync(preview, html);
  return preview;
}

function assertPlain(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

test('store total, slot, and chatbot sentence stay put and the preview read checks nlink first', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../websites/bundle.ts', import.meta.url)), 'utf8');
  const bundle = source.slice(source.indexOf('export function buildWebsiteBundle'));
  const previewRead = bundle.indexOf('fs.readFileSync(preview');
  const previewGuard = bundle.indexOf('nlink > 1');
  assert.ok(previewGuard !== -1 && previewGuard < previewRead);
  const append = source.slice(source.indexOf('function appendBuildLog'), source.indexOf('const LOCAL_SCRIPT'));
  const logRead = append.indexOf('fs.readFileSync(file');
  const logGuard = append.lastIndexOf('assertRegularFile(workspace, file)', logRead);
  assert.ok(logGuard !== -1 && logGuard < logRead);
  assert.match(source, /stat\.nlink > 1/);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('npm'), false);
  assert.equal(cartTotal([2500, 1200]), 3700);
  assert.throws(() => reserve(['2026-11-10T09:00'], '2026-11-10T09:00'), /slot_taken/);
  assert.equal(demoReply('مرحبا'), CHAT_SENTENCE);
  assert.equal(websiteDocument('دردشة', 'chatbot').includes(CHAT_SENTENCE), true);
});

test('a regular build log and preview still read', () => {
  withFixture((workspace) => {
    const log = path.join(workspace, '.loam', 'build-menu', 'build.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, PRIOR_LOG);
    assertPlain(log);
    recordBlockedWebsiteBuild(workspace);
    assertPlain(log);
    const written = fs.readFileSync(log, 'utf8');
    assert.equal(written.includes(PRIOR_LOG.trim()), true);
    assert.equal(written.includes('لم يبدأ بناء القالب'), true);

    sealTemplate(workspace);
    const preview = writePreview(workspace, LOCAL);
    assertPlain(preview);
    buildWebsiteBundle(workspace);
    assertPlain(preview);
    assert.equal(fs.readFileSync(preview, 'utf8'), LOCAL);
    const script = path.join(workspace, 'app', 'dist', 'page.js');
    assertPlain(script);
    assert.equal(fs.readFileSync(script, 'utf8'), SCRIPT);
    assert.equal(fs.readFileSync(script, 'utf8').includes('outside-secret'), false);
  });
});

test('a hard-linked preview throws unsafe_path before read and the outside bytes stay', () => {
  withFixture((workspace, outside) => {
    sealTemplate(workspace);
    const preview = path.join(workspace, 'app', 'preview.html');
    const outsideFile = path.join(outside, 'preview.html');
    fs.writeFileSync(outsideFile, OUTSIDE);
    fs.linkSync(outsideFile, preview);
    const stat = fs.lstatSync(preview);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    const script = path.join(workspace, 'app', 'dist', 'page.js');
    const index = path.join(workspace, 'app', 'dist', 'index.html');
    assert.throws(() => buildWebsiteBundle(workspace), refused);
    assert.equal(fs.existsSync(script), false);
    assert.equal(fs.existsSync(index), false);
    assert.equal(fs.readFileSync(preview, 'utf8'), OUTSIDE);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), OUTSIDE);
    assert.equal(fs.lstatSync(preview).nlink > 1, true);
  });
});

test('preview lstat EPERM is not swallowed and the local bytes stay', () => {
  withFixture((workspace) => {
    sealTemplate(workspace);
    const preview = writePreview(workspace, LOCAL);
    assertPlain(preview);
    const realLstatSync = fs.lstatSync;
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) !== path.resolve(preview)) return realLstatSync(target, options);
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }) as typeof fs.lstatSync });
    try {
      assert.throws(() => buildWebsiteBundle(workspace), isEperm);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assertPlain(preview);
    assert.equal(fs.readFileSync(preview, 'utf8'), LOCAL);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'dist', 'page.js')), false);
  });
});
