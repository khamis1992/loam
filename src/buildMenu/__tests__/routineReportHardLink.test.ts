/**
 * runRoutine refuses to write local-report.txt when that destination exists
 * and nlink is greater than 1, and leaves the outside bytes unchanged. A new
 * report still writes. external-send, publish, purchase, and delete stay
 * approval_required. This file does not call connector.send or start the
 * scheduler. Hard links are real files. It does not create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/routineReportHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuildMenuError } from '../grants.js';
import { runRoutine, type MailConnector } from '../automations/run.js';

const DUE_AT = '2026-11-09T06:00:00.000Z';
const LOCAL_PROMPT = 'حضّر ملخصاً محلياً';
const LOCAL_REPORT = `تقرير محلي\n${DUE_AT}\n`;

const EFFECTS = [
  ['أرسل إلى user@example.com النص secret-body', 'external-send'],
  ['publish the site', 'publish'],
  ['purchase the item', 'purchase'],
  ['delete the files', 'delete'],
] as const;

function withWorkspace(run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-report-'));
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

function reportPath(workspace: string): string {
  return path.join(workspace, 'app', 'local-report.txt');
}

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function connector(): MailConnector & { calls: number } {
  const sink = {
    calls: 0,
    send(): void {
      sink.calls += 1;
    },
  };
  return sink;
}

function runLocal(workspace: string, mail: MailConnector, runId = 'run_local'): { outcome: 'local-report' | 'approval_required' } {
  return runRoutine({
    workspace,
    runId,
    dueAt: DUE_AT,
    prompt: LOCAL_PROMPT,
    connector: mail,
  });
}

test('runRoutine does not call connector.send or start the scheduler', () => {
  const source = fs.readFileSync(new URL('../automations/run.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export function runRoutine');
  const writer = source.indexOf('export function writeProjectText');
  assert.ok(start >= 0);
  assert.ok(writer >= 0);
  const body = source.slice(start);
  const writeBody = source.slice(writer, start);
  assert.equal(source.includes('connector.send'), false);
  assert.equal(body.includes('.send('), false);
  assert.equal(source.includes('startScheduler'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.match(source, /stat\.nlink > 1/);
  assert.match(source, /nodeCode\(error\) === 'ENOENT'/);
  const call = writeBody.indexOf('assertExclusiveReport(file)');
  const write = writeBody.indexOf('fs.writeFileSync(file, text)');
  assert.ok(call >= 0 && write >= 0 && call < write);
  assert.match(source, /case 'external-send'/);
  assert.match(source, /case 'publish'/);
  assert.match(source, /case 'purchase'/);
  assert.match(source, /case 'delete'/);
});

test('a new report and a regular nlink 1 file still write, and other effects stay approval_required', () => {
  withWorkspace((workspace) => {
    const mail = connector();
    const created = runLocal(workspace, mail);
    const file = reportPath(workspace);
    assert.equal(created.outcome, 'local-report');
    assert.equal(mail.calls, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), LOCAL_REPORT);
    const written = fs.lstatSync(file);
    assert.equal(written.isSymbolicLink(), false);
    assert.equal(written.isFile(), true);
    assert.equal(written.nlink, 1);
    const again = runLocal(workspace, mail, 'run_local_again');
    assert.equal(again.outcome, 'local-report');
    assert.equal(mail.calls, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), LOCAL_REPORT);
    assert.equal(fs.lstatSync(file).nlink, 1);
  });

  withWorkspace((workspace) => {
    const mail = connector();
    for (const [index, [prompt, effect]] of EFFECTS.entries()) {
      const result = runRoutine({
        workspace,
        runId: `run_effect_${index}`,
        dueAt: DUE_AT,
        prompt,
        connector: mail,
      });
      assert.equal(result.outcome, 'approval_required');
      const proposal = JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'proposed.json'), 'utf8')) as {
        effect?: string;
        status?: string;
        recipient?: string;
      };
      assert.equal(proposal.status, 'approval_required');
      if (effect === 'external-send') assert.equal(proposal.recipient, 'user@example.com');
      else assert.equal(proposal.effect, effect);
    }
    assert.equal(mail.calls, 0);
    assert.equal(fs.existsSync(reportPath(workspace)), false);
  });
});

test('an existing report with nlink greater than 1 is refused before write', () => {
  withWorkspace((workspace, outside) => {
    const file = reportPath(workspace);
    const outsideFile = path.join(outside, 'local-report.txt');
    const previous = Buffer.from('outside-report-bytes');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    const mail = connector();
    assert.throws(() => runLocal(workspace, mail), refused);
    assert.equal(mail.calls, 0);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'runs.jsonl')), false);
    for (const [index, [prompt]] of EFFECTS.entries()) {
      const result = runRoutine({
        workspace,
        runId: `run_linked_effect_${index}`,
        dueAt: DUE_AT,
        prompt,
        connector: mail,
      });
      assert.equal(result.outcome, 'approval_required');
      assert.deepEqual(fs.readFileSync(file), previous);
      assert.deepEqual(fs.readFileSync(outsideFile), previous);
    }
    assert.equal(mail.calls, 0);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
  });
});

test('lstat EPERM is not swallowed and the report bytes stay', () => {
  withWorkspace((workspace) => {
    const file = reportPath(workspace);
    const previous = Buffer.from('kept-report-bytes');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, previous);
    assert.equal(fs.lstatSync(file).nlink, 1);
    const realLstatSync = fs.lstatSync;
    const resolved = path.resolve(file);
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (path.resolve(String(target)) === resolved) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    const mail = connector();
    try {
      assert.throws(() => runLocal(workspace, mail), isEperm);
      assert.equal(mail.calls, 0);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assert.equal(realLstatSync(file).nlink, 1);
    assert.equal(realLstatSync(file).isSymbolicLink(), false);
    assert.equal(realLstatSync(file).isFile(), true);
    assert.deepEqual(fs.readFileSync(file), previous);
  });
});
