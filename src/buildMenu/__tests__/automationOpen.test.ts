import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { saveManifest } from '../manifest.js';
import { recordPreview } from '../automations/run.js';
import { activateOpenedRoutine, configureOpenRoutines, disableOpenedRoutine, openRememberedRoutines, rememberOpenRoutine } from '../automations/open.js';

const DUE = new Date('2026-11-09T06:00:00.000Z');

test('a closed process writes nothing, and opening runs one local catch-up', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-'));
  const registry = path.join(root, 'registry');
  const enabled = routine(root, 'enabled', true, 'dry-run local report only. Do not send, publish, purchase, or delete.');
  const disabled = routine(root, 'disabled', false, 'dry-run local report only. Do not send, publish, purchase, or delete.');
  const outside = routine(root, 'outside', true, 'dry-run local report only. Do not send, publish, purchase, or delete.');
  writeManifest(enabled, 'app_bcdfghjkmnpq');
  writeManifest(disabled, 'app_bcdfghjkmnpr');
  assert.equal(fs.existsSync(path.join(enabled, 'app', 'local-report.txt')), false);
  assert.equal(fs.existsSync(registry), false);
  assert.deepEqual(openRememberedRoutines({ registryDir: registry, now: DUE, connector: mail() }), []);
  assert.equal(fs.existsSync(path.join(enabled, 'app', 'local-report.txt')), false);

  let sent = 0;
  const connector = mail(() => { sent += 1; });
  rememberOpenRoutine(registry, 'app_bcdfghjkmnpq', enabled);
  rememberOpenRoutine(registry, 'app_bcdfghjkmnpr', disabled);
  const first = openRememberedRoutines({ registryDir: registry, now: DUE, connector });
  assert.equal(first.filter((item) => item.ran).length, 1);
  assert.equal(first.find((item) => item.ran)?.dueAt, '2026-11-09T06:00:00.000Z');
  assert.match(fs.readFileSync(path.join(enabled, 'app', 'local-report.txt'), 'utf8'), /تقرير محلي/);
  assert.equal(fs.existsSync(path.join(disabled, 'app', 'local-report.txt')), false);
  assert.equal(fs.existsSync(path.join(outside, 'app', 'local-report.txt')), false);
  assert.equal(sent, 0);

  const second = openRememberedRoutines({ registryDir: registry, now: DUE, connector });
  assert.equal(second.filter((item) => item.ran).length, 0);
  assert.equal(fs.readFileSync(path.join(enabled, 'app', 'runs.jsonl'), 'utf8').trim().split(/\n/).length, 1);
  assert.equal(sent, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('opening a send routine does not call mail and skips the scheduler database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-send-'));
  const registry = path.join(root, 'registry');
  const workspace = routine(root, 'send', true, 'أرسل إلى user@example.com');
  writeManifest(workspace, 'app_bcdfghjkmnpq');
  rememberOpenRoutine(registry, 'app_bcdfghjkmnpq', workspace);
  let sent = 0;
  const opened = openRememberedRoutines({
    registryDir: registry,
    now: DUE,
    connector: mail(() => { sent += 1; }),
  });
  assert.equal(opened[0]?.ran, true);
  assert.equal(sent, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'app', 'proposed.json'), 'utf8')).recipient, 'user@example.com');
  const openSource = fs.readFileSync(new URL('../automations/open.ts', import.meta.url), 'utf8');
  const scheduler = fs.readFileSync(new URL('../../server/scheduler.ts', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../../server/http.ts', import.meta.url), 'utf8');
  assert.equal(openSource.includes('dueSchedules'), false);
  assert.equal(openSource.includes('db.js'), false);
  assert.equal(scheduler.includes('catchUpLocalReport'), false);
  assert.equal(scheduler.includes('openRememberedRoutines'), false);
  assert.match(server, /openRememberedRoutines\(/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('activation remembers the routine and disable removes it before the next open', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-activate-'));
  const registry = path.join(root, 'registry');
  const workspace = routine(root, 'project', false, 'dry-run local report only. Do not send, publish, purchase, or delete.');
  await saveManifest(workspace, {
    schemaVersion: 1,
    projectId: 'app_bcdfghjkmnpq',
    revision: 1,
    selection: { kind: 'automation' },
    title: 'تقرير',
    sourceDir: 'app',
    template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
    consent: { autostart: false, publish: false },
  }, 0);
  configureOpenRoutines(registry);
  try {
    assert.throws(() => activateOpenedRoutine(workspace), /approval_required/);
    assert.equal(fs.existsSync(registry), false);
    recordPreview(workspace);
    recordPreview(workspace);
    recordPreview(workspace);
    activateOpenedRoutine(workspace);
    const pointer = path.join(registry, 'app_bcdfghjkmnpq.json');
    assert.equal(fs.existsSync(pointer), true);
    assert.equal(fs.existsSync(path.join(workspace, 'app', 'local-report.txt')), false);
    const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: mail() });
    assert.equal(opened.filter((item) => item.ran).length, 1);
    disableOpenedRoutine(workspace);
    assert.equal(fs.existsSync(pointer), false);
    const after = openRememberedRoutines({ registryDir: registry, now: new Date('2026-11-16T06:00:00.000Z'), connector: mail() });
    assert.deepEqual(after, []);
    assert.equal(fs.readFileSync(path.join(workspace, 'app', 'runs.jsonl'), 'utf8').trim().split(/\n/).length, 1);
  } finally {
    configureOpenRoutines(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opening ignores a pointer aimed at another folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-foreign-'));
  const registry = path.join(root, 'registry');
  const owned = routine(root, 'owned', true, 'dry-run local report only. Do not send, publish, purchase, or delete.');
  const foreign = routine(root, 'foreign', true, 'أرسل إلى user@example.com');
  writeManifest(owned, 'app_bcdfghjkmnpq');
  writeManifest(foreign, 'app_bcdfghjkmnpr', 'website');
  fs.mkdirSync(registry, { recursive: true });
  const pointer = path.join(registry, 'app_bcdfghjkmnpq.json');
  fs.writeFileSync(pointer, `${JSON.stringify({ workspace: foreign })}\n`);
  let sent = 0;
  const skipped = openRememberedRoutines({ registryDir: registry, now: DUE, connector: mail(() => { sent += 1; }) });
  assert.equal(skipped[0]?.ran, false);
  assert.equal(sent, 0);
  assert.equal(fs.existsSync(path.join(foreign, 'app', 'local-report.txt')), false);
  assert.equal(fs.existsSync(path.join(foreign, 'app', 'proposed.json')), false);
  fs.writeFileSync(pointer, `${JSON.stringify({ workspace: owned })}\n`);
  const opened = openRememberedRoutines({ registryDir: registry, now: DUE, connector: mail(() => { sent += 1; }) });
  assert.equal(opened[0]?.ran, true);
  assert.equal(sent, 0);
  assert.match(fs.readFileSync(path.join(owned, 'app', 'local-report.txt'), 'utf8'), /تقرير محلي/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('remembering refuses a directory or symlink pointer and still writes a normal one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-open-pointer-'));
  const registry = path.join(root, 'registry');
  const workspace = routine(root, 'owned', false, 'dry-run local report only. Do not send, publish, purchase, or delete.');
  writeManifest(workspace, 'app_bcdfghjkmnpq');
  const pointer = path.join(registry, 'app_bcdfghjkmnpq.json');
  const marker = path.join(pointer, 'keep.txt');
  fs.mkdirSync(pointer, { recursive: true });
  fs.writeFileSync(marker, 'keep');
  try {
    assert.throws(
      () => rememberOpenRoutine(registry, 'app_bcdfghjkmnpq', workspace),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.lstatSync(pointer).isDirectory(), true);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
    fs.rmSync(pointer, { recursive: true, force: true });
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'keep');
    fs.symlinkSync(secret, pointer, 'file');
    assert.throws(
      () => rememberOpenRoutine(registry, 'app_bcdfghjkmnpq', workspace),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.lstatSync(pointer).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(secret, 'utf8'), 'keep');
    fs.rmSync(pointer);
    rememberOpenRoutine(registry, 'app_bcdfghjkmnpq', workspace);
    rememberOpenRoutine(registry, 'app_bcdfghjkmnpq', workspace);
    assert.equal(fs.lstatSync(pointer).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(pointer).isFile(), true);
    assert.equal(JSON.parse(fs.readFileSync(pointer, 'utf8')).workspace, path.resolve(workspace));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function mail(send?: () => void): { send(): void } {
  return { send() { send?.(); } };
}

function writeManifest(workspace: string, projectId: string, kind: 'automation' | 'website' = 'automation'): void {
  const dir = path.join(workspace, '.loam', 'build-menu');
  fs.mkdirSync(dir, { recursive: true });
  const selection = kind === 'website' ? { kind, subtype: 'landing' as const } : { kind: 'automation' as const };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    revision: 1,
    selection,
    title: 'تقرير',
    sourceDir: 'app',
    template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
    consent: { autostart: false, publish: false },
  })}\n`);
}

function routine(root: string, name: string, enabled: boolean, prompt: string): string {
  const workspace = path.join(root, name);
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app', 'automation.json'), `${JSON.stringify({
    cron: '0 9 * * 1',
    timezone: 'Asia/Qatar',
    dryRun: true,
    enabled,
    send: false,
    scheduleId: 'sched_local',
    prompt,
  })}\n`);
  return workspace;
}
