/**
 * readStoredBrief refuses a brief whose nlink is greater than 1 before
 * readFileSync, throws unsafe_path, and does not return the outside text.
 * A regular nlink 1 brief still reads. Recording that brief keeps model false.
 * Hard links use fs.linkSync. This file does not create a symlink or junction,
 * and it does not call a model provider.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/planBriefReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { kindPlanContract } from '../planGate.js';
import { recordPlanProvenance, storedBrief, writeStoredBrief } from '../planProvenance.js';

const LOCAL_BRIEF = 'صفحة محلية بلا عنوان بعيد';
const OUTSIDE = 'outside secret bytes stay unread';

const provenanceSource = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'planProvenance.ts');
const routeSource = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'buildMenu.ts');

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isCode(error: unknown, code: 'EPERM' | 'EACCES'): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function samePath(target: fs.PathLike, file: string): boolean {
  const left = path.resolve(String(target));
  const right = path.resolve(file);
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
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

function briefPath(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'brief.txt');
}

function planPath(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'plan.json');
}

function readFunction(source: string): string {
  const start = source.indexOf('function readStoredBrief');
  const end = source.indexOf('function containedDir', start);
  assert.equal(start >= 0, true);
  assert.equal(end > start, true);
  return source.slice(start, end);
}

function plantLink(outside: string, destination: string, bytes: Buffer): string {
  const outsideFile = path.join(outside, 'brief.txt');
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, destination);
  return outsideFile;
}

function assertLinked(destination: string, outsideFile: string): void {
  const stat = fs.lstatSync(destination);
  const linked = fs.lstatSync(outsideFile);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(linked.isSymbolicLink(), false);
  assert.equal(linked.isFile(), true);
  assert.equal(linked.nlink > 1, true);
  assert.equal(stat.ino, linked.ino);
}

function blockBriefRead(brief: string, run: () => void): void {
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && samePath(target, brief)) throw new Error('brief_read');
    return realReadFileSync(target, options);
  }) as typeof fs.readFileSync;
  try {
    run();
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

function refuseLstat(brief: string, code: 'EPERM' | 'EACCES', run: () => void): void {
  const realLstatSync = fs.lstatSync;
  let calls = 0;
  fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (samePath(target, brief)) {
      calls += 1;
      const error = new Error(code === 'EPERM' ? 'operation not permitted' : 'permission denied') as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    }
    return realLstatSync(target, options);
  }) as typeof fs.lstatSync;
  try {
    assert.throws(run, (error: unknown) => isCode(error, code));
    assert.equal(calls > 0, true);
  } finally {
    fs.lstatSync = realLstatSync;
  }
}

test('readStoredBrief checks nlink before readFileSync and does not call a model provider', () => {
  const source = fs.readFileSync(provenanceSource, 'utf8');
  const body = readFunction(source);
  const checkAt = body.indexOf('stat.nlink > 1');
  const readAt = body.indexOf('readFileSync');
  assert.equal((body.match(/stat\.nlink > 1/g) ?? []).length, 1);
  assert.equal(checkAt >= 0, true);
  assert.equal(readAt > checkAt, true);
  assert.equal(body.includes('catch'), false);
  assert.equal(body.includes('EPERM'), false);
  assert.equal(body.includes('EACCES'), false);
  assert.equal(source.includes('catch'), false);
  assert.equal(source.includes('symlink'), false);
  assert.equal(source.includes('junction'), false);
  assert.match(source, /model:\s*false/);
  assert.equal(/openai|anthropic|generateText|chat\.completions|fetch\(/i.test(source), false);
  const route = fs.readFileSync(routeSource, 'utf8');
  const start = route.indexOf("if (p.endsWith('/plan'))");
  const end = route.indexOf('try {', start);
  assert.equal(start >= 0, true);
  assert.equal(end > start, true);
  const branch = route.slice(start, end);
  assert.match(branch, /generation needs a model provider/);
  assert.equal(branch.includes('nlink'), false);
  assert.equal(branch.includes('readFileSync'), false);
  assert.equal(branch.includes('storedBrief'), false);
});

test('a hard-linked brief throws unsafe_path before read and does not return the outside text', () => {
  withPair('loam-48-plan-read-', (workspace, outside) => {
    const brief = briefPath(workspace);
    const plan = planPath(workspace);
    writeStoredBrief(workspace, LOCAL_BRIEF);
    recordPlanProvenance(workspace, 'website');
    const planBytes = fs.readFileSync(plan);
    const saved = JSON.parse(planBytes.toString('utf8')) as { model: boolean };
    assert.equal(saved.model, false);
    fs.unlinkSync(brief);
    const outsideBytes = Buffer.from(OUTSIDE);
    const outsideFile = plantLink(outside, brief, outsideBytes);
    assertLinked(brief, outsideFile);
    let returned: string | undefined;
    blockBriefRead(brief, () => {
      assert.throws(() => {
        returned = storedBrief(workspace);
      }, isUnsafe);
      assert.throws(() => recordPlanProvenance(workspace, 'website'), isUnsafe);
    });
    assert.equal(returned, undefined);
    assert.deepEqual(fs.readFileSync(brief), outsideBytes);
    assert.deepEqual(fs.readFileSync(outsideFile), outsideBytes);
    assert.deepEqual(fs.readFileSync(plan), planBytes);
    const kept = JSON.parse(fs.readFileSync(plan, 'utf8')) as { model: boolean; userBriefSha256: string | null };
    assert.equal(kept.model, false);
    assert.equal(kept.userBriefSha256, createHash('sha256').update(LOCAL_BRIEF).digest('hex'));
    assert.equal(fs.readFileSync(plan, 'utf8').includes(OUTSIDE), false);
    assertLinked(brief, outsideFile);
  });
});

test('a regular nlink 1 brief still reads and the stored plan stays model false', () => {
  withPair('loam-48-plan-read-plain-', (workspace) => {
    const brief = briefPath(workspace);
    const plan = planPath(workspace);
    writeStoredBrief(workspace, LOCAL_BRIEF);
    const stat = fs.lstatSync(brief);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(storedBrief(workspace), LOCAL_BRIEF);
    recordPlanProvenance(workspace, 'website');
    const after = fs.lstatSync(brief);
    assert.equal(after.isSymbolicLink(), false);
    assert.equal(after.nlink, 1);
    const contract = kindPlanContract('website');
    const planText = fs.readFileSync(plan, 'utf8');
    const saved = JSON.parse(planText) as { source: string; model: boolean; brief: string; userBriefSha256: string | null };
    assert.equal(saved.source, 'loam');
    assert.equal(saved.model, false);
    assert.equal(saved.brief, contract.brief);
    assert.equal(saved.userBriefSha256, createHash('sha256').update(LOCAL_BRIEF).digest('hex'));
    assert.equal(planText.includes(LOCAL_BRIEF), false);
    assert.equal(planText.includes(OUTSIDE), false);
  });
});

test('lstat EPERM and EACCES are not swallowed before the brief read', () => {
  withPair('loam-48-plan-read-eperm-', (workspace) => {
    const brief = briefPath(workspace);
    const plan = planPath(workspace);
    writeStoredBrief(workspace, LOCAL_BRIEF);
    recordPlanProvenance(workspace, 'website');
    const briefBytes = fs.readFileSync(brief);
    const planBytes = fs.readFileSync(plan);
    assert.equal(fs.lstatSync(brief).nlink, 1);
    blockBriefRead(brief, () => {
      refuseLstat(brief, 'EPERM', () => storedBrief(workspace));
      refuseLstat(brief, 'EACCES', () => storedBrief(workspace));
      refuseLstat(brief, 'EPERM', () => recordPlanProvenance(workspace, 'website'));
      refuseLstat(brief, 'EACCES', () => recordPlanProvenance(workspace, 'website'));
    });
    assert.equal(fs.lstatSync(brief).nlink, 1);
    assert.deepEqual(fs.readFileSync(brief), briefBytes);
    assert.deepEqual(fs.readFileSync(plan), planBytes);
    const saved = JSON.parse(planBytes.toString('utf8')) as { model: boolean };
    assert.equal(saved.model, false);
  });
});
