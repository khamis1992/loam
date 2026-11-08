import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const preloadUrl = new URL('../../templates/electron-app/electron/preload.cjs', import.meta.url);

test('the electron-app template preload does not require fs or child_process', () => {
  const preloadPath = fileURLToPath(preloadUrl).replaceAll('\\', '/');
  assert.equal(preloadPath.endsWith('src/templates/electron-app/electron/preload.cjs'), true);
  const source = fs.readFileSync(preloadUrl, 'utf8');
  assert.equal(/require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/.test(source), false);
  assert.equal(/require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/.test(source), false);
  assert.equal(/\bfrom\s+['"](?:node:)?fs(?:\/promises)?['"]/.test(source), false);
  assert.equal(/\bfrom\s+['"](?:node:)?child_process['"]/.test(source), false);
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('node:fs'), false);
});
