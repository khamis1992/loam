import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, type ChildProcess, type spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeLaunchArgs, chromePreviewSummary, openIsolatedChrome, stopIsolatedChrome, writeUnpackedInstructions } from '../chrome/browser.js';
import { BuildMenuError } from '../grants.js';
import { findChrome } from '../toolchain.js';

test('isolated chrome args stay out of the signed-in profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-args-'));
  const extensionDir = path.join(root, 'app');
  fs.mkdirSync(extensionDir);
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(profileDir);
  const args = chromeLaunchArgs({ profileDir, extensionDir, userDataRoot: path.join(root, 'User Data') });
  assert.equal(args.some((arg) => arg.startsWith('--user-data-dir=')), true);
  assert.equal(args.includes('--disable-features=DisableLoadExtensionCommandLineSwitch'), true);
  assert.equal(args.some((arg) => /disable-web-security|remote-debugging/i.test(arg)), false);
  assert.throws(
    () => chromeLaunchArgs({ profileDir: path.join(root, 'User Data', 'Default'), extensionDir, userDataRoot: path.join(root, 'User Data') }),
    (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('manual chrome steps replace a raw preview address', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-note-'));
  fs.mkdirSync(path.join(root, 'app'));
  try {
    writeUnpackedInstructions(root, 'job_chrome_note', false);
    const note = chromePreviewSummary(root, 'http://127.0.0.1:9/');
    assert.match(note, /لم تُفتح نافذة Chrome/);
    assert.match(note, /Load unpacked/);
    assert.match(note, /وضع المطوّر/);
    assert.match(note, /لا تعطّل حماية المتصفح/);
    assert.equal(note.includes('هذه نافذة'), false);
    assert.equal(note.includes('http://'), false);
    assert.equal(/disable-web-security|remote-debugging/i.test(note), false);
    writeUnpackedInstructions(root, 'job_chrome_note', true);
    const opened = chromePreviewSummary(root, 'http://127.0.0.1:9/');
    assert.match(opened, /هذه نافذة ملف شخصي مؤقت/);
    assert.equal(opened.includes('لم تُفتح نافذة'), false);
    fs.writeFileSync(path.join(root, 'app', 'unpacked.txt'), 'open https://example.test\n');
    assert.equal(chromePreviewSummary(root, 'http://127.0.0.1:9/'), 'http://127.0.0.1:9/');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an aborted chrome launch does not keep a browser process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-cancel-'));
  fs.mkdirSync(path.join(root, 'app'));
  const early = new AbortController();
  early.abort();
  let spawned = 0;
  const spawnImpl = (() => {
    spawned += 1;
    throw new Error('spawned');
  }) as typeof spawn;
  try {
    await assert.rejects(() => openIsolatedChrome({
      executable: process.execPath,
      workspace: root,
      jobId: 'job_chrome_cancel',
      signal: early.signal,
      spawnImpl,
    }), (error: unknown) => error instanceof BuildMenuError && error.message === 'cancelled');
    assert.equal(spawned, 0);
    const controller = new AbortController();
    let kills = 0;
    const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null as number | null }) as ChildProcess;
    child.kill = () => {
      kills += 1;
      Object.defineProperty((child as { exitCode: number | null }), 'exitCode', { value: 0 });
      child.emit('exit', 0, null);
      return true;
    };
    const opened = await openIsolatedChrome({
      executable: process.execPath,
      workspace: root,
      jobId: 'job_chrome_cancel',
      signal: controller.signal,
      spawnImpl: (() => child) as typeof spawn,
    });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened.pid, 4242);
    assert.equal(kills, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a temporary chrome window closes with its own process', async () => {
  const executable = findChrome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-chrome-live-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'manifest.json'), '{}\n');
  if (!executable) {
    assert.equal(executable, null);
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  const child = await openIsolatedChrome({ executable, workspace: root, jobId: 'job_chrome' });
  try {
    const command = await waitForCommand(child.pid ?? 0);
    assert.match(command, /--user-data-dir=/);
    assert.match(command, /--load-extension=/);
    assert.match(command, /DisableLoadExtensionCommandLineSwitch/);
    assert.doesNotMatch(command, /disable-web-security|remote-debugging-port/);
    assert.equal(command.includes(path.join(root, '.loam', 'build-menu', 'chrome-profile', 'job_chrome')), true);
    assert.match(fs.readFileSync(path.join(root, 'app', 'unpacked.txt'), 'utf8'), /Load unpacked/);
    assert.equal(alive(child.pid ?? 0), true);
  } finally {
    await stopIsolatedChrome(child);
    let removed = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        removed = true;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!removed) throw lastError;
  }
  assert.equal(alive(child.pid ?? 0), false);
});

async function waitForCommand(pid: number): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const command = commandLine(pid);
    if (command.includes('--user-data-dir=')) return command;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return commandLine(pid);
}

function commandLine(pid: number): string {
  if (process.platform !== 'win32') return '';
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
