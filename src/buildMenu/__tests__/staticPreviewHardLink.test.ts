/**
 * Preview, notebook, and tuning replaces refuse a destination whose nlink is
 * greater than 1 before rename. Importing the module must not listen.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/staticPreviewHardLink.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'staticPreview.cjs');
const require = createRequire(import.meta.url);

type HandleProcess = NodeJS.Process & { _getActiveHandles?: () => unknown[] };

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
const loaded = require(script) as {
  remoteMarkup: unknown;
  showSavedCell: (id: string, source: string) => boolean;
  saveNotebookCell: (id: string, source: string) => string | null;
  writeTuningFile: (tuning: { speed: number; gravity: number }) => boolean;
};
const portsAfterImport = boundPorts();

const PREVIEW = Buffer.from('<textarea aria-label="cell-1">old</textarea>');
const NOTEBOOK = Buffer.from(`${JSON.stringify({
  nbformat: 4,
  cells: [{ id: 'cell-1', cell_type: 'code', source: 'print(1)\n', outputs: [] }],
}, null, 2)}\n`);
const TUNING = Buffer.from('{"speed":200,"gravity":700}\n');

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function denied(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'EPERM');
}

function withProject(name: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const previous = process.cwd();
  try {
    process.chdir(root);
    run(root);
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function plantLink(root: string, parts: string[], bytes: Buffer): { inside: string; outside: string; outsideRoot: string } {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-preview-out-'));
  const outside = path.join(outsideRoot, 'outside-bytes.txt');
  fs.writeFileSync(outside, bytes);
  const inside = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.linkSync(outside, inside);
  return { inside, outside, outsideRoot };
}

function assertLinked(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
}

function assertPlain(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

test('importing staticPreview.cjs does not listen', async () => {
  assert.equal(typeof loaded.remoteMarkup, 'function');
  assert.deepEqual(portsAfterImport, portsBeforeImport);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(boundPorts(), portsBeforeImport);
});

test('a hard-linked preview is refused before rename and the outside bytes stay', () => {
  const outsideRoots: string[] = [];
  try {
    withProject('loam-45-preview-link-', (root) => {
      const linked = plantLink(root, ['app', 'preview.html'], PREVIEW);
      outsideRoots.push(linked.outsideRoot);
      assertLinked(linked.inside);
      assert.throws(() => loaded.showSavedCell('cell-1', 'changed-preview'), unsafePath);
      assert.deepEqual(fs.readFileSync(linked.outside), PREVIEW);
      assert.deepEqual(fs.readFileSync(linked.inside), PREVIEW);
      assert.equal(fs.existsSync(`${linked.inside}.tmp`), false);
      assertLinked(linked.inside);
    });
  } finally {
    for (const dir of outsideRoots) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hard-linked notebook is refused before rename and the outside bytes stay', () => {
  const outsideRoots: string[] = [];
  try {
    withProject('loam-45-preview-notebook-', (root) => {
      const linked = plantLink(root, ['app', 'notebook.ipynb'], NOTEBOOK);
      outsideRoots.push(linked.outsideRoot);
      assertLinked(linked.inside);
      assert.throws(() => loaded.saveNotebookCell('cell-1', 'print(2)\n'), unsafePath);
      assert.deepEqual(fs.readFileSync(linked.outside), NOTEBOOK);
      assert.deepEqual(fs.readFileSync(linked.inside), NOTEBOOK);
      assert.equal(fs.existsSync(`${linked.inside}.tmp`), false);
      assertLinked(linked.inside);
    });
  } finally {
    for (const dir of outsideRoots) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hard-linked tuning file is refused before rename and the outside bytes stay', () => {
  const outsideRoots: string[] = [];
  try {
    withProject('loam-45-preview-tuning-', (root) => {
      const linked = plantLink(root, ['app', 'tuning.json'], TUNING);
      outsideRoots.push(linked.outsideRoot);
      assertLinked(linked.inside);
      assert.throws(() => loaded.writeTuningFile({ speed: 240, gravity: 900 }), unsafePath);
      assert.deepEqual(fs.readFileSync(linked.outside), TUNING);
      assert.deepEqual(fs.readFileSync(linked.inside), TUNING);
      assert.equal(fs.existsSync(`${linked.inside}.tmp`), false);
      assertLinked(linked.inside);
    });
  } finally {
    for (const dir of outsideRoots) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a normal new preview file still writes', () => {
  withProject('loam-45-preview-plain-', (root) => {
    const preview = path.join(root, 'app', 'preview.html');
    const notebook = path.join(root, 'app', 'notebook.ipynb');
    const tuning = path.join(root, 'app', 'tuning.json');
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, PREVIEW);
    fs.writeFileSync(notebook, NOTEBOOK);
    fs.writeFileSync(tuning, TUNING);
    assertPlain(preview);

    assert.equal(loaded.showSavedCell('cell-1', 'next-cell'), true);
    const written = fs.readFileSync(preview);
    assert.match(written.toString('utf8'), /next-cell/);
    assertPlain(preview);
    assert.equal(fs.existsSync(`${preview}.tmp`), false);

    const stored = loaded.saveNotebookCell('cell-1', 'print(2)\n');
    assert.equal(stored, 'print(2)\n');
    assert.match(fs.readFileSync(notebook, 'utf8'), /print\(2\)/);
    assertPlain(notebook);

    assert.equal(loaded.writeTuningFile({ speed: 240, gravity: 900 }), true);
    assert.equal(fs.readFileSync(tuning, 'utf8'), '{"speed":240,"gravity":900}\n');
    assertPlain(tuning);
    assert.deepEqual(fs.readFileSync(preview), written);
  });
});

test('EPERM from the preview, notebook, and tuning writers is not swallowed', () => {
  withProject('loam-45-preview-eperm-', (root) => {
    const preview = path.join(root, 'app', 'preview.html');
    const notebook = path.join(root, 'app', 'notebook.ipynb');
    const tuning = path.join(root, 'app', 'tuning.json');
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, PREVIEW);
    fs.writeFileSync(notebook, NOTEBOOK);
    fs.writeFileSync(tuning, TUNING);
    const blocked = new Set([preview, notebook, tuning].map((file) => path.resolve(file)));
    const realLstat = fs.lstatSync;
    const patched = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (blocked.has(path.resolve(String(target)))) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstat(target, options);
    }) as typeof fs.lstatSync;
    Object.defineProperty(fs, 'lstatSync', { value: patched });
    try {
      assert.throws(() => loaded.showSavedCell('cell-1', 'changed-preview'), denied);
      assert.throws(() => loaded.saveNotebookCell('cell-1', 'print(2)\n'), denied);
      assert.throws(() => loaded.writeTuningFile({ speed: 240, gravity: 900 }), denied);
      assert.deepEqual(fs.readFileSync(preview), PREVIEW);
      assert.deepEqual(fs.readFileSync(notebook), NOTEBOOK);
      assert.deepEqual(fs.readFileSync(tuning), TUNING);
      assert.equal(fs.existsSync(`${preview}.tmp`), false);
      assert.equal(fs.existsSync(`${notebook}.tmp`), false);
      assert.equal(fs.existsSync(`${tuning}.tmp`), false);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstat });
    }
  });
});
