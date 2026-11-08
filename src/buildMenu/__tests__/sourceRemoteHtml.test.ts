import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { sourceEntries } from '../artifacts.js';
import { materialize } from '../materialize.js';
import { createGamesPorts } from '../games/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';

test('a source archive keeps a local script and refuses a remote one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-source-html-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  const page = path.join(app, 'index.html');
  try {
    fs.writeFileSync(page, '<script type="module" src="./app.ts"></script>');
    fs.writeFileSync(path.join(app, 'app.ts'), 'export const local = 1;\n');
    assert.deepEqual(sourceEntries(app).map((entry) => entry.name).sort(), ['app.ts', 'index.html']);
    fs.writeFileSync(page, '<script src="//evil.example/a.js"></script>');
    assert.throws(() => sourceEntries(app), (error: unknown) => error instanceof Error && error.message === 'unsafe_path');
    assert.match(fs.readFileSync(page, 'utf8'), /evil\.example/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a game source zip keeps the previous archive when the page gains a remote script', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-source-html-'));
  const ports = createGamesPorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'game' }, workspace: root, title: 'لعبة' });
    const first = await ports.export(context(root), 'source-zip');
    const zipPath = path.join(root, first.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const page = path.join(root, 'app', 'index.html');
    fs.appendFileSync(page, '<script src="https://evil.example/a.js"></script>');
    await assert.rejects(
      ports.export(context(root), 'source-zip'),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    assert.match(fs.readFileSync(page, 'utf8'), /evil\.example/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'game' };
  return {
    workspace,
    jobId: 'job_game_source_html',
    operation: { action: 'package', format: 'source-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'لعبة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}
