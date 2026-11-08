import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialize, readPreview } from '../materialize.js';

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

test('an existing generated file with nlink greater than 1 is refused before write', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-materialize-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-materialize-out-'));
  const destination = path.join(workspace, 'app', 'desktop-app.json');
  const outsideFile = path.join(outside, 'desktop-app.json');
  const previous = Buffer.from('{"title":"OUTSIDE"}\n');
  try {
    fs.mkdirSync(path.join(workspace, 'app'));
    fs.writeFileSync(outsideFile, previous);
    fs.linkSync(outsideFile, destination);
    const stat = fs.lstatSync(destination);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.throws(
      () => materialize({ selection: { kind: 'desktop' }, workspace, title: 'مكتب' }),
      unsafePath,
    );
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(destination), previous);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(destination).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a normal new file still writes', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-materialize-new-'));
  try {
    const file = path.join(workspace, 'app', 'desktop-app.json');
    assert.equal(fs.existsSync(file), false);
    materialize({ selection: { kind: 'desktop' }, workspace, title: 'مكتب' });
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    const written = fs.readFileSync(file, 'utf8');
    assert.equal(written.includes('مكتب'), true);
    assert.equal(written.includes('https://'), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('remote scheme refusal still throws unsafe_path', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-materialize-scheme-'));
  try {
    const dir = path.join(workspace, 'app');
    fs.mkdirSync(dir);
    const htmlPath = path.join(dir, 'preview.html');
    const scriptPath = path.join(dir, 'preview.js');
    const html = '<a href="https://evil.example/a">x</a><script src="./preview.js"></script>';
    const script = 'local\n';
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(scriptPath, script);
    assert.throws(() => readPreview(workspace, 'app/preview.html'), unsafePath);
    assert.equal(fs.readFileSync(htmlPath, 'utf8'), html);
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), script);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
