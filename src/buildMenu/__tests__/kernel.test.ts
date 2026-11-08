import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import type { BuildJobContext } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { configureNotebookPin, kernelCommand, kernelStopCommand, readCellSource, resetKernelSessions, resetNotebookPin, runKernelCell } from '../notebooks/kernel.js';
import { createNotebooksPorts } from '../notebooks/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { MAX_KERNEL_LINE } from '../notebooks/messages.js';
import { notebookPage, parseNotebook } from '../notebooks/view.js';

const image = `loam-notebook@sha256:${'a'.repeat(64)}`;

function notebook(root: string, source: string): void {
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'notebook.ipynb'), JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [{ id: 'cell-1', cell_type: 'code', source: [source], outputs: [] }],
  }));
}

test('host python is refused and the cell text stays out of the container arguments', () => {
  assert.throws(() => kernelCommand({
    executable: 'C:\\Python\\python.exe',
    image,
    workspace: 'C:\\work',
    projectId: 'app_abcdefghijkl',
    jobId: 'job_1',
    nonce: '0123456789abcdef',
  }), /missing_requirement/);
  const command = kernelCommand({
    executable: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    image,
    workspace: 'C:\\work\\notebook',
    projectId: 'app_abcdefghijkl',
    jobId: 'job_1',
    nonce: '0123456789abcdef',
  });
  const root = path.resolve('C:\\work\\notebook');
  const volumes = command.args.filter((_arg, index, args) => args[index - 1] === '-v');
  assert.deepEqual(volumes, [
    `${path.resolve(root, 'app', 'data')}:/data:ro`,
    `${path.resolve(root, 'app', 'output')}:/output:rw`,
  ]);
  assert.equal(volumes.some((volume) => volume.startsWith(`${root}:`)), false);
  assert.equal(command.args.includes('docker.sock'), false);
  assert.equal(command.args.includes('--cap-drop'), true);
  assert.equal(command.args.includes('no-new-privileges'), true);
  assert.equal(command.args.includes('1000:1000'), true);
  assert.equal(command.args.includes('none'), true);
  assert.equal(command.args.includes('--network'), true);
  assert.equal(command.args[command.args.indexOf('--pull') + 1], 'never');
  assert.equal(command.args.filter((arg) => arg === 'pull').length, 0);
  assert.equal(command.args.includes('print("loam")'), false);
  assert.equal(command.args.at(-2), '/usr/local/bin/python');
  assert.equal(command.args.at(-1), '/opt/loam/worker.py');
});

