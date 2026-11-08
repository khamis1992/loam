import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { assertRevealCaller, revealArtifactFile } = require('../reveal.cjs') as {
  assertRevealCaller(input: { senderUrl: string; appOrigin: string; sessionToken: string; body: unknown }): { projectId: string; artifactId: string };
  revealArtifactFile(workspace: string, projectId: string, artifactId: string): string;
};

const projectId = 'app_bcdfghjkmnpq';
const artifactId = 'art_01234567-89ab-cdef-0123-456789abcdef';

test('a reveal request rejects a path and a foreign window', () => {
  assert.throws(() => assertRevealCaller({
    senderUrl: 'https://evil.example/app',
    appOrigin: 'http://127.0.0.1:8787',
    sessionToken: 'token-token',
    body: { projectId, artifactId },
  }), /invalid IPC sender/);
  assert.throws(() => assertRevealCaller({
    senderUrl: 'http://127.0.0.1:8787/app',
    appOrigin: 'http://127.0.0.1:8787',
    sessionToken: 'short',
    body: { projectId, artifactId },
  }), /unauthenticated/);
  assert.throws(() => assertRevealCaller({
    senderUrl: 'http://127.0.0.1:8787/app',
    appOrigin: 'http://127.0.0.1:8787',
    sessionToken: 'token-token',
    body: { projectId, artifactId, path: 'C:\\secret.zip' },
  }), /invalid_request/);
  const accepted = assertRevealCaller({
    senderUrl: 'app://agent/build',
    appOrigin: 'app://agent',
    sessionToken: 'token-token',
    body: { projectId, artifactId },
  });
  assert.deepEqual(accepted, { projectId, artifactId });
});

test('reveal resolves only the artifact file inside the project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-reveal-'));
  try {
    const dir = path.join(root, '.loam', 'build-menu', 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${artifactId}.zip`), 'zip-bytes');
    fs.writeFileSync(path.join(dir, `${artifactId}.json`), JSON.stringify({
      artifactId,
      projectId,
      relativePath: `.loam/build-menu/artifacts/${artifactId}.zip`,
    }));
    const revealed = revealArtifactFile(root, projectId, artifactId);
    assert.equal(path.basename(revealed), `${artifactId}.zip`);
    assert.equal(revealed.startsWith(fs.realpathSync(dir)), true);
    fs.writeFileSync(path.join(dir, `${artifactId}.json`), JSON.stringify({
      artifactId,
      projectId,
      relativePath: '../../secret.zip',
    }));
    assert.throws(() => revealArtifactFile(root, projectId, artifactId), /invalid_request/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
