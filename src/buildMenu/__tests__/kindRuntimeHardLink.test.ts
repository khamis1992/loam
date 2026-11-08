/**
 * Simulation HTML and the mobile source note refuse an existing destination
 * whose nlink is greater than 1. Outside bytes stay. A missing file still
 * writes. Hard links come from fs.linkSync. This file does not spawn a process,
 * create a symlink, or create a junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/kindRuntimeHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BuildJobContext, BuildManifest, BuildProfile } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { createKindPorts } from '../kindRuntime.js';
import { materialize } from '../materialize.js';
import { mobileProfile } from '../mobile/profile.js';
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

function context(workspace: string, operation: BuildJobContext['operation'], kind: 'mobile' | 'desktop'): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind };
  return {
    workspace,
    jobId: kind === 'mobile' ? 'job_mobile_nlink' : 'job_desktop_nlink',
    operation,
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 3,
      selection,
      title: kind === 'mobile' ? 'جوال' : 'مكتب',
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

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test('non-notebook executeCell stays unsupported and portable-exe writes no exe', async () => {
  const source = fs.readFileSync(new URL('../kindRuntime.ts', import.meta.url), 'utf8');
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
  const htmlGuard = source.indexOf('assertExclusiveDestination(file)');
  const htmlWrite = source.indexOf('fs.writeFileSync(file, html)');
  const noteGuard = source.indexOf('assertExclusiveDestination(notePath)');
  const noteWrite = source.indexOf('fs.writeFileSync(notePath,');
  assert.equal(htmlGuard >= 0 && htmlWrite > htmlGuard, true);
  assert.equal(noteGuard >= 0 && noteWrite > noteGuard, true);
  assert.match(source, /stat\.nlink > 1/);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);

  const { workspace, outside } = pair('loam-46-kind-cell-');
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

test('an existing simulation file with nlink greater than 1 is refused before write', async () => {
  const { workspace, outside } = pair('loam-46-kind-html-');
  const file = path.join(workspace, 'app', 'simulation.html');
  const outsideFile = path.join(outside, 'simulation.html');
  const previous = Buffer.from('outside-simulation-bytes');
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(mobileProfile, { leases });
  try {
    materialize({ selection: { kind: 'mobile' }, workspace, title: 'جوال' });
    fs.rmSync(file);
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    await assert.rejects(ports.preview(context(workspace, { action: 'preview' }, 'mobile')), refused);
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

test('a new simulation file still writes', async () => {
  const { workspace, outside } = pair('loam-46-kind-html-new-');
  const file = path.join(workspace, 'app', 'simulation.html');
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(mobileProfile, { leases });
  try {
    materialize({ selection: { kind: 'mobile' }, workspace, title: 'جوال' });
    fs.rmSync(file);
    assert.equal(fs.existsSync(file), false);
    await assert.rejects(
      ports.preview(context(workspace, { action: 'preview' }, 'mobile')),
      (error: unknown) => error instanceof Error && error.message === 'spawn refused',
    );
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const html = fs.readFileSync(file, 'utf8');
    assert.equal(html.includes('جوال'), true);
    assert.equal(/https?:\/\//i.test(html), false);
    assert.equal(started(), 1);
    assert.deepEqual(exeFiles(workspace), []);
  } finally {
    removePair(workspace, outside);
  }
});

test('an existing source note with nlink greater than 1 is refused before write', async () => {
  const { workspace, outside } = pair('loam-46-kind-note-');
  const outsideFile = path.join(outside, 'source.json');
  const previous = Buffer.from('outside-source-note');
  fs.writeFileSync(outsideFile, previous);
  materialize({ selection: { kind: 'mobile' }, workspace, title: 'جوال' });
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(mobileProfile, { leases });
  const realRename = fs.renameSync;
  let planted = '';
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    realRename(from, to);
    const destination = path.resolve(String(to));
    if (!destination.includes(`${path.sep}artifacts${path.sep}`)) return;
    if (!destination.endsWith('.json') || destination.endsWith('.source.json')) return;
    const note = `${destination.slice(0, -'.json'.length)}.source.json`;
    if (fs.existsSync(note)) return;
    fs.linkSync(outsideFile, note);
    planted = note;
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(
      ports.export(context(workspace, { action: 'package', format: 'source-zip' }, 'mobile'), 'source-zip'),
      refused,
    );
    assert.equal(started(), 0);
    assert.equal(planted.endsWith('.source.json'), true);
    const stat = fs.lstatSync(planted);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    assert.deepEqual(fs.readFileSync(planted), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(exeFiles(workspace), []);
  } finally {
    fs.renameSync = realRename;
    removePair(workspace, outside);
  }
});

test('a new source note still writes', async () => {
  const { workspace, outside } = pair('loam-46-kind-note-new-');
  materialize({ selection: { kind: 'mobile' }, workspace, title: 'جوال' });
  const { leases, started } = blockedLeases();
  const ports = createKindPorts(mobileProfile, { leases });
  try {
    const artifact = await ports.export(context(workspace, { action: 'package', format: 'source-zip' }, 'mobile'), 'source-zip');
    const notePath = path.join(workspace, '.loam', 'build-menu', 'artifacts', `${artifact.artifactId}.source.json`);
    const stat = fs.lstatSync(notePath);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const note = JSON.parse(fs.readFileSync(notePath, 'utf8')) as { apkIncluded?: boolean; manifestRevision?: number; sourceSha256?: string };
    assert.equal(note.apkIncluded, false);
    assert.equal(note.manifestRevision, 3);
    assert.equal(note.sourceSha256?.length, 64);
    assert.equal(started(), 0);
    assert.deepEqual(exeFiles(workspace), []);
  } finally {
    removePair(workspace, outside);
  }
});

test('lstat EPERM is not swallowed before the simulation or source note write', async () => {
  const htmlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-kind-html-eperm-'));
  const htmlFile = path.join(htmlRoot, 'app', 'simulation.html');
  const previous = Buffer.from('existing-simulation-bytes');
  const htmlLease = blockedLeases();
  const htmlPorts = createKindPorts(mobileProfile, { leases: htmlLease.leases });
  const realLstatSync = fs.lstatSync;
  try {
    materialize({ selection: { kind: 'mobile' }, workspace: htmlRoot, title: 'جوال' });
    fs.writeFileSync(htmlFile, previous);
    const resolved = path.resolve(htmlFile);
    fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === resolved) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    await assert.rejects(htmlPorts.preview(context(htmlRoot, { action: 'preview' }, 'mobile')), isEperm);
    assert.equal(htmlLease.started(), 0);
    assert.equal(realLstatSync(htmlFile).nlink, 1);
    assert.equal(realLstatSync(htmlFile).isSymbolicLink(), false);
    assert.equal(realLstatSync(htmlFile).isFile(), true);
    assert.deepEqual(fs.readFileSync(htmlFile), previous);
  } finally {
    fs.lstatSync = realLstatSync;
    fs.rmSync(htmlRoot, { recursive: true, force: true });
  }

  const noteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-kind-note-eperm-'));
  const noteLease = blockedLeases();
  const notePorts = createKindPorts(mobileProfile, { leases: noteLease.leases });
  materialize({ selection: { kind: 'mobile' }, workspace: noteRoot, title: 'جوال' });
  fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (String(target).endsWith('.source.json')) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return realLstatSync(target, options);
  }) as typeof fs.lstatSync;
  try {
    await assert.rejects(
      notePorts.export(context(noteRoot, { action: 'package', format: 'source-zip' }, 'mobile'), 'source-zip'),
      isEperm,
    );
    assert.equal(noteLease.started(), 0);
    const artifacts = path.join(noteRoot, '.loam', 'build-menu', 'artifacts');
    const names = fs.existsSync(artifacts) ? fs.readdirSync(artifacts) : [];
    assert.equal(names.some((name) => name.endsWith('.source.json')), false);
    assert.deepEqual(exeFiles(noteRoot), []);
  } finally {
    fs.lstatSync = realLstatSync;
    fs.rmSync(noteRoot, { recursive: true, force: true });
  }
});