test('a data path that is not a directory is not mounted into the kernel', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-file-'));
  notebook(root, 'print(1)\n');
  fs.writeFileSync(path.join(root, 'app', 'data'), 'not-a-dir');
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  let spawned = false;
  const spawnImpl = (() => {
    spawned = true;
    throw new Error('spawned');
  }) as typeof spawn;
  try {
    await assert.rejects(() => runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_1',
      image,
      dockerPath,
      spawnImpl,
    }), (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path');
    assert.equal(spawned, false);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'data'), 'utf8'), 'not-a-dir');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cell runs only through a pinned image, and pip install is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  notebook(root, 'print("loam")\n');
  let spawned = 0;
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-secret';
  const spawnImpl = ((_executable: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    spawned += 1;
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(args.includes('print("loam")\n'), false);
    const volumes = args.filter((_arg, index, all) => all[index - 1] === '-v');
    assert.deepEqual(volumes, [
      `${path.resolve(root, 'app', 'data')}:/data:ro`,
      `${path.resolve(root, 'app', 'output')}:/output:rw`,
    ]);
    const child = new EventEmitter() as ChildProcess;
    const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
    child.stdout = stdout as unknown as ChildProcess['stdout'];
    child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
    child.stdin = {
      write(data: string) {
        const payload = JSON.parse(data) as { type: string; cellId: string; code: string };
        assert.equal(payload.type, 'execute');
        assert.equal(payload.cellId, 'cell-1');
        assert.equal(payload.code, 'print("loam")\n');
        stdout.emit('data', `${JSON.stringify({ type: 'output', cellId: 'cell-1', messageType: 'stream', content: { text: '2\n' } })}\n`);
        process.nextTick(() => child.emit('exit', 0));
        return true;
      },
      end() { return undefined; },
    } as unknown as ChildProcess['stdin'];
    child.kill = () => true;
    return child;
  }) as typeof spawn;
  try {
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_1',
      dockerPath,
      spawnImpl,
    }), /missing_requirement/);
    assert.equal(spawned, 0);
    const result = await runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_1',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      spawnImpl,
    });
    assert.equal(result.text, '2\n');
    assert.equal(spawned, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as {
      cells: { outputs: { text: string[] }[] }[];
    };
    assert.deepEqual(saved.cells[0]?.outputs[0]?.text, ['2\n']);
    notebook(root, 'pip install requests\n');
    assert.throws(
      () => readCellSource(root, 'cell-1'),
      (error: unknown) => error instanceof Error && error.message === 'approval_required',
    );
    assert.equal(spawned, 1);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('kernel lines keep text and png for this cell and a timeout stays interrupted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-parse-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  notebook(root, 'print(3)\n');
  const html = '<script>alert(1)</script>';
  const stdout = [
    JSON.stringify({ type: 'output', messageType: 'stream', content: { text: 'unstamped-output' } }),
    JSON.stringify({ type: 'error', error: 'unstamped-error' }),
    JSON.stringify({ type: 'complete' }),
    JSON.stringify({ type: 'output', cellId: 'other', messageType: 'display_data', content: { data: { 'text/html': html } } }),
    JSON.stringify({ type: 'output', cellId: 'cell-1', messageType: 'display_data', content: { data: { 'text/html': html, 'text/plain': '3', 'image/png': 'iVBORw0KGgo=' } } }),
    JSON.stringify({ type: 'complete', cellId: 'cell-1' }),
  ].join('\n');
  try {
    const result = await runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_1',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      spawnImpl: fakeSpawn(stdout, 0),
    });
    assert.equal(result.text, '3');
    const saved = fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8');
    assert.equal(saved.includes(html), false);
    assert.equal(saved.includes('unstamped-output'), false);
    assert.equal(saved.includes('unstamped-error'), false);
    assert.equal(saved.includes('print(3)'), true);
    const page = notebookPage(parseNotebook(saved));
    assert.equal(page.includes('<script'), false);
    assert.match(page, /data:image\/png;base64,iVBORw0KGgo=/);
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_1',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      spawnImpl: fakeSpawn('x'.repeat(MAX_KERNEL_LINE + 1), 0),
    }), /tool_failed/);
    const interrupted = JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as {
      cells: { source: string[]; outputs: { ename?: string }[] }[];
    };
    assert.equal(interrupted.cells[0]?.outputs[0]?.ename, 'interrupted');
    assert.deepEqual(interrupted.cells[0]?.source, ['print(3)\n']);
    let killed = 0;
    const stops: string[][] = [];
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_1',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      timeoutMs: 30,
      spawnImpl: ((() => {
        const child = new EventEmitter() as ChildProcess;
        const stdoutEmitter = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
        child.stdout = stdoutEmitter as unknown as ChildProcess['stdout'];
        child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
        child.stdin = { write() { return true; }, end() { return undefined; } } as unknown as ChildProcess['stdin'];
        child.kill = () => { killed += 1; return true; };
        return child;
      }) as typeof spawn),
      stopImpl: ((...args: Parameters<typeof spawn>) => {
        stops.push([...(args[1] ?? [])]);
        const child = new EventEmitter() as ChildProcess;
        child.unref = () => child;
        return child;
      }) as typeof spawn,
    }), /tool_failed/);
    assert.equal(killed, 1);
    assert.deepEqual(stops, [['stop', 'loamk0123456789abcdef']]);
    const afterTimeout = JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as {
      cells: { source: string[]; outputs: { ename?: string }[] }[];
    };
    assert.equal(afterTimeout.cells[0]?.outputs[0]?.ename, 'interrupted');
    assert.deepEqual(afterTimeout.cells[0]?.source, ['print(3)\n']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling a kernel stops only that named container', async () => {
  const stop = kernelStopCommand('C:\\Program Files\\Docker\\docker.exe', '0123456789abcdef');
  assert.deepEqual(stop.args, ['stop', 'loamk0123456789abcdef']);
  assert.equal(stop.args.includes('prune'), false);
  assert.throws(() => kernelStopCommand('C:\\Python\\python.exe', '0123456789abcdef'), /missing_requirement/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-cancel-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  notebook(root, 'print(1)\n');
  const original = JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as { cells: unknown[] };
  original.cells.push({ id: 'cell-2', cell_type: 'code', source: ['print(2)\n'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['2\n'] }] });
  fs.writeFileSync(path.join(root, 'app', 'notebook.ipynb'), JSON.stringify(original));
  const stops: string[][] = [];
  const controller = new AbortController();
  const pending = runKernelCell({
    workspace: root,
    cellId: 'cell-1',
    projectId: 'app_abcdefghijkl',
    jobId: 'job_1',
    image,
    dockerPath,
    nonce: '0123456789abcdef',
    timeoutMs: 5_000,
    signal: controller.signal,
    spawnImpl: (() => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
      child.stdout = stdout as unknown as ChildProcess['stdout'];
      child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
      child.stdin = { write() { return true; }, end() { return undefined; } } as unknown as ChildProcess['stdin'];
      child.kill = () => true;
      return child;
    }) as typeof spawn,
    stopImpl: ((...args: Parameters<typeof spawn>) => {
      stops.push([...(args[1] ?? [])]);
      const child = new EventEmitter() as ChildProcess;
      child.unref = () => child;
      return child;
    }) as typeof spawn,
  });
  controller.abort();
  try {
    await assert.rejects(pending, (error: unknown) => error instanceof BuildMenuError && error.message === 'cancelled');
    assert.deepEqual(stops, [['stop', 'loamk0123456789abcdef']]);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as {
      cells: { id?: string; source: string[]; outputs: { ename?: string; output_type?: string; text?: string[] }[] }[];
    };
    assert.equal(saved.cells[0]?.outputs[0]?.ename, 'interrupted');
    assert.deepEqual(saved.cells[0]?.source, ['print(1)\n']);
    assert.equal(saved.cells[1]?.id, 'cell-2');
    assert.deepEqual(saved.cells[1]?.source, ['print(2)\n']);
    assert.equal(saved.cells[1]?.outputs[0]?.output_type, 'stream');
    assert.deepEqual(saved.cells[1]?.outputs[0]?.text, ['2\n']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cell over 200000 bytes is refused before the container starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-size-'));
  const worker = fs.readFileSync(path.resolve('src/buildMenu/notebooks/python/worker.py'), 'utf8');
  assert.equal(worker.includes('cell_too_large'), true);
  assert.equal(worker.includes('failed["cellId"] = current_cell'), true);
  assert.equal(worker.includes('/output'), true);
  assert.equal(worker.includes('pip install'), false);
  let spawned = false;
  try {
    notebook(root, 'a'.repeat(200_000));
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_1',
      image,
      dockerPath: path.join(root, 'missing-docker.exe'),
      spawnImpl: (() => {
        spawned = true;
        throw new Error('spawned');
      }) as typeof spawn,
    }), /missing_requirement/);
    notebook(root, `${'a'.repeat(200_000)}\n`);
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_1',
      image,
      spawnImpl: (() => {
        spawned = true;
        throw new Error('spawned');
      }) as typeof spawn,
    }), (error: unknown) => error instanceof BuildMenuError && error.message === 'cell_too_large');
    assert.equal(spawned, false);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'), 'utf8')) as {
      cells: { source: string[] }[];
    };
    const text = saved.cells[0]?.source.join('') ?? '';
    assert.equal(text.length, 200_001);
    assert.equal(text.endsWith('\n'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second cell reuses the same kernel container', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-reuse-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'notebook.ipynb'), JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [
      { id: 'cell-1', cell_type: 'code', source: ['x = 2\n'], outputs: [] },
      { id: 'cell-2', cell_type: 'code', source: ['print(x + 1)\n'], outputs: [] },
    ],
  }));
  let spawned = 0;
  const writes: string[] = [];
  const child = new EventEmitter() as ChildProcess;
  const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
  child.stdout = stdout as unknown as ChildProcess['stdout'];
  child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
  child.stdin = {
    write(data: string) {
      writes.push(data);
      const payload = JSON.parse(data) as { type?: string; code?: string; cellId?: string };
      if (payload.type === 'execute' && payload.cellId === 'cell-1') {
        stdout.emit('data', `${JSON.stringify({ type: 'complete', cellId: 'cell-1' })}\n`);
      }
      if (payload.type === 'execute' && payload.cellId === 'cell-2') {
        stdout.emit('data', `${JSON.stringify({ type: 'output', cellId: 'cell-2', messageType: 'stream', content: { text: '3\n' } })}\n`);
        stdout.emit('data', `${JSON.stringify({ type: 'complete', cellId: 'cell-2' })}\n`);
      }
      return true;
    },
    end() { return undefined; },
  } as unknown as ChildProcess['stdin'];
  child.kill = () => true;
  const spawnImpl = (() => {
    spawned += 1;
    return child;
  }) as typeof spawn;
  try {
    const first = await runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_1',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      spawnImpl,
      stopImpl: (() => new EventEmitter() as ChildProcess) as typeof spawn,
    });
    const second = await runKernelCell({
      workspace: root,
      cellId: 'cell-2',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_2',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      spawnImpl,
    });
    assert.equal(first.text, '');
    assert.equal(second.text, '3\n');
    assert.equal(spawned, 1);
    assert.equal(writes.length, 2);
    assert.equal(writes.some((line) => line.includes('print(x + 1)')), true);
  } finally {
    resetKernelSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fakeSpawn(stdoutText: string, code: number): typeof spawn {
  return ((_executable: string, _args: readonly string[]) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
    child.stdout = stdout as unknown as ChildProcess['stdout'];
    child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
    let sent = false;
    const finish = (): void => {
      if (sent) return;
      sent = true;
      stdout.emit('data', stdoutText);
      process.nextTick(() => child.emit('exit', code));
    };
    child.stdin = {
      write() { finish(); return true; },
      end() { finish(); },
    } as unknown as ChildProcess['stdin'];
    child.kill = () => true;
    return child;
  }) as typeof spawn;
}

