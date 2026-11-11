/**
 * Preview, notebook, tuning, script, and page reads refuse nlink greater
 * than 1 before readFileSync. Outside bytes stay unread. Importing the
 * module must not listen.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/staticPreviewReadHardLink.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const sourceFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'staticPreview.cjs');
const require = createRequire(import.meta.url);

type HandleProcess = NodeJS.Process & { _getActiveHandles?: () => unknown[] };
type Reply = { status: number; body: Buffer };
type HeaderResponse = {
  writeHead: (status: number, headers?: unknown) => void;
  end: (chunk?: string | Buffer) => void;
};

function boundPorts(): number[] {
  const handles = (process as HandleProcess)._getActiveHandles?.() ?? [];
  const ports: number[] = [];
  for (const handle of handles) {
    if (!(handle instanceof net.Server)) continue;
    const address = handle.address();
    if (address && typeof address !== 'string') ports.push(address.port);
  }
  return ports.sort((left, right) => left - right);
}

const portsBeforeImport = boundPorts();
const savedArgv = process.argv.slice();
process.argv = [process.execPath, fileURLToPath(import.meta.url), '--port', '0', '--file', 'app/index.html'];
const loaded = require(sourceFile) as {
  handleRequest: (request: { method: string; url: string; headers: { host: string } }, response: HeaderResponse) => Promise<void>;
  showSavedCell: (id: string, source: string) => boolean;
  saveNotebookCell: (id: string, source: string) => string | null;
};
process.argv = savedArgv;
const portsAfterImport = boundPorts();

const PREVIEW = Buffer.from('<textarea aria-label="cell-1">old</textarea>');
const NOTEBOOK = Buffer.from(`${JSON.stringify({
  nbformat: 4,
  cells: [{ id: 'cell-1', cell_type: 'code', source: 'print(1)\n', outputs: [] }],
}, null, 2)}\n`);
const TUNING = Buffer.from('{"speed":200,"gravity":700}\n');
const SCRIPT = Buffer.from('var speed = 1;\n');
const PAGE = Buffer.from('<!doctype html><meta charset="utf-8"><title>معاينة</title><p>صفحة محلية</p>');
const OUTSIDE = Buffer.from('outside-secret-bytes');

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

async function withProject(name: string, run: (root: string, outside: string) => Promise<void>): Promise<void> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const previous = process.cwd();
  try {
    process.chdir(root);
    await run(root, outside);
  } finally {
    process.chdir(previous);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function plant(root: string, outside: string, parts: string[], bytes: Buffer): { inside: string; outsideFile: string } {
  const outsideFile = path.join(outside, parts.at(-1) ?? '');
  fs.writeFileSync(outsideFile, bytes);
  const inside = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.linkSync(outsideFile, inside);
  const stat = fs.lstatSync(inside);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
  return { inside, outsideFile };
}

function writePlain(root: string, parts: string[], bytes: Buffer): string {
  const file = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
  return file;
}

function stayed(inside: string, outsideFile: string): void {
  assert.deepEqual(fs.readFileSync(inside), OUTSIDE);
  assert.deepEqual(fs.readFileSync(outsideFile), OUTSIDE);
  const stat = fs.lstatSync(inside);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
}

async function assertRefusedUnread(target: string, run: () => unknown): Promise<void> {
  const resolved = path.resolve(target);
  const realRead = fs.readFileSync;
  let used = false;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const filePath = args[0];
    if (typeof filePath !== 'number' && path.resolve(String(filePath)) === resolved) used = true;
    return realRead(...args);
  }) as typeof fs.readFileSync;
  try {
    await assert.rejects(async () => {
      await run();
    }, isUnsafe);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(used, false);
}

async function assertEpermUnread(target: string, skip: number, run: () => unknown): Promise<void> {
  const resolved = path.resolve(target);
  const realRead = fs.readFileSync;
  const realLstat = fs.lstatSync;
  let used = false;
  let seen = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const filePath = args[0];
    if (typeof filePath !== 'number' && path.resolve(String(filePath)) === resolved) used = true;
    return realRead(...args);
  }) as typeof fs.readFileSync;
  Object.defineProperty(fs, 'lstatSync', { value: ((filePath: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(filePath)) === resolved) {
      seen += 1;
      if (seen > skip) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
    }
    return realLstat(filePath, options);
  }) as typeof fs.lstatSync });
  try {
    await assert.rejects(async () => {
      await run();
    }, isEperm);
  } finally {
    fs.readFileSync = realRead;
    Object.defineProperty(fs, 'lstatSync', { value: realLstat });
  }
  assert.equal(used, false);
  assert.equal(seen > skip, true);
}

function openReply(): { response: HeaderResponse; reply: Reply } {
  const reply: Reply = { status: 0, body: Buffer.alloc(0) };
  const response: HeaderResponse = {
    writeHead(status: number) {
      reply.status = status;
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk === 'string') reply.body = Buffer.from(chunk);
      else if (Buffer.isBuffer(chunk)) reply.body = chunk;
    },
  };
  return { response, reply };
}

function ask(method: string, url: string): { method: string; url: string; headers: { host: string } } {
  return { method, url, headers: { host: '127.0.0.1' } };
}

test('importing staticPreview.cjs does not listen', async () => {
  assert.equal(typeof loaded.handleRequest, 'function');
  assert.equal(typeof loaded.showSavedCell, 'function');
  assert.deepEqual(portsAfterImport, portsBeforeImport);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(boundPorts(), portsBeforeImport);
});

test('readFileSync is only reached after the nlink check and the write check stays', () => {
  const source = fs.readFileSync(sourceFile, 'utf8');
  assert.equal(source.split('fs.readFileSync(').length - 1, 1);
  const reader = source.slice(source.indexOf('function readUnshared'), source.indexOf('function rethrowReadFailure'));
  assert.equal(reader.includes('catch'), false);
  assert.equal(reader.indexOf('stat.nlink > 1') < reader.indexOf('fs.readFileSync('), true);
  const guard = source.slice(source.indexOf('function refuseSharedDestination'), source.indexOf('function readUnshared'));
  assert.match(guard, /if \(stat\.nlink > 1\) throw new Error\('unsafe_path'\)/);
  const write = source.slice(source.indexOf('function writeRegular'), source.indexOf('function writeTuningFile'));
  assert.equal(write.indexOf('refuseSharedDestination(file)') < write.indexOf('fs.renameSync(temp, file)'), true);
  assert.match(write, /error\.code === 'EPERM'/);
});

test('a hard-linked preview is refused before read and the outside bytes stay', async () => {
  await withProject('loam-48-preview-read-', async (root, outside) => {
    const linked = plant(root, outside, ['app', 'preview.html'], OUTSIDE);
    await assertRefusedUnread(linked.inside, () => loaded.showSavedCell('cell-1', 'changed-preview'));
    stayed(linked.inside, linked.outsideFile);
  });
});

test('a hard-linked notebook is refused before read and the outside bytes stay', async () => {
  await withProject('loam-48-notebook-read-', async (root, outside) => {
    const linked = plant(root, outside, ['app', 'notebook.ipynb'], OUTSIDE);
    await assertRefusedUnread(linked.inside, () => loaded.saveNotebookCell('cell-1', 'print(2)\n'));
    stayed(linked.inside, linked.outsideFile);
  });
});

test('a hard-linked tuning file is refused before read and the outside bytes stay', async () => {
  await withProject('loam-48-tuning-read-', async (root, outside) => {
    const linked = plant(root, outside, ['app', 'tuning.json'], OUTSIDE);
    const { response, reply } = openReply();
    await assertRefusedUnread(linked.inside, () => loaded.handleRequest(ask('GET', '/tuning.json'), response));
    assert.equal(reply.status, 0);
    assert.equal(reply.body.length, 0);
    stayed(linked.inside, linked.outsideFile);
    assert.deepEqual(boundPorts(), portsBeforeImport);
  });
});

test('a hard-linked script is refused before read and the outside bytes stay', async () => {
  await withProject('loam-48-script-read-', async (root, outside) => {
    const linked = plant(root, outside, ['app', 'game.js'], OUTSIDE);
    const { response, reply } = openReply();
    await assertRefusedUnread(linked.inside, () => loaded.handleRequest(ask('GET', '/game.js'), response));
    assert.equal(reply.status, 0);
    assert.equal(reply.body.length, 0);
    stayed(linked.inside, linked.outsideFile);
  });
});

test('a hard-linked preview page is refused before read and the outside bytes stay', async () => {
  await withProject('loam-48-page-read-', async (root, outside) => {
    const linked = plant(root, outside, ['app', 'index.html'], OUTSIDE);
    const { response, reply } = openReply();
    await assertRefusedUnread(linked.inside, () => loaded.handleRequest(ask('GET', '/'), response));
    assert.equal(reply.status, 0);
    assert.equal(reply.body.length, 0);
    stayed(linked.inside, linked.outsideFile);
  });
});

test('a regular nlink 1 preview, notebook, tuning file, script, and page still read', async () => {
  await withProject('loam-48-nlink1-read-', async (root) => {
    const preview = writePlain(root, ['app', 'preview.html'], PREVIEW);
    const notebook = writePlain(root, ['app', 'notebook.ipynb'], NOTEBOOK);
    const tuning = writePlain(root, ['app', 'tuning.json'], TUNING);
    const script = writePlain(root, ['app', 'game.js'], SCRIPT);
    const page = writePlain(root, ['app', 'index.html'], PAGE);

    const tuningReply = openReply();
    await loaded.handleRequest(ask('GET', '/tuning.json'), tuningReply.response);
    assert.equal(tuningReply.reply.status, 200);
    assert.deepEqual(tuningReply.reply.body, TUNING);

    const scriptReply = openReply();
    await loaded.handleRequest(ask('GET', '/game.js'), scriptReply.response);
    assert.equal(scriptReply.reply.status, 200);
    assert.deepEqual(scriptReply.reply.body, SCRIPT);

    const pageReply = openReply();
    await loaded.handleRequest(ask('GET', '/'), pageReply.response);
    assert.equal(pageReply.reply.status, 200);
    assert.deepEqual(pageReply.reply.body, PAGE);

    assert.equal(loaded.showSavedCell('cell-1', 'next-cell'), true);
    const written = fs.readFileSync(preview, 'utf8');
    assert.match(written, /aria-label="cell-1"/);
    assert.match(written, /next-cell/);
    assert.equal(fs.lstatSync(preview).nlink, 1);

    assert.equal(loaded.saveNotebookCell('cell-1', 'print(2)\n'), 'print(2)\n');
    assert.match(fs.readFileSync(notebook, 'utf8'), /print\(2\)/);
    assert.equal(fs.lstatSync(notebook).nlink, 1);
    assert.deepEqual(fs.readFileSync(tuning), TUNING);
    assert.deepEqual(fs.readFileSync(script), SCRIPT);
    assert.deepEqual(fs.readFileSync(page), PAGE);
    assert.deepEqual(boundPorts(), portsBeforeImport);
  });
});

test('lstat EPERM on the preview, notebook, tuning, script, and page reads is not swallowed', async () => {
  await withProject('loam-48-eperm-read-', async (root) => {
    const preview = writePlain(root, ['app', 'preview.html'], PREVIEW);
    const notebook = writePlain(root, ['app', 'notebook.ipynb'], NOTEBOOK);
    const tuning = writePlain(root, ['app', 'tuning.json'], TUNING);
    const script = writePlain(root, ['app', 'game.js'], SCRIPT);
    const page = writePlain(root, ['app', 'index.html'], PAGE);

    await assertEpermUnread(preview, 1, () => loaded.showSavedCell('cell-1', 'changed-preview'));
    await assertEpermUnread(notebook, 1, () => loaded.saveNotebookCell('cell-1', 'print(2)\n'));
    await assertEpermUnread(tuning, 2, () => {
      const { response } = openReply();
      return loaded.handleRequest(ask('GET', '/tuning.json'), response);
    });
    await assertEpermUnread(script, 1, () => {
      const { response } = openReply();
      return loaded.handleRequest(ask('GET', '/game.js'), response);
    });
    await assertEpermUnread(page, 1, () => {
      const { response } = openReply();
      return loaded.handleRequest(ask('GET', '/'), response);
    });

    assert.deepEqual(fs.readFileSync(preview), PREVIEW);
    assert.deepEqual(fs.readFileSync(notebook), NOTEBOOK);
    assert.deepEqual(fs.readFileSync(tuning), TUNING);
    assert.deepEqual(fs.readFileSync(script), SCRIPT);
    assert.deepEqual(fs.readFileSync(page), PAGE);
    assert.equal(fs.lstatSync(preview).nlink, 1);
    assert.equal(fs.lstatSync(preview).isSymbolicLink(), false);
  });
});
