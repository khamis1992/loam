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

function post(port: number, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/notebook-cell',
      method: 'POST',
      headers: {
        connection: 'close',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the notebook preview saves a local cell and refuses an install command', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-notebook-save-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'preview.html'), '<p>دفتر</p>');
  const file = path.join(root, 'app', 'notebook.ipynb');
  const book = {
    nbformat: 4,
    cells: [{ id: 'cell-1', cell_type: 'code', source: ['print(1)'], outputs: [], metadata: {} }],
  };
  fs.writeFileSync(file, `${JSON.stringify(book)}\n`);
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
    const saved = await post(port, new URLSearchParams({ id: 'cell-1', source: 'print("pipeline")\nprint("pip", "install")' }).toString());
    assert.equal(saved.status, 303);
    assert.match(fs.readFileSync(file, 'utf8'), /pipeline/);
    const before = fs.readFileSync(file);
    const refused = await post(port, new URLSearchParams({
      id: 'cell-1',
      source: "subprocess.check_call(['pip', 'install', 'requests'])",
    }).toString());
    assert.equal(refused.status, 400);
    assert.equal(refused.body.includes('requests'), false);
    assert.equal(refused.body.includes('pip install'), false);
    assert.equal(fs.readFileSync(file).equals(before), true);
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
