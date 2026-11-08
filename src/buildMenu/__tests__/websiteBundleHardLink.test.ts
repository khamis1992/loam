/**
 * Bundle writes for the build log, preview script, and index page throw
 * unsafe_path when that destination already exists and nlink is greater than 1.
 * The outside bytes stay. A missing file still writes. Hard links use
 * fs.linkSync. This file does not create a symlink or junction and does not
 * call npm.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/websiteBundleHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BuildMenuError } from '../grants.js';
import { buildWebsiteBundle, recordBlockedWebsiteBuild, recordWebsiteBuildFailure } from '../websites/bundle.js';
import { cartTotal, demoReply, reserve } from '../websites/demo.js';
import { websiteDocument } from '../websites/page.js';

const PREVIEW = '<p>صفحة محلية</p><script>const marker="bundle-local";</script>\n';
const NEXT_PREVIEW = '<p>صفحة محلية</p><script>const marker="bundle-next";</script>\n';
const SCRIPT = 'const marker="bundle-local";';
const NEXT_SCRIPT = 'const marker="bundle-next";';
const CHAT_SENTENCE = 'هذه محادثة تجريبية؛ لم يُرسل طلب أو يُنفذ حجز خارج هذا الجهاز.';

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function withFixture(run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-bundle-'));
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

function sealProject(workspace: string, preview = PREVIEW): void {
  const app = path.join(workspace, 'app');
  fs.mkdirSync(app, { recursive: true });
  const template = fileURLToPath(new URL('../../../templates/web-app/', import.meta.url));
  fs.copyFileSync(path.join(template, 'package.json'), path.join(app, 'package.json'));
  fs.copyFileSync(path.join(template, 'vite.config.ts'), path.join(app, 'vite.config.ts'));
  fs.writeFileSync(path.join(app, 'preview.html'), preview);
}

function plant(outside: string, destination: string, bytes: Buffer): string {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const outsideFile = path.join(outside, path.basename(destination));
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, destination);
  return outsideFile;
}

function assertLinked(file: string, outsideFile: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
}

function assertPlain(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

function withLstatError(targets: string[], run: () => void): void {
  const blocked = new Set(targets.map((file) => path.resolve(file)));
  const realLstatSync = fs.lstatSync;
  fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (blocked.has(path.resolve(String(target)))) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return realLstatSync(target, options);
  }) as typeof fs.lstatSync;
  try {
    run();
  } finally {
    fs.lstatSync = realLstatSync;
  }
}

test('bundle refuses a shared file and does not call npm or create a symlink', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../websites/bundle.ts', import.meta.url)), 'utf8');
  assert.match(source, /stat\.nlink > 1/);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('npm'), false);
  assert.equal(cartTotal([2500, 1200]), 3700);
  assert.throws(() => reserve(['2026-11-10T09:00'], '2026-11-10T09:00'), /slot_taken/);
  assert.equal(demoReply('مرحبا'), CHAT_SENTENCE);
  assert.equal(websiteDocument('دردشة', 'chatbot').includes(CHAT_SENTENCE), true);
  assert.equal(websiteDocument('حجز', 'booking').includes('slot_taken'), true);
});

test('a hard-linked build log throws unsafe_path before write and the outside bytes stay', () => {
  withFixture((workspace, outside) => {
    const log = path.join(workspace, '.loam', 'build-menu', 'build.log');
    const previous = Buffer.from('outside-build-log');
    const outsideFile = plant(outside, log, previous);
    assertLinked(log, outsideFile);
    assert.throws(() => recordBlockedWebsiteBuild(workspace), refused);
    assert.throws(() => recordWebsiteBuildFailure(workspace), refused);
    assert.deepEqual(fs.readFileSync(log), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertLinked(log, outsideFile);
  });
});

test('a hard-linked preview script throws unsafe_path before write and the outside bytes stay', () => {
  withFixture((workspace, outside) => {
    sealProject(workspace);
    const script = path.join(workspace, 'app', 'dist', 'page.js');
    const index = path.join(workspace, 'app', 'dist', 'index.html');
    const previous = Buffer.from('outside-page-js');
    const outsideFile = plant(outside, script, previous);
    assertLinked(script, outsideFile);
    assert.equal(fs.existsSync(index), false);
    assert.throws(() => buildWebsiteBundle(workspace), refused);
    assert.equal(fs.existsSync(index), false);
    assert.deepEqual(fs.readFileSync(script), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertLinked(script, outsideFile);
  });
});

test('a hard-linked index page throws unsafe_path before write and the outside bytes stay', () => {
  withFixture((workspace, outside) => {
    sealProject(workspace);
    const script = path.join(workspace, 'app', 'dist', 'page.js');
    const index = path.join(workspace, 'app', 'dist', 'index.html');
    const previous = Buffer.from('outside-index-html');
    const outsideFile = plant(outside, index, previous);
    assertLinked(index, outsideFile);
    assert.equal(fs.existsSync(script), false);
    assert.throws(() => buildWebsiteBundle(workspace), refused);
    assert.equal(fs.existsSync(script), false);
    assert.deepEqual(fs.readFileSync(index), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assertLinked(index, outsideFile);
  });
});

test('a new build log, preview script, and index page still write', () => {
  withFixture((workspace) => {
    const log = path.join(workspace, '.loam', 'build-menu', 'build.log');
    assert.equal(fs.existsSync(log), false);
    recordBlockedWebsiteBuild(workspace);
    assertPlain(log);
    assert.equal(fs.readFileSync(log, 'utf8').includes('لم يبدأ بناء القالب'), true);
    recordWebsiteBuildFailure(workspace);
    assertPlain(log);
    assert.equal(fs.readFileSync(log, 'utf8').includes('فشل بناء القالب'), true);

    sealProject(workspace);
    const script = path.join(workspace, 'app', 'dist', 'page.js');
    const index = path.join(workspace, 'app', 'dist', 'index.html');
    assert.equal(fs.existsSync(script), false);
    assert.equal(fs.existsSync(index), false);
    buildWebsiteBundle(workspace);
    assertPlain(script);
    assertPlain(index);
    assert.equal(fs.readFileSync(script, 'utf8'), SCRIPT);
    assert.equal(fs.readFileSync(index, 'utf8').includes('<script src="./page.js"></script>'), true);
    assert.equal(fs.readFileSync(index, 'utf8').includes('<script>'), false);

    fs.writeFileSync(path.join(workspace, 'app', 'preview.html'), NEXT_PREVIEW);
    buildWebsiteBundle(workspace);
    assertPlain(script);
    assertPlain(index);
    assert.equal(fs.readFileSync(script, 'utf8'), NEXT_SCRIPT);
    assertPlain(log);
  });
});

test('lstat EPERM is not swallowed and the outside bytes stay', () => {
  withFixture((workspace) => {
    const log = path.join(workspace, '.loam', 'build-menu', 'build.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const previousLog = Buffer.from('plain-build-log');
    fs.writeFileSync(log, previousLog);
    assertPlain(log);
    withLstatError([log], () => {
      assert.throws(() => recordBlockedWebsiteBuild(workspace), isEperm);
      assert.throws(() => recordWebsiteBuildFailure(workspace), isEperm);
    });
    assert.deepEqual(fs.readFileSync(log), previousLog);
    assertPlain(log);

    sealProject(workspace);
    const script = path.join(workspace, 'app', 'dist', 'page.js');
    const index = path.join(workspace, 'app', 'dist', 'index.html');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    const previousScript = Buffer.from('plain-page-js');
    const previousIndex = Buffer.from('plain-index-html');
    fs.writeFileSync(script, previousScript);
    fs.writeFileSync(index, previousIndex);
    assertPlain(script);
    assertPlain(index);
    withLstatError([script], () => {
      assert.throws(() => buildWebsiteBundle(workspace), isEperm);
    });
    withLstatError([index], () => {
      assert.throws(() => buildWebsiteBundle(workspace), isEperm);
    });
    assert.deepEqual(fs.readFileSync(script), previousScript);
    assert.deepEqual(fs.readFileSync(index), previousIndex);
    assertPlain(script);
    assertPlain(index);
  });
});
