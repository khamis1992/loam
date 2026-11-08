/**
 * recordApprovedExtension refuses to write the sha256 note when that
 * destination exists and nlink is greater than 1, and leaves the outside bytes
 * unchanged. A new file still writes. Host permissions, all_urls,
 * externally_connectable, world MAIN, match_about_blank, and
 * match_origin_as_fallback stay refused. This file does not launch Chrome.
 * Hard links are real files. It does not create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/chromeDigestHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertExtensionManifest, extensionPermissionDigest, recordApprovedExtension } from '../chrome/permissions.js';

const pagePolicy = "script-src 'self'; object-src 'self'";

function manifest(): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'ملاحظة',
    version: '0.1.0',
    action: { default_popup: 'popup.html' },
    permissions: ['activeTab', 'scripting', 'storage'],
    content_security_policy: { extension_pages: pagePolicy },
  };
}

function withWorkspace(run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-chrome-digest-'));
  const workspace = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, 'app', 'manifest.json'), `${JSON.stringify(manifest())}\n`);
  try {
    run(workspace, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function notePath(workspace: string): string {
  const file = path.join(workspace, '.loam', 'build-menu', 'approved-extension.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function refused(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function storedSha(file: string): string {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { sha256?: unknown };
  assert.equal(typeof parsed.sha256, 'string');
  return parsed.sha256 as string;
}

test('the sha256 note checks nlink and does not launch Chrome', () => {
  const source = fs.readFileSync(new URL('../chrome/permissions.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export function recordApprovedExtension');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('export function approvedExtensionDigest'));
  assert.match(body, /stat\.nlink > 1/);
  assert.match(source, /nodeCode\(error\) === 'ENOENT'/);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(/child_process|spawn\(|execFile|chrome\.exe|openIsolatedChrome|--load-extension/i.test(source), false);
  assert.match(source, /externally_connectable !== undefined/);
  assert.match(source, /record\.world !== 'ISOLATED'/);
  assert.match(source, /match_about_blank !== false/);
  assert.match(source, /match_origin_as_fallback !== false/);
  assert.match(source, /<all_urls>/);
});

test('a new sha256 note and a regular nlink 1 file still write', () => {
  withWorkspace((workspace) => {
    const file = path.join(workspace, '.loam', 'build-menu', 'approved-extension.json');
    assert.equal(fs.existsSync(file), false);
    const digest = extensionPermissionDigest(manifest());
    const recorded = recordApprovedExtension(workspace);
    assert.equal(recorded, digest);
    const created = fs.lstatSync(file);
    assert.equal(created.isSymbolicLink(), false);
    assert.equal(created.isFile(), true);
    assert.equal(created.nlink, 1);
    assert.equal(storedSha(file), digest);

    const replaced = recordApprovedExtension(workspace);
    assert.equal(replaced, digest);
    const written = fs.lstatSync(file);
    assert.equal(written.isSymbolicLink(), false);
    assert.equal(written.isFile(), true);
    assert.equal(written.nlink, 1);
    assert.equal(storedSha(file), digest);
  });
});

test('an existing sha256 note with nlink greater than 1 is refused before write', () => {
  withWorkspace((workspace, outside) => {
    const file = notePath(workspace);
    const outsideFile = path.join(outside, 'approved-extension.json');
    const previous = Buffer.from('outside-sha256-note\n');
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    assert.throws(() => recordApprovedExtension(workspace), refused);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
  });
});

test('lstat EPERM is not swallowed and the outside bytes stay', () => {
  withWorkspace((workspace) => {
    const file = notePath(workspace);
    const previous = Buffer.from('regular-sha256-note\n');
    fs.writeFileSync(file, previous);
    assert.equal(fs.lstatSync(file).nlink, 1);
    const realLstatSync = fs.lstatSync;
    const resolved = path.resolve(file);
    fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === resolved) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    try {
      assert.throws(() => recordApprovedExtension(workspace), isEperm);
    } finally {
      fs.lstatSync = realLstatSync;
    }
    assert.equal(realLstatSync(file).nlink, 1);
    assert.equal(realLstatSync(file).isSymbolicLink(), false);
    assert.equal(realLstatSync(file).isFile(), true);
    assert.deepEqual(fs.readFileSync(file), previous);
  });
});

test('host permissions, all_urls, externally_connectable, and injection flags stay refused', () => {
  const allowed = manifest();
  const cases: Array<{ body: Record<string, unknown>; code: RegExp }> = [
    { body: { ...allowed, host_permissions: ['https://example.test/*'] }, code: /host_requires_review/ },
    { body: { ...allowed, host_permissions: ['<all_urls>'] }, code: /host_requires_review/ },
    { body: { ...allowed, permissions: ['<all_urls>'] }, code: /permission_requires_review/ },
    { body: { ...allowed, externally_connectable: { matches: ['https://example.test/*'] } }, code: /permission_requires_review/ },
    { body: { ...allowed, externally_connectable: {} }, code: /permission_requires_review/ },
    {
      body: { ...allowed, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], world: 'MAIN' }] },
      code: /permission_requires_review/,
    },
    {
      body: { ...allowed, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], match_about_blank: true }] },
      code: /permission_requires_review/,
    },
    {
      body: { ...allowed, content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], match_origin_as_fallback: true }] },
      code: /permission_requires_review/,
    },
  ];
  for (const item of cases) {
    let digest: string | undefined;
    assert.throws(() => {
      digest = extensionPermissionDigest(item.body);
    }, item.code);
    assert.equal(digest, undefined);
    assert.throws(() => assertExtensionManifest(item.body), item.code);
  }

  withWorkspace((workspace) => {
    const file = path.join(workspace, 'app', 'manifest.json');
    const note = path.join(workspace, '.loam', 'build-menu', 'approved-extension.json');
    for (const item of cases) {
      fs.writeFileSync(file, `${JSON.stringify(item.body)}\n`);
      assert.throws(() => recordApprovedExtension(workspace), item.code);
      assert.equal(fs.existsSync(note), false);
    }
  });
});
