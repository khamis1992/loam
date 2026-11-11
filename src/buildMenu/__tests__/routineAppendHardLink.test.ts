/**
 * Project appends and the automation.json read throw unsafe_path when the
 * destination exists and nlink is greater than 1, and leave the outside bytes
 * unchanged. A regular nlink 1 file still appends and still reads. The
 * local-report exclusive check stays in front of its write. external-send,
 * publish, purchase, and delete stay approval_required. This file does not
 * call connector.send or start the scheduler. Hard links are real files. It
 * does not create a symlink or junction, and it does not swallow EPERM.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/routineAppendHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordPreview, runRoutine, writeProjectText, type MailConnector } from '../automations/run.js';
import { BuildMenuError } from '../grants.js';

const DUE_AT = '2026-11-09T06:00:00.000Z';
const LOCAL_PROMPT = 'حضّر ملخصاً محلياً';
const APPEND_NAMES = ['runs.jsonl', 'catchup.json'] as const;

const EFFECTS = [
  ['أرسل إلى user@example.com النص secret-body', 'external-send'],
  ['publish the site', 'publish'],
  ['purchase the item', 'purchase'],
  ['delete the files', 'delete'],
] as const;

function withWorkspace(run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-48-append-'));
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

function projectFile(workspace: string, name: string): string {
  return path.join(workspace, 'app', name);
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

function linkOutside(workspace: string, outside: string, name: string, bytes: Buffer): { file: string; outsideFile: string } {
  const file = projectFile(workspace, name);
  const outsideFile = path.join(outside, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, file);
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
  return { file, outsideFile };
}

function unchanged(file: string, outsideFile: string, bytes: Buffer): void {
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(outsideFile), bytes);
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
}

test('append and the automation read refuse nlink before the file operation', () => {
  const source = fs.readFileSync(new URL('../automations/run.ts', import.meta.url), 'utf8');
  const exclusiveStart = source.indexOf('function assertExclusiveReport');
  const writer = source.indexOf('export function writeProjectText');
  const routine = source.indexOf('export function runRoutine');
  const reader = source.indexOf('function readSpec');
  const writerAfter = source.indexOf('function writeSpec');
  assert.ok(exclusiveStart >= 0 && exclusiveStart < writer && writer < routine && routine < reader && reader < writerAfter);
  const exclusive = source.slice(exclusiveStart, writer);
  const writeBody = source.slice(writer, routine);
  const readBody = source.slice(reader, writerAfter);
  const guard = "if (name === 'local-report.txt' || append) assertExclusiveReport(file);";
  assert.match(exclusive, /if \(nodeCode\(error\) === 'ENOENT'\) return;/);
  assert.match(exclusive, /throw error;/);
  assert.match(exclusive, /stat\.nlink > 1/);
  assert.equal(exclusive.includes('EPERM'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('connector.send'), false);
  assert.equal(source.includes('.send('), false);
  assert.equal(source.includes('startScheduler'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.ok(writeBody.includes(guard));
  assert.ok(writeBody.indexOf(guard) < writeBody.indexOf('fs.appendFileSync(file, text)'));
  assert.ok(writeBody.indexOf(guard) < writeBody.indexOf('fs.writeFileSync(file, text)'));
  assert.ok(readBody.indexOf('assertExclusiveReport(file)') >= 0);
  assert.ok(readBody.indexOf('assertExclusiveReport(file)') < readBody.indexOf('fs.readFileSync'));
  assert.equal(readBody.includes('catch'), false);
  assert.match(source, /case 'external-send'/);
  assert.match(source, /case 'publish'/);
  assert.match(source, /case 'purchase'/);
  assert.match(source, /case 'delete'/);
});

test('a regular nlink 1 file still appends and still reads, and other effects stay approval_required', () => {
  withWorkspace((workspace) => {
    const created = projectFile(workspace, 'runs.jsonl');
    writeProjectText(workspace, 'runs.jsonl', 'created\n', true);
    const createdStat = fs.lstatSync(created);
    assert.equal(createdStat.isSymbolicLink(), false);
    assert.equal(createdStat.isFile(), true);
    assert.equal(createdStat.nlink, 1);
    assert.equal(fs.readFileSync(created, 'utf8'), 'created\n');

    for (const name of APPEND_NAMES) {
      const file = projectFile(workspace, name);
      fs.writeFileSync(file, 'kept\n');
      assert.equal(fs.lstatSync(file).nlink, 1);
      writeProjectText(workspace, name, 'added\n', true);
      assert.equal(fs.readFileSync(file, 'utf8'), 'kept\nadded\n');
      const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink, 1);
    }

    const runs = projectFile(workspace, 'runs.jsonl');
    const beforeRoutine = fs.readFileSync(runs, 'utf8');
    const mail = connector();
    const local = runRoutine({
      workspace,
      runId: 'run_append_nlink1',
      dueAt: DUE_AT,
      prompt: LOCAL_PROMPT,
      connector: mail,
    });
    assert.equal(local.outcome, 'local-report');
    assert.equal(mail.calls, 0);
    const appended = fs.readFileSync(runs, 'utf8');
    assert.ok(appended.startsWith(beforeRoutine));
    assert.match(appended, /local-report/);
    assert.equal(fs.lstatSync(runs).nlink, 1);

    const specPath = projectFile(workspace, 'automation.json');
    fs.writeFileSync(specPath, `${JSON.stringify({ previewCount: 2, enabled: false, send: false, dryRun: true })}\n`);
    assert.equal(fs.lstatSync(specPath).nlink, 1);
    assert.equal(recordPreview(workspace), 3);
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { previewCount?: number };
    assert.equal(spec.previewCount, 3);
    const readStat = fs.lstatSync(specPath);
    assert.equal(readStat.isSymbolicLink(), false);
    assert.equal(readStat.isFile(), true);
    assert.equal(readStat.nlink, 1);

    for (const [index, [prompt, effect]] of EFFECTS.entries()) {
      const result = runRoutine({
        workspace,
        runId: `run_effect_${index}`,
        dueAt: DUE_AT,
        prompt,
        connector: mail,
      });
      assert.equal(result.outcome, 'approval_required');
      const proposal = JSON.parse(fs.readFileSync(projectFile(workspace, 'proposed.json'), 'utf8')) as {
        effect?: string;
        status?: string;
        recipient?: string;
      };
      assert.equal(proposal.status, 'approval_required');
      if (effect === 'external-send') assert.equal(proposal.recipient, 'user@example.com');
      else assert.equal(proposal.effect, effect);
    }
    assert.equal(mail.calls, 0);
  });
});

test('an existing append target with nlink greater than 1 is refused before append', () => {
  withWorkspace((workspace, outside) => {
    const mail = connector();
    for (const name of APPEND_NAMES) {
      const previous = Buffer.from(`outside-${name}-bytes`);
      const { file, outsideFile } = linkOutside(workspace, outside, name, previous);
      assert.throws(() => writeProjectText(workspace, name, 'appended-line\n', true), refused);
      unchanged(file, outsideFile, previous);
    }
    const runs = projectFile(workspace, 'runs.jsonl');
    const outsideRuns = path.join(outside, 'runs.jsonl');
    const runsBytes = fs.readFileSync(runs);
    assert.throws(() => runRoutine({
      workspace,
      runId: 'run_linked_runs',
      dueAt: DUE_AT,
      prompt: LOCAL_PROMPT,
      connector: mail,
    }), refused);
    assert.equal(mail.calls, 0);
    unchanged(runs, outsideRuns, runsBytes);
  });
});

test('an existing automation.json with nlink greater than 1 is refused before read', () => {
  withWorkspace((workspace, outside) => {
    const previous = Buffer.from('outside-automation-bytes');
    const { file, outsideFile } = linkOutside(workspace, outside, 'automation.json', previous);
    assert.throws(() => recordPreview(workspace), refused);
    unchanged(file, outsideFile, previous);
    assert.equal(fs.readFileSync(file, 'utf8').includes('previewCount'), false);
  });
});

test('a hard-linked local report is still refused and the other effects stay approval_required', () => {
  withWorkspace((workspace, outside) => {
    const previous = Buffer.from('outside-report-bytes');
    const { file, outsideFile } = linkOutside(workspace, outside, 'local-report.txt', previous);
    const mail = connector();
    assert.throws(() => runRoutine({
      workspace,
      runId: 'run_report_still_exclusive',
      dueAt: DUE_AT,
      prompt: LOCAL_PROMPT,
      connector: mail,
    }), refused);
    unchanged(file, outsideFile, previous);
    assert.equal(fs.existsSync(projectFile(workspace, 'runs.jsonl')), false);
    for (const [index, [prompt, effect]] of EFFECTS.entries()) {
      const result = runRoutine({
        workspace,
        runId: `run_report_effect_${index}`,
        dueAt: DUE_AT,
        prompt,
        connector: mail,
      });
      assert.equal(result.outcome, 'approval_required');
      const proposal = JSON.parse(fs.readFileSync(projectFile(workspace, 'proposed.json'), 'utf8')) as {
        effect?: string;
        status?: string;
      };
      assert.equal(proposal.status, 'approval_required');
      if (effect !== 'external-send') assert.equal(proposal.effect, effect);
      unchanged(file, outsideFile, previous);
    }
    assert.equal(mail.calls, 0);
  });
});

test('lstat EPERM is not swallowed and the file bytes stay', () => {
  withWorkspace((workspace) => {
    const appendFile = projectFile(workspace, 'runs.jsonl');
    const readFile = projectFile(workspace, 'automation.json');
    const appendBytes = Buffer.from('kept-append-bytes');
    const readBytes = Buffer.from('{"previewCount":1}\n');
    fs.mkdirSync(path.dirname(appendFile), { recursive: true });
    fs.writeFileSync(appendFile, appendBytes);
    fs.writeFileSync(readFile, readBytes);
    assert.equal(fs.lstatSync(appendFile).nlink, 1);
    assert.equal(fs.lstatSync(readFile).nlink, 1);
    const realLstatSync = fs.lstatSync;
    const deny = new Set([path.resolve(appendFile), path.resolve(readFile)]);
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (deny.has(path.resolve(String(target)))) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    try {
      assert.throws(() => writeProjectText(workspace, 'runs.jsonl', 'nope\n', true), isEperm);
      assert.throws(() => recordPreview(workspace), isEperm);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assert.equal(realLstatSync(appendFile).nlink, 1);
    assert.equal(realLstatSync(appendFile).isSymbolicLink(), false);
    assert.equal(realLstatSync(appendFile).isFile(), true);
    assert.equal(realLstatSync(readFile).nlink, 1);
    assert.equal(realLstatSync(readFile).isSymbolicLink(), false);
    assert.equal(realLstatSync(readFile).isFile(), true);
    assert.deepEqual(fs.readFileSync(appendFile), appendBytes);
    assert.deepEqual(fs.readFileSync(readFile), readBytes);
  });
});
