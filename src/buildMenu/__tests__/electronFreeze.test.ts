import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFrozenElectronTemplate, FROZEN_ELECTRON_FILES } from '../desktop/templateLock.js';
import { BuildMenuError } from '../grants.js';

const TEMPLATE_ROOT = fileURLToPath(new URL('../../templates/electron-app/', import.meta.url));

function withFrozenCopy(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-freeze-'));
  try {
    for (const relative of FROZEN_ELECTRON_FILES) {
      const from = path.join(TEMPLATE_ROOT, ...relative.split('/'));
      const to = path.join(root, 'app', ...relative.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'invalid_request';
}

function copiedFile(root: string, relative: string): string {
  return path.join(root, 'app', ...relative.split('/'));
}

test('copied electron files that match the template are accepted', () => {
  withFrozenCopy((root) => {
    assertFrozenElectronTemplate(root);
  });
});

test('a copied electron main that differs from the template is refused', () => {
  withFrozenCopy((root) => {
    const file = copiedFile(root, 'electron/main.cjs');
    const original = fs.readFileSync(file);
    assertFrozenElectronTemplate(root);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(() => assertFrozenElectronTemplate(root), refused);
    fs.writeFileSync(file, original);
    assertFrozenElectronTemplate(root);
  });
});

test('a copied widget geometry that differs from the template is refused', () => {
  withFrozenCopy((root) => {
    const file = copiedFile(root, 'electron/widget-geometry.cjs');
    const original = fs.readFileSync(file);
    assertFrozenElectronTemplate(root);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(() => assertFrozenElectronTemplate(root), refused);
    fs.writeFileSync(file, original);
    assertFrozenElectronTemplate(root);
  });
});
