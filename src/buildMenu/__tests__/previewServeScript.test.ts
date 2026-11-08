import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'staticPreview.cjs');

function get(port: number, pathname: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: { connection: string; host?: string } = { connection: 'close' };
    if (host) headers.host = host;
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

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

test('the static preview refuses a javascript URL in the page and in a local script', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-preview-serve-'));
  fs.mkdirSync(path.join(root, 'app'));
  const page = path.join(root, 'app', 'preview.html');
  fs.writeFileSync(page, '<textarea>javascript:alert(1) https://example.test</textarea><p>صفحة محلية</p>');
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
    assert.equal(ready, true, output);
    const clean = await get(port, '/');
    assert.equal(clean.status, 200);
    assert.match(clean.body, /صفحة محلية/);
    const hostile = await get(port, '/', 'evil.example');
    assert.equal(hostile.status, 403);
    assert.equal(hostile.body.includes('evil.example'), false);
    const lookalike = await get(port, '/', '127.0.0.1.evil.example');
    assert.equal(lookalike.status, 403);
    const localHost = await get(port, '/', `localhost:${port}`);
    assert.equal(localHost.status, 200);
    assert.match(clean.body, /javascript:alert\(1\)/);
    fs.appendFileSync(page, '<script src="//evil.example/a.js"></script>');
    const remote = await get(port, '/');
    assert.equal(remote.status, 400);
    assert.equal(remote.body.includes('evil.example'), false);
    fs.writeFileSync(page, '<textarea>javascript:alert(1) https://example.test</textarea><p>صفحة محلية</p>');
    fs.appendFileSync(page, '<a href="javascript:void(0)">x</a>');
    const poisoned = await get(port, '/');
    assert.equal(poisoned.status, 400);
    assert.equal(poisoned.body.includes('javascript:'), false);
    assert.equal(fs.readFileSync(page, 'utf8').includes('javascript:'), true);
    const scriptFile = path.join(root, 'app', 'page.js');
    fs.writeFileSync(scriptFile, 'location.href="javascript:void(0)"\n');
    const remoteScript = await get(port, '/page.js');
    assert.equal(remoteScript.status, 400);
    fs.writeFileSync(scriptFile, "fetch('//evil.example/a.js')\n");
    const relativeScript = await get(port, '/page.js');
    assert.equal(relativeScript.status, 400);
    assert.equal(relativeScript.body.includes('evil.example'), false);
    assert.match(fs.readFileSync(scriptFile, 'utf8'), /evil\.example/);
    fs.writeFileSync(scriptFile, 'console.log(1)\n');
    const localScript = await get(port, '/page.js');
    assert.equal(localScript.status, 200);
    assert.match(localScript.body, /console\.log\(1\)/);
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
    fs.rmSync(root, { recursive: true, force: true });
  }
});
