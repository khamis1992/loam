/**
 * kindRuntime refuses app/report.txt, app/automation.json, and app/manifest.json
 * when nlink is greater than 1, before readFileSync, and does not return the
 * outside bytes. A regular nlink 1 file still reads. Hard links come from
 * fs.linkSync. This file does not spawn a process, create a symlink, or create
 * a junction. Non-notebook executeCell stays unsupported. portable-exe writes
 * no exe. The write-side nlink check stays in place.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/kindRuntimeReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Artifact, BuildJobContext, BuildManifest, BuildProfile } from '../../../packages/shared/src/buildMenu.js';
import { automationProfile } from '../automations/profile.js';
import { chromeProfile } from '../chrome/profile.js';
import { BuildMenuError } from '../grants.js';
import { createKindPorts } from '../kindRuntime.js';
import { materialize } from '../materialize.js';
import type { ProcessLeaseRegistry } from '../processLease.js';

const desktopProfile: BuildProfile = {
  kind: 'desktop',
  preview: 'window',
  requirements: ['node', 'electron'],
  exports: ['source-zip', 'portable-exe'],
  network: 'loopback',
  externalEffects: 'approval-required',
};

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function blockedLeases(): { leases: ProcessLeaseRegistry; started: () => number } {
  let count = 0;
  const leases = {
    start(): never {
      count += 1;
      throw new Error('spawn refused');
    },
    async stop(): Promise<void> {
      throw new Error('spawn refused');
    },
  } as unknown as ProcessLeaseRegistry;
  return { leases, started: () => count };
}

function context(workspace: string, operation: BuildJobContext['operation'], kind: 'automation' | 'chrome-extension' | 'desktop'): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind };
  const title = kind === 'automation' ? 'روتين' : kind === 'chrome-extension' ? 'إضافة' : 'مكتب';
  return {
    workspace,
    jobId: `job_${kind}_read`,
    operation,
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 3,
      selection,
      title,
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

function pair(prefix: string): { workspace: string; outside: string } {
  return {
    workspace: fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    outside: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}out-`)),
  };
}

function removePair(workspace: string, outside: string): void {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

function exeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...exeFiles(absolute));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.exe')) found.push(absolute);
  }
  return found;
}

function artifactNames(workspace: string): string[] {
  const dir = path.join(workspace, '.loam', 'build-menu', 'artifacts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function linkOutside(workspaceFile: string, outsideFile: string, previous: Buffer): void {
  fs.rmSync(workspaceFile, { force: true });
  fs.writeFileSync(outsideFile, previous);
  fs.linkSync(outsideFile, workspaceFile);
  const stat = fs.lstatSync(workspaceFile);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
}

function watchRead(target: string): { saw: () => boolean; restore: () => void } {
  const realReadFileSync = fs.readFileSync;
  const resolved = path.resolve(target);
  let seen = false;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof file !== 'number' && path.resolve(String(file)) === resolved) seen = true;
    return realReadFileSync(file, options);
  }) as typeof fs.readFileSync;
  return { saw: () => seen, restore: () => { fs.readFileSync = realReadFileSync; } };
}

test('non-notebook executeCell stays unsupported and portable-exe writes no exe', async () => {
  const source = fs.readFileSync(new URL('../kindRuntime.ts', import.meta.url), 'utf8');
  const dry = sliceBetween(source, 'function dryRun', 'async function previewChrome');
  const reportGuard = dry.indexOf('assertExclusiveDestination(reportPath)');
  const specGuard = dry.indexOf('assertExclusiveDestination(specPath)');
  const reportRead = dry.indexOf('fs.readFileSync(reportPath');
  const specRead = dry.indexOf('fs.readFileSync(specPath');
  assert.ok(reportGuard >= 0 && reportRead > reportGuard);
  assert.ok(specGuard >= 0 && specRead > specGuard);
  assert.equal(dry.includes('catch'), false);
  const packed = sliceBetween(source, 'function assertPackedExtension', 'function assertSafariSource');
  const manifestGuard = packed.indexOf('assertExclusiveDestination(file)');
  const manifestTry = packed.indexOf('try {');
  const manifestRead = packed.indexOf('fs.readFileSync(file');
  assert.ok(manifestGuard >= 0 && manifestTry > manifestGuard && manifestRead > manifestGuard);
  const helper = sliceBetween(source, 'function assertExclusiveDestination', 'function nodeCode');
  assert.match(helper, /if \(nodeCode\(error\) === 'ENOENT'\) return;/);
  assert.match(helper, /throw error;/);
  assert.match(helper, /stat\.isSymbolicLink\(\) \|\| !stat\.isFile\(\) \|\| stat\.nlink > 1/);
  assert.equal((source.match(/stat\.nlink > 1/g) ?? []).length, 1);
  assert.equal((source.match(/assertExclusiveDestination\(/g) ?? []).length, 6);
  const htmlGuard = source.indexOf('assertExclusiveDestination(file)');
  const htmlWrite = source.indexOf('fs.writeFileSync(file, html)');
  const noteGuard = source.indexOf('assertExclusiveDestination(notePath)');
  const noteWrite = source.indexOf('fs.writeFileSync(notePath,');
  assert.equal(htmlGuard >= 0 && htmlWrite > htmlGuard, true);
  assert.equal(noteGuard >= 0 && noteWrite > noteGuard, true);
  const cell = sliceBetween(source, 'async executeCell', 'async stop');
  const guard = cell.indexOf("throw new BuildMenuError('unsupported_operation', 400)");
  const kernel = cell.indexOf('runKernelCell(');
  assert.match(cell, /profile\.kind !== 'notebook'/);
  assert.equal(guard >= 0 && kernel > guard, true);
  assert.equal(cell.includes('spawn('), false);
  const portable = sliceBetween(source, "case 'portable-exe':", "case 'xcode-source':");
  assert.match(portable, /return requestPortableExeBytes\(ctx\.workspace\)/);
  assert.equal(portable.includes('spawn'), false);
  assert.equal(portable.includes('writeFile'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);

  const { workspace, outside } = pair('loam-48-kind-read-cell-');
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(desktopProfile, { leases, electronExecutable: null });
  const ctx = context(workspace, { action: 'kernel-execute', cellId: 'cell-1' }, 'desktop');
  try {
    await assert.rejects(ports.executeCell(ctx, 'cell-1'), (error: unknown) => (
      error instanceof BuildMenuError && error.message === 'unsupported_operation' && error.status === 400
    ));
    const packaged = context(workspace, { action: 'package', format: 'portable-exe' }, 'desktop');
    await assert.rejects(ports.export(packaged, 'portable-exe'), (error: unknown) => (
      error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400
    ));
    assert.equal(started(), 0);
    assert.deepEqual(fs.readdirSync(workspace), []);
    assert.deepEqual(exeFiles(workspace), []);
  } finally {
    removePair(workspace, outside);
  }
});

test('report.txt with nlink greater than 1 is refused before read', async () => {
  const { workspace, outside } = pair('loam-48-kind-report-');
  const previous = Buffer.from('outside-report-bytes');
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(automationProfile, { leases, electronExecutable: null });
  try {
    materialize({ selection: { kind: 'automation' }, workspace, title: 'روتين' });
    const file = path.join(workspace, 'app', 'report.txt');
    const outsideFile = path.join(outside, 'report.txt');
    linkOutside(file, outsideFile, previous);
    const watch = watchRead(file);
    let lease: unknown;
    try {
      await assert.rejects(ports.preview(context(workspace, { action: 'preview' }, 'automation')).then((value) => {
        lease = value;
        return value;
      }), refused);
    } finally {
      watch.restore();
    }
    assert.equal(lease, undefined);
    assert.equal(watch.saw(), false);
    assert.equal(started(), 0);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(exeFiles(workspace), []);
  } finally {
    removePair(workspace, outside);
  }
});

test('automation.json with nlink greater than 1 is refused before read', async () => {
  const { workspace, outside } = pair('loam-48-kind-spec-');
  const previous = Buffer.from('{"send":true,"outside":"automation-bytes"}');
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(automationProfile, { leases, electronExecutable: null });
  try {
    materialize({ selection: { kind: 'automation' }, workspace, title: 'روتين' });
    const file = path.join(workspace, 'app', 'automation.json');
    const outsideFile = path.join(outside, 'automation.json');
    linkOutside(file, outsideFile, previous);
    const watch = watchRead(file);
    let lease: unknown;
    try {
      await assert.rejects(ports.preview(context(workspace, { action: 'preview' }, 'automation')).then((value) => {
        lease = value;
        return value;
      }), refused);
    } finally {
      watch.restore();
    }
    assert.equal(lease, undefined);
    assert.equal(watch.saw(), false);
    assert.equal(started(), 0);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(exeFiles(workspace), []);
  } finally {
    removePair(workspace, outside);
  }
});

test('manifest.json with nlink greater than 1 is refused before read', async () => {
  const { workspace, outside } = pair('loam-48-kind-manifest-');
  const previous = Buffer.from('outside-manifest-bytes');
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(chromeProfile, { leases, electronExecutable: null, chromeExecutable: null });
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace, title: 'إضافة' });
    const file = path.join(workspace, 'app', 'manifest.json');
    const outsideFile = path.join(outside, 'manifest.json');
    const before = artifactNames(workspace);
    linkOutside(file, outsideFile, previous);
    const watch = watchRead(file);
    let artifact: unknown;
    try {
      await assert.rejects(ports.export(context(workspace, { action: 'package', format: 'source-zip' }, 'chrome-extension'), 'source-zip').then((value) => {
        artifact = value;
        return value;
      }), refused);
    } finally {
      watch.restore();
    }
    assert.equal(artifact, undefined);
    assert.equal(watch.saw(), false);
    assert.equal(started(), 0);
    assert.deepEqual(artifactNames(workspace), before);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(exeFiles(workspace), []);
  } finally {
    removePair(workspace, outside);
  }
});

test('a regular report and automation spec still read', async () => {
  const { workspace, outside } = pair('loam-48-kind-read-ok-');
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(automationProfile, { leases, electronExecutable: null });
  try {
    materialize({ selection: { kind: 'automation' }, workspace, title: 'روتين' });
    const reportPath = path.join(workspace, 'app', 'report.txt');
    const specPath = path.join(workspace, 'app', 'automation.json');
    assert.equal(fs.lstatSync(reportPath).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(reportPath).isFile(), true);
    assert.equal(fs.lstatSync(reportPath).nlink, 1);
    assert.equal(fs.lstatSync(specPath).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(specPath).isFile(), true);
    assert.equal(fs.lstatSync(specPath).nlink, 1);
    const lease = await ports.preview(context(workspace, { action: 'preview' }, 'automation'));
    assert.deepEqual(lease, { kind: 'none' });
    assert.match(fs.readFileSync(reportPath, 'utf8'), /dry-run/);
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { send?: boolean; previewCount?: number };
    assert.equal(spec.send, false);
    assert.equal(spec.previewCount, 1);
    assert.equal(fs.lstatSync(reportPath).nlink, 1);
    assert.equal(fs.lstatSync(specPath).nlink, 1);
    assert.equal(started(), 0);
    assert.deepEqual(exeFiles(workspace), []);
  } finally {
    removePair(workspace, outside);
  }
});

test('a regular manifest still reads', async () => {
  const { workspace, outside } = pair('loam-48-kind-manifest-ok-');
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(chromeProfile, { leases, electronExecutable: null, chromeExecutable: null });
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace, title: 'إضافة' });
    const file = path.join(workspace, 'app', 'manifest.json');
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const original = fs.readFileSync(file);
    const resolved = path.resolve(file);
    const realReadFileSync = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (typeof target !== 'number' && path.resolve(String(target)) === resolved) reads += 1;
      return realReadFileSync(target, options);
    }) as typeof fs.readFileSync;
    let artifact: Artifact | undefined;
    try {
      artifact = await ports.export(context(workspace, { action: 'package', format: 'source-zip' }, 'chrome-extension'), 'source-zip');
    } finally {
      fs.readFileSync = realReadFileSync;
    }
    assert.ok(artifact);
    assert.equal(artifact.format, 'source-zip');
    assert.match(artifact.artifactId, /^art_/);
    assert.ok(reads >= 1);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.equal(started(), 0);
    assert.deepEqual(exeFiles(workspace), []);
  } finally {
    removePair(workspace, outside);
  }
});

test('lstat EPERM is not swallowed before the report, spec, or manifest read', async () => {
  const realLstatSync = fs.lstatSync;
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-kind-report-eperm-'));
  const reportLease = blockedLeases();
  const reportPorts = createKindPorts(automationProfile, { leases: reportLease.leases, electronExecutable: null });
  const reportFile = path.join(reportRoot, 'app', 'report.txt');
  const reportBytes = Buffer.from('dry-run: kept\n');
  try {
    materialize({ selection: { kind: 'automation' }, workspace: reportRoot, title: 'روتين' });
    fs.writeFileSync(reportFile, reportBytes);
    const resolved = path.resolve(reportFile);
    fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === resolved) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    const watch = watchRead(reportFile);
    let lease: unknown;
    try {
      await assert.rejects(reportPorts.preview(context(reportRoot, { action: 'preview' }, 'automation')).then((value) => {
        lease = value;
        return value;
      }), isEperm);
    } finally {
      watch.restore();
    }
    assert.equal(lease, undefined);
    assert.equal(watch.saw(), false);
    assert.equal(reportLease.started(), 0);
    assert.equal(realLstatSync(reportFile).nlink, 1);
    assert.equal(realLstatSync(reportFile).isSymbolicLink(), false);
    assert.equal(realLstatSync(reportFile).isFile(), true);
    assert.deepEqual(fs.readFileSync(reportFile), reportBytes);
    assert.deepEqual(exeFiles(reportRoot), []);
  } finally {
    fs.lstatSync = realLstatSync;
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }

  const specRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-kind-spec-eperm-'));
  const specLease = blockedLeases();
  const specPorts = createKindPorts(automationProfile, { leases: specLease.leases, electronExecutable: null });
  const specFile = path.join(specRoot, 'app', 'automation.json');
  try {
    materialize({ selection: { kind: 'automation' }, workspace: specRoot, title: 'روتين' });
    const specBytes = fs.readFileSync(specFile);
    const resolved = path.resolve(specFile);
    fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === resolved) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    const watch = watchRead(specFile);
    let lease: unknown;
    try {
      await assert.rejects(specPorts.preview(context(specRoot, { action: 'preview' }, 'automation')).then((value) => {
        lease = value;
        return value;
      }), isEperm);
    } finally {
      watch.restore();
    }
    assert.equal(lease, undefined);
    assert.equal(watch.saw(), false);
    assert.equal(specLease.started(), 0);
    assert.equal(realLstatSync(specFile).nlink, 1);
    assert.deepEqual(fs.readFileSync(specFile), specBytes);
    assert.deepEqual(exeFiles(specRoot), []);
  } finally {
    fs.lstatSync = realLstatSync;
    fs.rmSync(specRoot, { recursive: true, force: true });
  }

  const manifestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-kind-manifest-eperm-'));
  const manifestLease = blockedLeases();
  const manifestPorts = createKindPorts(chromeProfile, { leases: manifestLease.leases, electronExecutable: null, chromeExecutable: null });
  const manifestFile = path.join(manifestRoot, 'app', 'manifest.json');
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace: manifestRoot, title: 'إضافة' });
    const manifestBytes = fs.readFileSync(manifestFile);
    const before = artifactNames(manifestRoot);
    const resolved = path.resolve(manifestFile);
    fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === resolved) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    const watch = watchRead(manifestFile);
    let artifact: unknown;
    try {
      await assert.rejects(manifestPorts.export(context(manifestRoot, { action: 'package', format: 'mv3-zip' }, 'chrome-extension'), 'mv3-zip').then((value) => {
        artifact = value;
        return value;
      }), isEperm);
    } finally {
      watch.restore();
    }
    assert.equal(artifact, undefined);
    assert.equal(watch.saw(), false);
    assert.equal(manifestLease.started(), 0);
    assert.deepEqual(artifactNames(manifestRoot), before);
    assert.equal(realLstatSync(manifestFile).nlink, 1);
    assert.equal(realLstatSync(manifestFile).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(manifestFile), manifestBytes);
    assert.deepEqual(exeFiles(manifestRoot), []);
  } finally {
    fs.lstatSync = realLstatSync;
    fs.rmSync(manifestRoot, { recursive: true, force: true });
  }
});
