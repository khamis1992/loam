import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractZip } from '../../preview/zip.js';
import { BuildMenuError } from '../grants.js';
import { artifactHeaders, assertRealInside, readProjectBytes, resolveArtifact, sourceEntries, writeAtomicFile, writeSourceArtifact } from '../artifacts.js';

test('a source snapshot stays inside the project directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-real-'));
  const app = path.join(root, 'app');
  const nested = path.join(app, 'pages');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'home.txt'), 'داخل');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'خارج');
  try {
    assertRealInside(app, path.join(nested, 'home.txt'));
    assert.throws(() => assertRealInside(app, path.join(root, 'secret.txt')), /unsafe_path/);
    assert.deepEqual(sourceEntries(app).map((entry) => entry.name), ['pages/home.txt']);
    assert.equal(sourceEntries(app)[0]?.data.toString('utf8'), 'داخل');
    assert.equal(readProjectBytes(root, 'pages/home.txt').toString('utf8'), 'داخل');
    assert.throws(() => readProjectBytes(root, '../secret.txt'), (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path');
    assert.throws(() => readProjectBytes(root, 'C:/secret.txt'), (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path');
    assert.equal(fs.existsSync(path.join(root, 'secret.txt')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source zip skips the generated app data directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, '.preview-data'), { recursive: true });
  fs.writeFileSync(path.join(app, '.preview-data', 'note'), 'local');
  fs.mkdirSync(path.join(app, '.app-data', 'Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(app, '.app-data', 'Local Storage', 'note'), 'local');
  fs.writeFileSync(path.join(app, 'index.html'), '<p>محلي</p>');
  try {
    assert.deepEqual(sourceEntries(app).map((entry) => entry.name), ['index.html']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source zip skips chrome instructions and the catch-up lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'popup.js'), 'local');
  fs.writeFileSync(path.join(app, 'unpacked.txt'), `المجلد: ${app}\n`);
  fs.writeFileSync(path.join(app, 'catchup.lock'), 'busy');
  fs.writeFileSync(path.join(app, 'runs.jsonl'), '{"outcome":"local-report"}\n');
  try {
    const entries = sourceEntries(app);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['popup.js', 'runs.jsonl']);
    const bundled = entries.map((entry) => entry.data.toString('utf8')).join('\n');
    assert.equal(bundled.includes(app), false);
    assert.equal(bundled.includes('catchup.lock'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an artifact write refuses a temp path that is not a file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-artifact-'));
  const target = path.join(root, 'art.bin');
  const temp = `${target}.tmp`;
  try {
    fs.mkdirSync(temp);
    assert.throws(
      () => writeAtomicFile(target, Buffer.from('ok')),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.statSync(temp).isDirectory(), true);
    assert.equal(fs.existsSync(target), false);
    fs.rmSync(temp, { recursive: true });
    fs.writeFileSync(temp, 'stale');
    writeAtomicFile(target, Buffer.from('ok'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'ok');
    assert.equal(fs.existsSync(temp), false);
    fs.rmSync(target);
    fs.mkdirSync(target);
    assert.throws(
      () => writeAtomicFile(target, Buffer.from('no')),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path',
    );
    assert.equal(fs.statSync(target).isDirectory(), true);
    assert.equal(fs.readdirSync(target).length, 0);
    const app = path.join(root, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'index.html'), '<p>محلي</p>');
    const artifact = writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip');
    const loaded = resolveArtifact(root, 'app_abcdefghijkl', artifact.artifactId);
    assert.equal(loaded.artifact.sha256, artifact.sha256);
    assert.equal(loaded.bytes.length, artifact.bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source zip skips env files and rejects a symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'index.html'), '<p>محلي</p>');
  fs.writeFileSync(path.join(app, '.env'), 'SECRET=1');
  const entries = sourceEntries(app);
  assert.deepEqual(entries.map((entry) => entry.name), ['index.html']);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(app, 'linked'), 'junction');
  assert.throws(() => sourceEntries(app), /unsafe_path/);
  fs.rmSync(path.join(app, 'linked'), { recursive: true, force: true });
  const artifact = writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip');
  assert.equal(artifact.relativePath.startsWith('.loam/build-menu/artifacts/'), true);
  assert.equal(fs.existsSync(path.join(root, artifact.relativePath)), true);
  assert.equal(path.resolve(root, artifact.relativePath).includes(`${path.sep}app${path.sep}`), false);
  const again = writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip');
  assert.equal(artifact.revision, 1);
  assert.equal(again.revision, 1);
  assert.notEqual(artifact.artifactId, again.artifactId);
  const loaded = resolveArtifact(root, 'app_abcdefghijkl', artifact.artifactId);
  assert.equal(loaded.artifact.sha256, artifact.sha256);
  const headers = artifactHeaders(artifact.artifactId, loaded.bytes.length);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['content-disposition'], `attachment; filename="${artifact.artifactId}.zip"`);
  assert.throws(
    () => resolveArtifact(root, 'app_zzzzzzzzzzzz', artifact.artifactId),
    (error: unknown) => error instanceof BuildMenuError && error.status === 404,
  );
  assert.throws(
    () => resolveArtifact(root, 'app_abcdefghijkl', '../secret'),
    (error: unknown) => error instanceof BuildMenuError && error.status === 400,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('source zip keeps the local report and leaves the mail draft on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-mail-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'routine.json'), '{"send":false}\n');
  fs.writeFileSync(path.join(app, 'report.txt'), 'تقرير محلي\n');
  fs.writeFileSync(path.join(app, 'proposed.json'), '{"recipient":"user@example.com","body":"secret-body"}\n');
  try {
    const entries = sourceEntries(app);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['report.txt', 'routine.json']);
    const bundled = entries.map((entry) => entry.data.toString('utf8')).join('\n');
    assert.equal(bundled.includes('secret-body'), false);
    assert.equal(bundled.includes('user@example.com'), false);
    assert.match(fs.readFileSync(path.join(app, 'proposed.json'), 'utf8'), /secret-body/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a closed source snapshot keeps its bytes after a later edit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-closed-'));
  const app = path.join(root, 'app');
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-build-unpack-'));
  fs.mkdirSync(path.join(app, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(app, '.loam'), { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<p>قبل</p>');
  fs.writeFileSync(path.join(app, 'page.js'), 'const local = true;\n');
  fs.writeFileSync(path.join(app, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(app, 'node_modules', 'left.js'), 'skip');
  fs.writeFileSync(path.join(app, '.loam', 'secret.txt'), 'skip');
  try {
    const artifact = writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip');
    fs.writeFileSync(path.join(app, 'index.html'), '<p>بعد</p>');
    const loaded = resolveArtifact(root, 'app_abcdefghijkl', artifact.artifactId);
    assert.equal(loaded.artifact.revision, 1);
    assert.equal(loaded.artifact.sha256, artifact.sha256);
    assert.equal(createHash('sha256').update(loaded.bytes).digest('hex'), artifact.sha256);
    const names = extractZip(loaded.bytes, unpacked);
    assert.equal(names.every((name) => !name.startsWith('/') && !name.startsWith('../') && !/^[A-Za-z]:/.test(name)), true);
    assert.deepEqual(names.sort(), ['index.html', 'page.js']);
    assert.equal(fs.readFileSync(path.join(unpacked, 'index.html'), 'utf8'), '<p>قبل</p>');
    assert.equal(fs.existsSync(path.join(unpacked, '.env')), false);
    assert.equal(fs.readFileSync(path.join(app, 'index.html'), 'utf8'), '<p>بعد</p>');
    const again = writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip');
    assert.notEqual(again.artifactId, artifact.artifactId);
    assert.equal(resolveArtifact(root, 'app_abcdefghijkl', artifact.artifactId).bytes.equals(loaded.bytes), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
});
