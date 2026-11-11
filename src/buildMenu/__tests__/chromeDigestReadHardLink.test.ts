/**
 * Manifest and approved sha256 note reads throw unsafe_path when nlink is
 * greater than 1, before readFileSync, and do not return the outside bytes.
 * A regular nlink 1 file still reads. The write-side nlink check stays.
 * Host permissions, all_urls, externally_connectable, world MAIN,
 * match_about_blank, and match_origin_as_fallback stay refused.
 * This file does not launch Chrome. Hard links use fs.linkSync only.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/chromeDigestReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approvedExtensionDigest, assertExtensionManifest, extensionPermissionDigest, recordApprovedExtension } from '../chrome/permissions.js';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-perm-read-'));
  const workspace = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.mkdirSync(outside);
  try {
    run(workspace, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeManifest(workspace: string, body: Record<string, unknown> = manifest()): string {
  const file = path.join(workspace, 'app', 'manifest.json');
  fs.writeFileSync(file, `${JSON.stringify(body)}\n`);
  return file;
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

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test('both reads refuse nlink before readFileSync and the write check stays', () => {
  const source = fs.readFileSync(new URL('../chrome/permissions.ts', import.meta.url), 'utf8');
  const record = sliceBetween(source, 'export function recordApprovedExtension', 'function assertExclusiveNote');
  const manifestGuard = record.indexOf('assertExclusiveRead(');
  const manifestRead = record.indexOf('readFileSync');
  const writeGuard = record.lastIndexOf('assertExclusiveNote(');
  const writeAt = record.lastIndexOf('writeFileSync');
  assert.ok(manifestGuard >= 0 && manifestGuard < manifestRead);
  assert.ok(writeGuard > manifestRead && writeGuard < writeAt);

  const digest = sliceBetween(source, 'export function approvedExtensionDigest', 'function stringList');
  const noteGuard = digest.indexOf('assertExclusiveRead(');
  const noteRead = digest.indexOf('readFileSync');
  assert.ok(noteGuard >= 0 && noteGuard < noteRead);

  const reader = sliceBetween(source, 'function assertExclusiveRead', 'export function approvedExtensionDigest');
  assert.equal(reader.includes('catch'), false);
  assert.match(reader, /stat\.nlink > 1/);
  assert.equal(reader.includes('readFileSync'), false);

  const writer = sliceBetween(source, 'function assertExclusiveNote', 'function nodeCode');
  assert.match(writer, /stat\.nlink > 1/);
  assert.match(writer, /nodeCode\(error\) === 'ENOENT'/);
  assert.equal((source.match(/stat\.nlink > 1/g) ?? []).length, 2);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(/child_process|spawn\(|execFile|chrome\.exe|openIsolatedChrome|--load-extension/i.test(source), false);
  assert.match(source, /externally_connectable !== undefined/);
  assert.match(source, /record\.world !== 'ISOLATED'/);
  assert.match(source, /match_about_blank !== false/);
  assert.match(source, /match_origin_as_fallback !== false/);
  assert.match(source, /<all_urls>/);
});

test('a regular nlink 1 manifest and note still read', () => {
  withWorkspace((workspace) => {
    const manifestFile = writeManifest(workspace);
    const manifestStat = fs.lstatSync(manifestFile);
    assert.equal(manifestStat.isSymbolicLink(), false);
    assert.equal(manifestStat.isFile(), true);
    assert.equal(manifestStat.nlink, 1);
    assert.equal(approvedExtensionDigest(workspace), null);

    const digest = extensionPermissionDigest(manifest());
    const recorded = recordApprovedExtension(workspace);
    assert.equal(recorded, digest);
    const note = path.join(workspace, '.loam', 'build-menu', 'approved-extension.json');
    assert.equal(fs.lstatSync(note).nlink, 1);
    assert.equal(approvedExtensionDigest(workspace), digest);

    const localNote = '{"sha256":"local-nlink-1-note"}\n';
    fs.writeFileSync(note, localNote);
    assert.equal(fs.lstatSync(note).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(note).isFile(), true);
    assert.equal(fs.lstatSync(note).nlink, 1);
    assert.equal(approvedExtensionDigest(workspace), 'local-nlink-1-note');
    assert.equal(fs.readFileSync(note, 'utf8'), localNote);
    assert.equal(fs.lstatSync(manifestFile).nlink, 1);
  });
});

test('a hard-linked manifest is refused before read and the outside bytes stay', () => {
  withWorkspace((workspace, outside) => {
    const file = path.join(workspace, 'app', 'manifest.json');
    const outsideFile = path.join(outside, 'manifest.json');
    const previous = Buffer.from(`${JSON.stringify({ ...manifest(), name: 'outside-secret' })}\n`);
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);

    let returned: string | undefined;
    assert.throws(() => {
      returned = recordApprovedExtension(workspace);
    }, refused);
    assert.equal(returned, undefined);
    assert.equal(fs.existsSync(path.join(workspace, '.loam', 'build-menu', 'approved-extension.json')), false);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
  });
});

test('a hard-linked sha256 note is refused before read and the outside bytes stay', () => {
  withWorkspace((workspace, outside) => {
    const file = notePath(workspace);
    const outsideFile = path.join(outside, 'approved-extension.json');
    const previous = Buffer.from('{"sha256":"outside-secret-digest"}\n');
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);

    let returned: string | null | undefined;
    assert.throws(() => {
      returned = approvedExtensionDigest(workspace);
    }, refused);
    assert.equal(returned, undefined);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
  });
});

test('a hard-linked sha256 note is still refused before write', () => {
  withWorkspace((workspace, outside) => {
    const manifestFile = writeManifest(workspace);
    assert.equal(fs.lstatSync(manifestFile).nlink, 1);
    const file = notePath(workspace);
    const outsideFile = path.join(outside, 'approved-extension.json');
    const previous = Buffer.from('outside-sha256-note\n');
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);

    let returned: string | undefined;
    assert.throws(() => {
      returned = recordApprovedExtension(workspace);
    }, refused);
    assert.equal(returned, undefined);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(manifestFile), Buffer.from(`${JSON.stringify(manifest())}\n`));
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(manifestFile).nlink, 1);
  });
});

test('lstat EPERM is not swallowed before either read', () => {
  withWorkspace((workspace) => {
    const manifestFile = writeManifest(workspace);
    const manifestBytes = fs.readFileSync(manifestFile);
    assert.equal(fs.lstatSync(manifestFile).nlink, 1);
    const realLstatSync = fs.lstatSync;
    const manifestResolved = path.resolve(manifestFile);
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === manifestResolved) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    try {
      let returned: string | undefined;
      assert.throws(() => {
        returned = recordApprovedExtension(workspace);
      }, isEperm);
      assert.equal(returned, undefined);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assert.equal(fs.existsSync(path.join(workspace, '.loam', 'build-menu', 'approved-extension.json')), false);
    assert.equal(realLstatSync(manifestFile).nlink, 1);
    assert.deepEqual(fs.readFileSync(manifestFile), manifestBytes);

    const note = notePath(workspace);
    const previous = Buffer.from('{"sha256":"kept-local-note"}\n');
    fs.writeFileSync(note, previous);
    assert.equal(realLstatSync(note).nlink, 1);
    const noteResolved = path.resolve(note);
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === noteResolved) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    try {
      let returned: string | null | undefined;
      assert.throws(() => {
        returned = approvedExtensionDigest(workspace);
      }, isEperm);
      assert.equal(returned, undefined);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assert.equal(realLstatSync(note).nlink, 1);
    assert.equal(realLstatSync(note).isSymbolicLink(), false);
    assert.equal(realLstatSync(note).isFile(), true);
    assert.deepEqual(fs.readFileSync(note), previous);
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
      assert.equal(fs.lstatSync(file).nlink, 1);
      assert.throws(() => recordApprovedExtension(workspace), item.code);
      assert.equal(fs.existsSync(note), false);
    }
  });
});
