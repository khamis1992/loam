/**
 * registerDryRun refuses to write automation.json when that destination exists
 * and nlink is greater than 1, and leaves the outside bytes unchanged. A normal
 * local spec still registers disabled when the destination is a regular nlink 1
 * file, or when lstat reports that it does not exist yet. Cron stays
 * 0 9 * * 1 and timezone stays Asia/Qatar. This file does not call
 * connector.send or start the scheduler. Hard links are real files. It does
 * not create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/registerHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerDryRun } from '../automations/register.js';
import { BuildMenuError } from '../grants.js';

function localSpec(): Record<string, unknown> {
  return {
    cron: '0 9 * * 1',
    timezone: 'Asia/Qatar',
    dryRun: true,
    send: false,
    enabled: false,
    prompt: 'تقرير محلي أسبوعي',
  };
}

function specBytes(): Buffer {
  return Buffer.from(`${JSON.stringify(localSpec())}\n`);
}

function withWorkspace(run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-register-'));
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

function specPath(workspace: string): string {
  const file = path.join(workspace, 'app', 'automation.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function registerLocal(workspace: string): { scheduleId: string; enabled: false } {
  let calls = 0;
  const created = registerDryRun(workspace, (row) => {
    calls += 1;
    assert.equal(row.enabled, false);
    assert.equal(row.cron, '0 9 * * 1');
    assert.equal(row.timezone, 'Asia/Qatar');
    assert.equal(row.prompt, 'dry-run local report only. Do not send, publish, purchase, or delete.');
    return { id: 'sched_local', enabled: row.enabled };
  });
  assert.equal(calls, 1);
  assert.deepEqual(created, { scheduleId: 'sched_local', enabled: false });
  return created;
}

function storedSpec(file: string): { cron?: string; timezone?: string; scheduleId?: string; enabled?: boolean } {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { cron?: string; timezone?: string; scheduleId?: string; enabled?: boolean };
}

test('registerDryRun does not call connector.send or start the scheduler', () => {
  const source = fs.readFileSync(new URL('../automations/register.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export function registerDryRun');
  assert.ok(start >= 0);
  const body = source.slice(start);
  assert.equal(body.includes('connector.send'), false);
  assert.equal(body.includes('.send('), false);
  assert.equal(source.includes('startScheduler'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.match(source, /stat\.nlink > 1/);
  assert.match(source, /nodeCode\(error\) === 'ENOENT'/);
  assert.match(source, /spec\.cron !== '0 9 \* \* 1'/);
  assert.match(source, /spec\.timezone !== 'Asia\/Qatar'/);
  assert.match(body, /enabled: false/);
});

test('a regular nlink 1 file and a destination that does not exist yet still register disabled', () => {
  withWorkspace((workspace) => {
    const file = specPath(workspace);
    fs.writeFileSync(file, specBytes());
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    registerLocal(workspace);
    const stored = storedSpec(file);
    assert.equal(stored.cron, '0 9 * * 1');
    assert.equal(stored.timezone, 'Asia/Qatar');
    assert.equal(stored.scheduleId, 'sched_local');
    assert.equal(stored.enabled, false);
    const written = fs.lstatSync(file);
    assert.equal(written.isSymbolicLink(), false);
    assert.equal(written.isFile(), true);
    assert.equal(written.nlink, 1);
    let again = 0;
    const second = registerDryRun(workspace, () => {
      again += 1;
      return { id: 'sched_other', enabled: false };
    });
    assert.equal(again, 0);
    assert.deepEqual(second, { scheduleId: 'sched_local', enabled: false });
  });

  withWorkspace((workspace) => {
    const file = specPath(workspace);
    fs.writeFileSync(file, specBytes());
    const realLstatSync = fs.lstatSync;
    const resolved = path.resolve(file);
    fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === resolved) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync;
    try {
      registerLocal(workspace);
    } finally {
      fs.lstatSync = realLstatSync;
    }
    const stored = storedSpec(file);
    assert.equal(stored.cron, '0 9 * * 1');
    assert.equal(stored.timezone, 'Asia/Qatar');
    assert.equal(stored.scheduleId, 'sched_local');
    assert.equal(stored.enabled, false);
    const written = fs.lstatSync(file);
    assert.equal(written.isSymbolicLink(), false);
    assert.equal(written.isFile(), true);
    assert.equal(written.nlink, 1);
  });
});

test('an existing destination with nlink greater than 1 is refused before write', () => {
  withWorkspace((workspace, outside) => {
    const file = specPath(workspace);
    const outsideFile = path.join(outside, 'automation.json');
    const previous = specBytes();
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    let calls = 0;
    assert.throws(
      () => registerDryRun(workspace, () => {
        calls += 1;
        return { id: 'sched_linked', enabled: false };
      }),
      refused,
    );
    assert.equal(calls, 0);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
  });
});

test('lstat EPERM is not swallowed and the spec bytes stay', () => {
  withWorkspace((workspace) => {
    const file = specPath(workspace);
    const previous = specBytes();
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
      let calls = 0;
      assert.throws(
        () => registerDryRun(workspace, () => {
          calls += 1;
          return { id: 'sched_eperm', enabled: false };
        }),
        isEperm,
      );
      assert.equal(calls, 0);
    } finally {
      fs.lstatSync = realLstatSync;
    }
    assert.equal(realLstatSync(file).nlink, 1);
    assert.equal(realLstatSync(file).isSymbolicLink(), false);
    assert.equal(realLstatSync(file).isFile(), true);
    assert.deepEqual(fs.readFileSync(file), previous);
  });
});
