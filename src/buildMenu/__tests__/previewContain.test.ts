import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'staticPreview.cjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function runPreview(cwd: string, args: string[]): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, shell: false, windowsHide: true });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    child.on('exit', (exitCode) => resolve({ exitCode, output }));
  });
}

test('the preview page stays inside the project and a parent path is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-preview-contain-'));
  const outside = path.join(root, 'secret.txt');
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'preview.html'), '<p>صفحة داخل المشروع</p>');
  fs.writeFileSync(outside, 'secret-outside');
  const port = await freePort();
  const child = spawn(process.execPath, [script, '--file', 'app/preview.html', '--port', String(port)], {
    cwd: root,
    shell: false,
    windowsHide: true,
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  try {
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(output.includes('READY')), 3_000);
      const watch = (): void => {
        if (!output.includes('READY')) return;
        clearTimeout(timer);
        resolve(true);
      };
      child.stdout?.on('data', watch);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
      watch();
    });
    assert.equal(ready, true);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /صفحة داخل المشروع/);
    assert.equal(html.includes('secret-outside'), false);
    const escaped = await fetch(`http://127.0.0.1:${port}/../secret.txt`);
    assert.equal(escaped.status, 404);
    assert.equal((await escaped.text()).includes('secret-outside'), false);
    const refused = await runPreview(root, ['--file', '../secret.txt', '--port', String(port)]);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.output, /FAIL/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'secret-outside');
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});
