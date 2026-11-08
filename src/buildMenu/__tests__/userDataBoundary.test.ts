import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { userDataDir } = require('../../templates/electron-app/electron/userData.cjs') as {
  userDataDir: (appDir: string, previewReady: string | undefined) => string;
};

function assertInsideAppDir(appDir: string, result: string): void {
  const root = path.resolve(appDir);
  const rel = path.relative(root, path.resolve(result));
  assert.equal(rel.length > 0, true);
  assert.equal(rel.startsWith('..'), false);
  assert.equal(path.isAbsolute(rel), false);
}

test('user data stays inside the app directory', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-userdata-'));
  try {
    const absoluteReady = path.join(appDir, 'ready');
    assert.equal(path.isAbsolute(absoluteReady), true);
    const preview = userDataDir(appDir, absoluteReady);
    assert.equal(preview, path.join(appDir, '.preview-data'));
    assertInsideAppDir(appDir, preview);

    const relativeReady = path.join('.loam', 'build-menu', 'window-ready');
    assert.equal(path.isAbsolute(relativeReady), false);
    const appData = userDataDir(appDir, relativeReady);
    assert.equal(appData, path.join(appDir, '.app-data'));
    assertInsideAppDir(appDir, appData);

    const outside = path.resolve(appDir, '..', '..', 'outside-userdata');
    assert.equal(path.isAbsolute(outside), true);
    assert.equal(path.relative(appDir, outside).startsWith('..'), true);
    const fromAbsoluteEscape = userDataDir(appDir, outside);
    assert.equal(fromAbsoluteEscape, path.join(appDir, '.preview-data'));
    assertInsideAppDir(appDir, fromAbsoluteEscape);
    assert.equal(path.resolve(fromAbsoluteEscape) === path.resolve(outside), false);

    const relativeEscape = path.join('..', '..', 'outside-userdata');
    assert.equal(path.isAbsolute(relativeEscape), false);
    const fromRelativeEscape = userDataDir(appDir, relativeEscape);
    assert.equal(fromRelativeEscape, path.join(appDir, '.app-data'));
    assertInsideAppDir(appDir, fromRelativeEscape);
    assert.equal(path.resolve(appDir, relativeEscape) === path.resolve(fromRelativeEscape), false);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