test('closing the notebook stops its idle kernel and leaves the saved file', async () => {
  resetKernelSessions();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-close-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-other-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  notebook(root, 'print(1)\n');
  notebook(other, 'print(2)\n');
  const stops: string[][] = [];
  const firstWrites: string[] = [];
  const secondWrites: string[] = [];
  const stopImpl = ((...args: Parameters<typeof spawn>) => {
    stops.push([...(args[1] ?? [])]);
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    return child;
  }) as typeof spawn;
  const idle = (writes: string[], cellId: string) => (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
    child.stdout = stdout as unknown as ChildProcess['stdout'];
    child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
    child.stdin = {
      write(chunk: string) {
        writes.push(String(chunk));
        if (!String(chunk).includes('shutdown')) process.nextTick(() => stdout.emit('data', `{"type":"complete","cellId":"${cellId}"}\n`));
        return true;
      },
      end() { return undefined; },
    } as unknown as ChildProcess['stdin'];
    child.kill = () => true;
    return child;
  }) as typeof spawn;
  try {
    await runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_close',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      spawnImpl: idle(firstWrites, 'cell-1'),
      stopImpl,
    });
    await runKernelCell({
      workspace: other,
      cellId: 'cell-1',
      projectId: 'app_bbcdefghijkl',
      jobId: 'job_other',
      image,
      dockerPath,
      nonce: 'fedcba9876543210',
      spawnImpl: idle(secondWrites, 'cell-1'),
      stopImpl,
    });
    const kept = fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'));
    const otherKept = fs.readFileSync(path.join(other, 'app', 'notebook.ipynb'));
    const ctx: BuildJobContext = {
      workspace: root,
      jobId: 'job_preview',
      operation: { action: 'preview' },
      signal: new AbortController().signal,
      manifest: {
        schemaVersion: 1,
        projectId: 'app_abcdefghijkl',
        revision: 1,
        selection: { kind: 'notebook' },
        title: 'دفتر',
        sourceDir: 'app',
        template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
        consent: { autostart: false, publish: false },
      },
    };
    await createNotebooksPorts({ leases: new ProcessLeaseRegistry(200) }).stop(ctx);
    assert.deepEqual(stops, [['stop', 'loamk0123456789abcdef']]);
    assert.equal(firstWrites.some((line) => line.includes('"type":"shutdown"')), true);
    assert.equal(secondWrites.some((line) => line.includes('shutdown')), false);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb')).equals(kept), true);
    assert.equal(fs.readFileSync(path.join(other, 'app', 'notebook.ipynb')).equals(otherKept), true);
  } finally {
    resetKernelSessions();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('a second cell is refused while the first is still running', async () => {
  resetKernelSessions();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-busy-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  fs.mkdirSync(path.join(root, 'app'));
  const file = path.join(root, 'app', 'notebook.ipynb');
  fs.writeFileSync(file, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [
      { id: 'cell-1', cell_type: 'code', source: ['x = 2\n'], outputs: [] },
      { id: 'cell-2', cell_type: 'code', source: ['print(x + 1)\n'], outputs: [] },
    ],
  }));
  const before = fs.readFileSync(file);
  let spawned = 0;
  const writes: string[] = [];
  let release: (() => void) | undefined;
  const child = new EventEmitter() as ChildProcess;
  const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
  child.stdout = stdout as unknown as ChildProcess['stdout'];
  child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
  child.stdin = {
    write(data: string) {
      writes.push(data);
      const payload = JSON.parse(data) as { type?: string; cellId?: string };
      if (payload.type === 'execute' && payload.cellId === 'cell-1') {
        release = () => stdout.emit('data', `${JSON.stringify({ type: 'complete', cellId: 'cell-1' })}\n`);
      }
      if (payload.type === 'execute' && payload.cellId === 'cell-2') {
        stdout.emit('data', `${JSON.stringify({ type: 'output', cellId: 'cell-2', messageType: 'stream', content: { text: '3\n' } })}\n`);
        stdout.emit('data', `${JSON.stringify({ type: 'complete', cellId: 'cell-2' })}\n`);
      }
      return true;
    },
    end() { return undefined; },
  } as unknown as ChildProcess['stdin'];
  child.kill = () => true;
  const spawnImpl = (() => {
    spawned += 1;
    return child;
  }) as typeof spawn;
  const shared = { workspace: root, image, dockerPath, nonce: '0123456789abcdef', spawnImpl, projectId: 'app_abcdefghijkl' };
  try {
    const first = runKernelCell({ ...shared, cellId: 'cell-1', jobId: 'job_1', stopImpl: (() => new EventEmitter() as ChildProcess) as typeof spawn });
    for (let attempt = 0; attempt < 20 && spawned === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(
      runKernelCell({ ...shared, cellId: 'cell-2', jobId: 'job_2' }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'busy' && error.status === 409,
    );
    assert.equal(spawned, 1);
    assert.equal(writes.length, 1);
    assert.equal(fs.readFileSync(file).equals(before), true);
    release?.();
    assert.equal((await first).text, '');
    const second = await runKernelCell({ ...shared, cellId: 'cell-2', jobId: 'job_2' });
    assert.equal(second.text, '3\n');
    assert.equal(spawned, 1);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: Array<{ source: string[] }> };
    assert.deepEqual(saved.cells[0]?.source, ['x = 2\n']);
    assert.deepEqual(saved.cells[1]?.source, ['print(x + 1)\n']);
  } finally {
    resetKernelSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing pinned image is refused before the container starts and nothing is pulled', async () => {
  resetKernelSessions();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-image-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  notebook(root, 'print(1)\n');
  const file = path.join(root, 'app', 'notebook.ipynb');
  const before = fs.readFileSync(file);
  const calls: string[][] = [];
  let ran = false;
  const inspectImpl = ((_executable: string, args: readonly string[]) => {
    calls.push([...args]);
    const child = new EventEmitter() as ChildProcess;
    const missing = !calls.some((command) => command.includes('pull'));
    process.nextTick(() => child.emit('exit', missing && calls.length === 1 ? 1 : 0));
    return child;
  }) as typeof spawn;
  const spawnImpl = ((_executable: string, args: readonly string[]) => {
    ran = true;
    assert.equal(args[0], 'run');
    assert.equal(args.includes('pull'), false);
    const child = new EventEmitter() as ChildProcess;
    const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
    child.stdout = stdout as unknown as ChildProcess['stdout'];
    child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
    child.stdin = {
      write(data: string) {
        const payload = JSON.parse(data) as { type?: string; cellId?: string };
        if (payload.type === 'execute' && payload.cellId === 'cell-1') {
          stdout.emit('data', `${JSON.stringify({ type: 'complete', cellId: 'cell-1' })}\n`);
        }
        return true;
      },
      end() { return undefined; },
    } as unknown as ChildProcess['stdin'];
    child.kill = () => true;
    return child;
  }) as typeof spawn;
  try {
    await assert.rejects(runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_missing',
      image,
      dockerPath,
      inspectImpl,
      spawnImpl,
    }), (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400);
    assert.equal(ran, false);
    assert.deepEqual(calls, [['image', 'inspect', '--format', '{{.Id}}', image]]);
    assert.equal(fs.readFileSync(file).equals(before), true);
    const present = ((_executable: string, args: readonly string[]) => {
      calls.push([...args]);
      const child = new EventEmitter() as ChildProcess;
      process.nextTick(() => child.emit('exit', 0));
      return child;
    }) as typeof spawn;
    const result = await runKernelCell({
      workspace: root,
      cellId: 'cell-1',
      projectId: 'app_abcdefghijkl',
      jobId: 'job_present',
      image,
      dockerPath,
      nonce: '0123456789abcdef',
      inspectImpl: present,
      spawnImpl,
    });
    assert.equal(result.text, '');
    assert.equal(ran, true);
    assert.equal(calls.some((command) => command.includes('pull')), false);
    assert.deepEqual(calls[1], ['image', 'inspect', '--format', '{{.Id}}', image]);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: { source: string[] }[] };
    assert.deepEqual(saved.cells[0]?.source, ['print(1)\n']);
  } finally {
    resetKernelSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an environment image is refused until its digest is approved', async () => {
  resetKernelSessions();
  resetNotebookPin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-pin-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  notebook(root, 'print(1)\n');
  const file = path.join(root, 'app', 'notebook.ipynb');
  const before = fs.readFileSync(file);
  const pin = JSON.parse(fs.readFileSync(new URL('../notebooks/python/image-pin.json', import.meta.url), 'utf8')) as { status: string; digest: string | null };
  assert.equal(pin.status, 'unresolved');
  assert.equal(pin.digest, null);
  assert.equal(JSON.stringify(pin).includes('latest'), false);
  const previous = process.env.LOAM_NOTEBOOK_IMAGE;
  process.env.LOAM_NOTEBOOK_IMAGE = image;
  const calls: string[][] = [];
  let ran = false;
  const inspectImpl = ((_executable: string, args: readonly string[]) => {
    calls.push([...args]);
    const child = new EventEmitter() as ChildProcess;
    process.nextTick(() => child.emit('exit', calls.length === 1 ? 1 : 0));
    return child;
  }) as typeof spawn;
  const spawnImpl = ((_executable: string, args: readonly string[]) => {
    ran = true;
    assert.equal(args[0], 'run');
    assert.equal(args.includes('pull'), false);
    const child = new EventEmitter() as ChildProcess;
    const stdout = Object.assign(new EventEmitter(), { setEncoding() { return undefined; } });
    child.stdout = stdout as unknown as ChildProcess['stdout'];
    child.stderr = { resume() { return undefined; } } as unknown as ChildProcess['stderr'];
    child.stdin = {
      write(data: string) {
        const payload = JSON.parse(data) as { type?: string };
        if (payload.type === 'execute') stdout.emit('data', `${JSON.stringify({ type: 'complete', cellId: 'cell-1' })}\n`);
        return true;
      },
      end() { return undefined; },
    } as unknown as ChildProcess['stdin'];
    child.kill = () => true;
    return child;
  }) as typeof spawn;
  const shared = { workspace: root, cellId: 'cell-1', projectId: 'app_abcdefghijkl', jobId: 'job_pin', dockerPath, inspectImpl, spawnImpl };
  try {
    await assert.rejects(runKernelCell(shared), (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement');
    assert.equal(ran, false);
    assert.equal(calls.length, 0);
    assert.equal(fs.readFileSync(file).equals(before), true);
    configureNotebookPin(`loam-notebook@sha256:${'b'.repeat(64)}`);
    await assert.rejects(runKernelCell(shared), (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement');
    assert.equal(calls.length, 0);
    configureNotebookPin(image);
    await assert.rejects(runKernelCell(shared), (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement');
    assert.equal(ran, false);
    assert.deepEqual(calls, [['image', 'inspect', '--format', '{{.Id}}', image]]);
    const result = await runKernelCell({ ...shared, jobId: 'job_pin_ready' });
    assert.equal(result.text, '');
    assert.equal(ran, true);
    assert.equal(calls.some((command) => command.includes('pull')), false);
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: { source: string[] }[] };
    assert.deepEqual(kept.cells[0]?.source, ['print(1)\n']);
  } finally {
    resetNotebookPin();
    resetKernelSessions();
    if (previous === undefined) delete process.env.LOAM_NOTEBOOK_IMAGE;
    else process.env.LOAM_NOTEBOOK_IMAGE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package install spellings are refused before a container starts', async () => {
  resetKernelSessions();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-pip-'));
  const dockerPath = path.join(root, 'docker.exe');
  fs.writeFileSync(dockerPath, '');
  let spawned = 0;
  const spawnImpl = (() => {
    spawned += 1;
    throw new Error('spawned');
  }) as typeof spawn;
  const blocked = [
    'pip3 install requests\n',
    'pip.exe install requests\n',
    '%pip install requests\n',
    'python -m pip install requests\n',
    'py -m pip install requests\n',
    'conda install numpy\n',
    'uv add requests\n',
    "pip.main(['install', 'requests'])\n",
    "get_ipython().run_line_magic('pip', 'install requests')\n",
    "subprocess.check_call(['pip', 'install', 'requests'])\n",
  ];
  try {
    for (const source of blocked) {
      notebook(root, source);
      const before = fs.readFileSync(path.join(root, 'app', 'notebook.ipynb'));
      await assert.rejects(runKernelCell({
        workspace: root,
        cellId: 'cell-1',
        projectId: 'app_abcdefghijkl',
        jobId: 'job_pip',
        image,
        dockerPath,
        spawnImpl,
      }), (error: unknown) => error instanceof BuildMenuError && error.message === 'approval_required' && error.status === 403);
      assert.equal(fs.readFileSync(path.join(root, 'app', 'notebook.ipynb')).equals(before), true);
    }
    notebook(root, 'import math\n');
    assert.equal(readCellSource(root, 'cell-1'), 'import math\n');
    notebook(root, 'print("pipeline")\n');
    assert.equal(readCellSource(root, 'cell-1'), 'print("pipeline")\n');
    assert.equal(spawned, 0);
  } finally {
    resetKernelSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
