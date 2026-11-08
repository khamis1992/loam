import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialize } from '../materialize.js';
import { assertFrozenElectronTemplate, desktopPreviewLaunch } from '../desktop/templateLock.js';
import { findElectron } from '../toolchain.js';
import { BuildMenuError } from '../grants.js';

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-lock-'));
  materialize({ selection: { kind: 'desktop' }, workspace: root, title: 'مكتب' });
  return root;
}

test('a generated desktop project matches the frozen electron template', () => {
  const root = workspace();
  try {
    assertFrozenElectronTemplate(root);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'app', 'desktop-app.json'), 'utf8')) as { title?: string };
    config.title = 'عنوان معدّل';
    fs.writeFileSync(path.join(root, 'app', 'desktop-app.json'), `${JSON.stringify(config)}\n`);
    assertFrozenElectronTemplate(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a changed main, preload, or package is refused before launch', () => {
  const root = workspace();
  try {
    const main = path.join(root, 'app', 'electron', 'main.cjs');
    const original = fs.readFileSync(main);
    fs.writeFileSync(main, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(() => assertFrozenElectronTemplate(root), (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request');
    fs.writeFileSync(main, original);
    const preload = path.join(root, 'app', 'electron', 'preload.cjs');
    const preloadBytes = fs.readFileSync(preload);
    fs.writeFileSync(preload, 'module.exports = { node: true };\n');
    assert.throws(() => assertFrozenElectronTemplate(root), (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request');
    fs.writeFileSync(preload, preloadBytes);
    const geometry = path.join(root, 'app', 'electron', 'widget-geometry.cjs');
    const geometryBytes = fs.readFileSync(geometry);
    fs.writeFileSync(geometry, `${geometryBytes.toString('utf8')}\n// tamper\n`);
    assert.throws(() => assertFrozenElectronTemplate(root), (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request');
    fs.writeFileSync(geometry, geometryBytes);
    const navigation = path.join(root, 'app', 'electron', 'navigation.cjs');
    const navigationBytes = fs.readFileSync(navigation);
    fs.writeFileSync(navigation, `${navigationBytes.toString('utf8')}\n// tamper\n`);
    assert.throws(() => assertFrozenElectronTemplate(root), (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request');
    fs.writeFileSync(navigation, navigationBytes);
    const userData = path.join(root, 'app', 'electron', 'userData.cjs');
    const userDataBytes = fs.readFileSync(userData);
    fs.writeFileSync(userData, `${userDataBytes.toString('utf8')}\n// tamper\n`);
    assert.throws(() => assertFrozenElectronTemplate(root), (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request');
    fs.writeFileSync(userData, userDataBytes);
    fs.rmSync(path.join(root, 'app', 'package.json'));
    assert.throws(() => assertFrozenElectronTemplate(root), (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preview launches only the generated electron main inside the project', () => {
  const electron = findElectron();
  if (!electron) assert.fail('electron-absent');
  const root = workspace();
  try {
    const launch = desktopPreviewLaunch(root, electron);
    assert.equal(launch.executable, path.resolve(electron));
    assert.equal(launch.cwd, path.resolve(root, 'app'));
    assert.equal(launch.script, path.resolve(root, 'app', 'electron', 'main.cjs'));
    assert.throws(
      () => desktopPreviewLaunch(root, process.execPath),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a desktop main that is not a regular file is refused', () => {
  const root = workspace();
  const main = path.join(root, 'app', 'electron', 'main.cjs');
  try {
    fs.rmSync(main);
    fs.mkdirSync(main);
    assert.throws(() => assertFrozenElectronTemplate(root), (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
